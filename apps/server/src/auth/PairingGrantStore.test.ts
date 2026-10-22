import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS,
  currentDesktopBootstrapToken,
} from "@t3tools/shared/desktopBootstrapToken";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
const layerServerConfig = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-auth-bootstrap-test-",
      }),
    ),
  );
const layerPairingGrantStore = (
  overrides?: Partial<
    Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken" | "desktopBootstrapSecret">
  >,
) =>
  PairingGrantStore.layer.pipe(
    Layer.provide(SqlitePersistence.layerMemory),
    Layer.provide(layerServerConfig(overrides)),
  );
const layerPairingGrantStoreWithSql = PairingGrantStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerServerConfig()),
);
it.layer(NodeServices.layer)("PairingGrantStore.layer", (it) => {
  it.effect("issues one-time bootstrap tokens that can only be consumed once", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        label: "Julius iPhone",
      });
      const first = yield* bootstrapCredentials.consume(issued.credential);
      const second = yield* Effect.flip(bootstrapCredentials.consume(issued.credential));
      expect(first.method).toBe("one-time-token");
      expect(first.scopes).toEqual(AuthStandardClientScopes);
      expect(first.subject).toBe("one-time-token");
      expect(first.label).toBe("Julius iPhone");
      expect(issued.label).toBe("Julius iPhone");
      expect(second._tag).toBe("UnknownBootstrapCredentialError");
      expect(second.message).toContain("Unknown bootstrap credential");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );
  it.effect("atomically consumes a one-time token when multiple requests race", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken();
      const results = yield* Effect.all(
        Array.from(
          {
            length: 8,
          },
          () =>
            Effect.result(
              bootstrapCredentials.consume(token.credential, {
                requestedScopes: ["orchestration:read"],
              }),
            ),
        ),
        {
          concurrency: "unbounded",
        },
      );
      const successes = results.filter((result) => result._tag === "Success");
      const failures = results.filter((result) => result._tag === "Failure");
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(7);
      for (const failure of failures) {
        expect(failure.failure._tag).toBe("UnknownBootstrapCredentialError");
        expect(failure.failure.message).toContain("Unknown bootstrap credential");
      }
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );
  it.effect("requires the bound proof key thumbprint when present", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const token = yield* bootstrapCredentials.issueOneTimeToken({
        proofKeyThumbprint: "client-proof-key-thumbprint",
        scopes: ["orchestration:read"],
      });
      const missing = yield* Effect.flip(bootstrapCredentials.consume(token.credential));
      const wrong = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "other-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const forbiddenScope = yield* Effect.flip(
        bootstrapCredentials.consume(token.credential, {
          proofKeyThumbprint: "client-proof-key-thumbprint",
          requestedScopes: ["access:write"],
        }),
      );
      const consumed = yield* bootstrapCredentials.consume(token.credential, {
        proofKeyThumbprint: "client-proof-key-thumbprint",
        requestedScopes: ["orchestration:read"],
      });
      expect(missing.message).toContain("proof key mismatch");
      expect(wrong.message).toContain("proof key mismatch");
      expect(forbiddenScope._tag).toBe("BootstrapCredentialScopeNotGrantedError");
      expect(consumed.proofKeyThumbprint).toBe("client-proof-key-thumbprint");
    }).pipe(Effect.provide(layerPairingGrantStore())),
  );
  it.effect("reports seeded desktop bootstrap credentials as expired after their ttl", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      yield* TestClock.adjust(Duration.hours(12));
      const stillValid = yield* bootstrapCredentials.consume("desktop-bootstrap-token");
      expect(stillValid.method).toBe("desktop-bootstrap");
      yield* TestClock.adjust(Duration.hours(13));
      const expired = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));
      expect(expired._tag).toBe("ExpiredBootstrapCredentialError");
      expect(expired.message).toContain("Bootstrap credential expired");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );
  it.effect("accepts rotating desktop bootstrap tokens derived from the desktop secret", () =>
    Effect.gen(function* () {
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const window = DESKTOP_BOOTSTRAP_TOKEN_WINDOW_MS;
      yield* TestClock.adjust(Duration.days(5));
      const now = 5 * 24 * 60 * 60 * 1000;
      const current = yield* bootstrapCredentials.consume(
        currentDesktopBootstrapToken("desktop-secret", now),
      );
      expect(current.method).toBe("desktop-bootstrap");
      const stale = yield* Effect.flip(
        bootstrapCredentials.consume(
          currentDesktopBootstrapToken("desktop-secret", now - 2 * window),
        ),
      );
      expect(stale._tag).toBe("UnknownBootstrapCredentialError");
      const launch = yield* Effect.flip(bootstrapCredentials.consume("desktop-bootstrap-token"));
      expect(launch._tag).toBe("UnknownBootstrapCredentialError");
    }).pipe(
      Effect.provide(
        Layer.merge(
          layerPairingGrantStore({
            desktopBootstrapToken: "desktop-bootstrap-token",
            desktopBootstrapSecret: "desktop-secret",
          }),
          TestClock.layer(),
        ),
      ),
    ),
  );
  it.effect("keeps credentials out of pairing lists and change events", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({
          startImmediately: true,
        }),
      );
      for (const input of [
        {},
        {
          label: "Synthetic phone",
        },
      ]) {
        const issued = yield* grants.issueOneTimeToken(input);
        const change = yield* Queue.take(changes);
        expect(change?.type).toBe("pairingLinkUpserted");
        if (change?.type !== "pairingLinkUpserted")
          throw new Error("Expected a pairing link update");
        expect(change.pairingLink.id).toBe(issued.id);
        expect(change.pairingLink).not.toHaveProperty("credential");
        const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
        expect(listed).toEqual(change.pairingLink);
        const consumed = yield* grants.consume(issued.credential);
        expect(consumed.scopes).toEqual(change.pairingLink.scopes);
        expect(yield* Queue.take(changes)).toEqual({
          type: "pairingLinkRemoved",
          id: issued.id,
        });
      }
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStore())),
  );
  it.effect("redeems fleet enrollments repeatedly while storing only their digest", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const sql = yield* SqlClient.SqlClient;
      const changes = yield* Queue.unbounded<PairingGrantStore.BootstrapCredentialChange>();
      yield* grants.streamChanges.pipe(
        Stream.runForEach((change) => Queue.offer(changes, change)),
        Effect.forkScoped({
          startImmediately: true,
        }),
      );
      const issued = yield* grants.issueFleetEnrollment({
        ttl: Duration.days(365),
        label: "phones",
      });
      const credential = Redacted.value(issued.credential);
      const rows = yield* sql<{
        readonly credential: string;
        readonly method: string;
      }>`
        SELECT credential, method FROM auth_pairing_links WHERE id = ${issued.id}
      `;
      expect(credential).toMatch(/^t3enroll1\.[A-Za-z0-9_-]{43}$/);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.method).toBe("fleet-enrollment");
      expect(rows[0]?.credential).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(rows[0]?.credential).not.toContain(credential.slice("t3enroll1.".length));
      const first = yield* grants.consume(credential);
      const second = yield* grants.consume(credential, {
        requestedScopes: ["orchestration:read"],
      });
      for (const grant of [first, second]) {
        expect(grant).toMatchObject({
          method: "fleet-enrollment",
          scopes: AuthStandardClientScopes,
          subject: `fleet-enrollment:${issued.id}`,
        });
        expect(grant).not.toHaveProperty("label");
      }
      const digest = yield* Effect.flip(grants.consume(rows[0]!.credential));
      const malformed = yield* Effect.flip(grants.consume(`${credential}x`));
      expect(digest._tag).toBe("UnknownBootstrapCredentialError");
      expect(malformed._tag).toBe("UnknownBootstrapCredentialError");
      const listed = (yield* grants.listActive()).find((link) => link.id === issued.id);
      expect(listed).toMatchObject({
        label: "phones",
        subject: `fleet-enrollment:${issued.id}`,
      });
      expect(listed).not.toHaveProperty("credential");
      expect(yield* Queue.take(changes)).toMatchObject({
        type: "pairingLinkUpserted",
        pairingLink: {
          id: issued.id,
        },
      });
      expect(yield* Queue.size(changes)).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layerPairingGrantStoreWithSql)),
  );
  it.effect("stops redeeming fleet enrollments that are revoked, expired, or out of scope", () =>
    Effect.gen(function* () {
      const grants = yield* PairingGrantStore.PairingGrantStore;
      const readOnly = yield* grants.issueFleetEnrollment({
        ttl: Duration.hours(1),
        label: "read-only",
        scopes: ["orchestration:read"],
      });
      const revoked = yield* grants.issueFleetEnrollment({
        ttl: Duration.hours(1),
        label: "revoked",
      });
      const outOfScope = yield* Effect.flip(
        grants.consume(Redacted.value(readOnly.credential), {
          requestedScopes: ["access:write"],
        }),
      );
      expect(outOfScope._tag).toBe("BootstrapCredentialScopeNotGrantedError");
      expect(yield* grants.revoke(revoked.id)).toBe(true);
      const afterRevoke = yield* Effect.flip(grants.consume(Redacted.value(revoked.credential)));
      expect(afterRevoke._tag).toBe("UnavailableBootstrapCredentialError");
      yield* TestClock.adjust(Duration.hours(2));
      const expired = yield* Effect.flip(grants.consume(Redacted.value(readOnly.credential)));
      expect(expired._tag).toBe("ExpiredBootstrapCredentialError");
    }).pipe(Effect.provide(Layer.merge(layerPairingGrantStore(), TestClock.layer()))),
  );
});
