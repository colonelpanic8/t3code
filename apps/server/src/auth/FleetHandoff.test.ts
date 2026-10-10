import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as FleetManifest from "../environment/FleetManifest.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as FleetHandoff from "./FleetHandoff.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const FLEET_A = EnvironmentId.make("fleet:a");
const FLEET_B = EnvironmentId.make("fleet:b");
const MANIFEST = JSON.stringify({
  version: 1,
  environments: [FLEET_A, FLEET_B].map((environmentId) => ({
    environmentId,
    label: environmentId.slice("fleet:".length),
    httpBaseUrl: `https://${environmentId.slice("fleet:".length)}.example.ts.net/`,
    wsBaseUrl: `wss://${environmentId.slice("fleet:".length)}.example.ts.net/`,
  })),
});

/** One fleet member with its own state directory, as a separate host would have. */
const buildMember = Effect.fn(function* (input: {
  readonly environmentId: EnvironmentId;
  readonly managedAccessToken?: string;
  readonly manifest?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-fleet-handoff-" });
  const manifestPath = `${directory}/fleet.json`;
  if (input.manifest !== undefined) {
    yield* fileSystem.writeFileString(manifestPath, input.manifest);
  }
  const layerConfig = Layer.effect(
    ServerConfig.ServerConfig,
    ServerConfig.ServerConfig.pipe(
      Effect.map((config) => ({
        ...config,
        environmentIdOverride: input.environmentId,
        managedAccessToken: input.managedAccessToken,
        fleetManifestPath: manifestPath,
      })),
    ),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), `${directory}/home`)));
  const context = yield* Layer.build(
    FleetHandoff.layer.pipe(
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(layerConfig),
    ),
  );
  return {
    handoff: Context.get(context, FleetHandoff.FleetHandoff),
    manifest: Context.get(context, FleetManifest.FleetManifest),
  };
});

const member = (environmentId: EnvironmentId) =>
  buildMember({ environmentId, managedAccessToken: "shared-fleet-token", manifest: MANIFEST });

it.layer(NodeServices.layer)("FleetHandoff", (it) => {
  it.effect("hands the caller's grant to the audience exactly once", () =>
    Effect.gen(function* () {
      const a = yield* member(FLEET_A);
      const b = yield* member(FLEET_B);

      const issued = yield* a.handoff.issue({
        audience: FLEET_B,
        scopes: ["orchestration:read", "terminal:operate", "review:write"],
      });
      const redeemed = yield* b.handoff.redeem(issued.credential);
      const replayed = yield* Effect.flip(b.handoff.redeem(issued.credential));

      expect(redeemed).toEqual({
        issuer: FLEET_A,
        scopes: ["orchestration:read", "terminal:operate"],
      });
      expect(replayed).toMatchObject({ _tag: "FleetHandoffInvalidError", reason: "replayed" });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a handoff meant for another environment", () =>
    Effect.gen(function* () {
      const a = yield* member(FLEET_A);
      const b = yield* member(FLEET_B);

      const issued = yield* a.handoff.issue({ audience: FLEET_A, scopes: ["orchestration:read"] });
      const error = yield* Effect.flip(b.handoff.redeem(issued.credential));

      expect(error).toMatchObject({ reason: "audience" });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a handoff after it expires", () =>
    Effect.gen(function* () {
      const a = yield* member(FLEET_A);
      const b = yield* member(FLEET_B);

      const issued = yield* a.handoff.issue({ audience: FLEET_B, scopes: ["orchestration:read"] });
      yield* TestClock.adjust("5 minutes");
      const error = yield* Effect.flip(b.handoff.redeem(issued.credential));

      expect(error).toMatchObject({ reason: "expired" });
    }).pipe(Effect.scoped),
  );

  it.effect("rejects handoffs signed with another secret or altered in transit", () =>
    Effect.gen(function* () {
      const outsider = yield* buildMember({
        environmentId: FLEET_A,
        managedAccessToken: "another-fleet-token",
        manifest: MANIFEST,
      });
      const a = yield* member(FLEET_A);
      const b = yield* member(FLEET_B);

      const forged = yield* outsider.handoff.issue({
        audience: FLEET_B,
        scopes: ["orchestration:read"],
      });
      const genuine = yield* a.handoff.issue({ audience: FLEET_B, scopes: ["orchestration:read"] });
      const [prefix, , signature] = genuine.credential.split(".");
      const widened = `${prefix}.${Buffer.from(
        JSON.stringify({ aud: FLEET_B, scopes: ["access:write"] }),
      ).toString("base64url")}.${signature}`;

      expect(yield* Effect.flip(b.handoff.redeem(forged.credential))).toMatchObject({
        reason: "signature",
      });
      expect(yield* Effect.flip(b.handoff.redeem(widened))).toMatchObject({
        reason: "signature",
      });
      expect(yield* Effect.flip(b.handoff.redeem("t3fleet1.garbage"))).toMatchObject({
        reason: "malformed",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("only issues handoffs to declared members of a configured fleet", () =>
    Effect.gen(function* () {
      const a = yield* member(FLEET_A);
      const withoutToken = yield* buildMember({ environmentId: FLEET_A, manifest: MANIFEST });
      const withoutManifest = yield* buildMember({
        environmentId: FLEET_A,
        managedAccessToken: "shared-fleet-token",
      });

      expect(
        yield* Effect.flip(
          a.handoff.issue({
            audience: EnvironmentId.make("fleet:stranger"),
            scopes: ["orchestration:read"],
          }),
        ),
      ).toMatchObject({ reason: "not-a-member" });
      for (const unconfigured of [withoutToken, withoutManifest]) {
        expect(yield* unconfigured.manifest.read).toEqual(Option.none());
        expect(
          yield* Effect.flip(
            unconfigured.handoff.issue({ audience: FLEET_B, scopes: ["orchestration:read"] }),
          ),
        ).toMatchObject({ reason: "not-configured" });
      }
      expect(Option.getOrThrow(yield* a.manifest.read).map((entry) => entry.environmentId)).toEqual(
        [FLEET_A, FLEET_B],
      );
    }).pipe(Effect.scoped),
  );
});
