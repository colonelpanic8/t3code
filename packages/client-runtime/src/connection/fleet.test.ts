import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerFleetEnvironment,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import {
  fleetMembersJoinedThrough,
  orphanedFleetMembers,
  planFleetSync,
  prepareFleetMemberRegistration,
} from "./fleet.ts";
import { BearerConnectionTarget, fleetConnectionId } from "./model.ts";
import {
  connectionRouteKind,
  connectionRoutes,
  isManagedConnectionEntry,
  mergeLearnedRoutes,
} from "./routes.ts";

const A = EnvironmentId.make("fleet:a");
const B = EnvironmentId.make("fleet:b");
const C = EnvironmentId.make("fleet:c");

const member = (environmentId: EnvironmentId, host = environmentId.slice(6)) =>
  ({
    environmentId,
    label: host,
    httpBaseUrl: `https://${host}.example.ts.net/`,
    wsBaseUrl: `wss://${host}.example.ts.net/`,
  }) satisfies ServerFleetEnvironment;

function pairedEntry(environmentId: EnvironmentId): ConnectionCatalogEntry {
  const connectionId = `bearer:${environmentId}:https://${environmentId.slice(6)}.example.ts.net`;
  return connectionRegistrationCatalogEntry(
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({ environmentId, label: environmentId, connectionId }),
      profile: new BearerConnectionProfile({
        connectionId,
        environmentId,
        label: environmentId,
        httpBaseUrl: `https://${environmentId.slice(6)}.example.ts.net/`,
        wsBaseUrl: `wss://${environmentId.slice(6)}.example.ts.net/`,
      }),
      credential: new BearerConnectionCredential({ token: "paired" }),
    }),
  );
}

function joinedEntry(
  declared: ServerFleetEnvironment,
  root: EnvironmentId,
): ConnectionCatalogEntry {
  const connectionId = fleetConnectionId(declared.environmentId, root);
  return connectionRegistrationCatalogEntry(
    new BearerConnectionRegistration({
      target: new BearerConnectionTarget({
        environmentId: declared.environmentId,
        label: declared.label,
        connectionId,
      }),
      profile: new BearerConnectionProfile({ connectionId, ...declared }),
      credential: new BearerConnectionCredential({ token: "joined" }),
    }),
  );
}

const catalog = (...entries: ReadonlyArray<ConnectionCatalogEntry>) =>
  new Map(entries.map((entry) => [entry.target.environmentId, entry] as const));

describe("fleet sync plan", () => {
  it("joins the unsaved members of the paired machine's fleet through it", () => {
    const plan = planFleetSync({
      entries: catalog(pairedEntry(A)),
      source: A,
      fleet: [member(A), member(B), member(C)],
    });

    expect(plan).toEqual({ root: A, join: [member(B), member(C)], update: [], remove: [] });
  });

  it("ignores a server that does not list itself", () => {
    expect(
      planFleetSync({ entries: catalog(pairedEntry(A)), source: A, fleet: [member(B)] }),
    ).toBeNull();
  });

  it("follows the fleet from any member, rooted where the client joined", () => {
    const entries = catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A));
    const plan = planFleetSync({
      entries,
      source: B,
      fleet: [member(A), { ...member(B), label: "renamed" }],
    });

    expect(plan).toEqual({
      root: A,
      join: [],
      update: [{ ...member(B), label: "renamed" }],
      remove: [C],
    });
  });

  it("never changes environments the user saved or another fleet joined", () => {
    const other = EnvironmentId.make("fleet:other-root");
    const plan = planFleetSync({
      entries: catalog(
        pairedEntry(A),
        pairedEntry(B),
        pairedEntry(other),
        joinedEntry(member(C), other),
      ),
      source: A,
      fleet: [member(A), { ...member(B), label: "renamed" }],
    });

    expect(plan).toEqual({ root: A, join: [], update: [], remove: [] });
  });

  it("takes a fleet off the device with the machine it joined through", () => {
    const joined = catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A));
    const afterRemovingRoot = catalog(joinedEntry(member(B), A), joinedEntry(member(C), A));

    expect(fleetMembersJoinedThrough(joined, A)).toEqual([B, C]);
    expect(orphanedFleetMembers(joined)).toEqual([]);
    expect(orphanedFleetMembers(afterRemovingRoot)).toEqual([B, C]);
  });
});

describe("fleet members", () => {
  it("is managed, reached over Tailscale, and not learned twice at its served address", () => {
    const entry = joinedEntry(member(B), A);

    expect(isManagedConnectionEntry(entry)).toBe(true);
    expect(isManagedConnectionEntry(pairedEntry(A))).toBe(false);
    expect(connectionRouteKind(connectionRoutes(entry)[0]!)).toBe("tailnet");
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: connectionRoutes(entry)[0]!,
        reported: [{ httpBaseUrl: "https://b.example.ts.net/" }],
        allowInsecure: true,
      }),
    ).toBeNull();
  });
});

const layerClientPresentation = Layer.succeed(
  ClientCapabilities.ClientPresentation,
  ClientCapabilities.ClientPresentation.of({ metadata: { label: "Pixel", deviceType: "mobile" } }),
);

function layerMemberHttp(answeringAs: EnvironmentId, calls: Array<string>) {
  return RpcHttp.layerRemoteHttpClient(((input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/.well-known/t3/environment")) {
      return Promise.resolve(
        Response.json({
          environmentId: answeringAs,
          label: answeringAs,
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          capabilities: { repositoryIdentity: true },
        }),
      );
    }
    if (url.endsWith("/oauth/token")) {
      return Promise.resolve(
        Response.json({
          access_token: "member-session",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "orchestration:read",
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected request: ${url}`));
  }) satisfies typeof fetch);
}

describe("joining a fleet member", () => {
  it.effect("pairs through a handoff and saves the member as managed", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const handoffs: Array<EnvironmentId> = [];
      const registration = yield* prepareFleetMemberRegistration({
        member: member(B),
        root: A,
        issueHandoff: (environmentId) =>
          Effect.sync(() => {
            handoffs.push(environmentId);
            return { credential: "t3fleet1.handoff", expiresAt: DateTime.makeUnsafe(0) };
          }),
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerMemberHttp(B, calls))));

      expect(handoffs).toEqual([B]);
      expect(calls).toEqual([
        "https://b.example.ts.net/.well-known/t3/environment",
        "https://b.example.ts.net/oauth/token",
      ]);
      expect(registration.target.connectionId).toBe(fleetConnectionId(B, A));
      expect(registration.profile).toMatchObject(member(B));
      expect(registration.credential.token).toBe("member-session");
      expect(isManagedConnectionEntry(connectionRegistrationCatalogEntry(registration))).toBe(true);
    }),
  );

  it.effect("spends no handoff on an address that answers as another machine", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      let handoffs = 0;
      const error = yield* prepareFleetMemberRegistration({
        member: member(B),
        root: A,
        issueHandoff: () =>
          Effect.sync(() => {
            handoffs += 1;
            return { credential: "t3fleet1.handoff", expiresAt: DateTime.makeUnsafe(0) };
          }),
      }).pipe(
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerMemberHttp(C, calls))),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(handoffs).toBe(0);
      expect(calls).toEqual(["https://b.example.ts.net/.well-known/t3/environment"]);
    }),
  );
});
