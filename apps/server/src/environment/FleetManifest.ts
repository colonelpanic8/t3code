/**
 * FleetManifest - the environments an operator declared as one fleet, and the
 * URLs clients reach each one at.
 *
 * Every member holds the same managed access token, so a client paired with
 * one member can join the others through a fleet handoff instead of pairing
 * each one. The manifest itself is not secret. It is read on every request,
 * so a rewritten file reaches clients on their next connection. Without a
 * managed access token no member could redeem a handoff, so nothing is
 * advertised.
 */
import { ServerFleetEnvironment } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const FleetManifestDocument = Schema.Struct({
  version: Schema.Literal(1),
  environments: Schema.Array(ServerFleetEnvironment),
});
const decodeFleetManifestDocument = Schema.decodeEffect(fromLenientJson(FleetManifestDocument));

const isServedUrl = (value: string, protocols: ReadonlyArray<string>): boolean => {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

export class FleetManifest extends Context.Service<
  FleetManifest,
  {
    /** The declared fleet, or none when this server is not configured as a member. */
    readonly read: Effect.Effect<Option.Option<ReadonlyArray<ServerFleetEnvironment>>>;
  }
>()("t3/environment/FleetManifest") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const manifestPath = config.fleetManifestPath;

  const read: FleetManifest["Service"]["read"] =
    manifestPath === undefined || config.managedAccessToken === undefined
      ? Effect.succeedNone
      : fileSystem.readFileString(manifestPath).pipe(
          Effect.flatMap(decodeFleetManifestDocument),
          Effect.map((document) =>
            Option.some(
              document.environments.filter(
                (environment) =>
                  isServedUrl(environment.httpBaseUrl, ["http:", "https:"]) &&
                  isServedUrl(environment.wsBaseUrl, ["ws:", "wss:"]),
              ),
            ),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Ignoring an unreadable fleet manifest.", { cause }).pipe(
              Effect.as(Option.none()),
            ),
          ),
          Effect.withSpan("FleetManifest.read"),
        );

  return FleetManifest.of({ read });
});

export const layer = Layer.effect(FleetManifest, make);
