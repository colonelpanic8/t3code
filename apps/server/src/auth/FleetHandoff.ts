/**
 * FleetHandoff - lets a client paired with one fleet member pair with another
 * without a new pairing link.
 *
 * Every member holds the same managed access token. The member a client is
 * connected to signs a short-lived credential naming the target environment,
 * a nonce, and the caller's own scopes. The target verifies the signature,
 * that it is the audience, the expiry, and that the nonce is unused, then
 * issues its own revocable session. The shared token never leaves the hosts,
 * and a handoff cannot widen the grant it was minted from.
 */
import {
  AuthFleetHandoffError,
  type AuthFleetHandoffResult,
  type AuthEnvironmentScope,
  AuthGrantScope,
  EnvironmentId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as FleetManifest from "../environment/FleetManifest.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "./utils.ts";

/** Secret store name prefix of redeemed handoff nonces. The server prunes expired ones. */
export const FLEET_HANDOFF_REPLAY_MARKER_PREFIX = "fleet-handoff-";
/** The subject of sessions issued for a fleet handoff. */
export const FLEET_HANDOFF_SUBJECT = "fleet-handoff";

const CREDENTIAL_PREFIX = "t3fleet1.";
const SIGNING_KEY_CONTEXT = "t3code fleet handoff v1";
// Long enough for clock skew between hosts; the client redeems at once.
const HANDOFF_TTL = Duration.minutes(5);

const HandoffClaims = Schema.Struct({
  aud: EnvironmentId,
  iss: EnvironmentId,
  exp: Schema.Number,
  nonce: Schema.String.check(Schema.isPattern(/^[0-9a-f-]{36}$/)),
  scopes: Schema.Array(Schema.String),
});
const HandoffClaimsJson = Schema.fromJsonString(HandoffClaims);
const decodeHandoffClaims = Schema.decodeUnknownEffect(HandoffClaimsJson);
const encodeHandoffClaims = Schema.encodeEffect(HandoffClaimsJson);
const isGrantScope = Schema.is(AuthGrantScope);

export const isFleetHandoffCredential = (credential: string): boolean =>
  credential.startsWith(CREDENTIAL_PREFIX);

class FleetHandoffInvalidError extends Schema.TaggedError<FleetHandoffInvalidError>()(
  "FleetHandoffInvalidError",
  {
    reason: Schema.Literals([
      "not-configured",
      "malformed",
      "signature",
      "audience",
      "expired",
      "replayed",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Fleet handoff credential rejected: ${this.reason}.`;
  }
}

class FleetHandoffReplayStateError extends Schema.TaggedError<FleetHandoffReplayStateError>()(
  "FleetHandoffReplayStateError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to record fleet handoff replay state.";
  }
}

export interface RedeemedFleetHandoff {
  readonly issuer: EnvironmentId;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export class FleetHandoff extends Context.Service<
  FleetHandoff,
  {
    readonly issue: (input: {
      readonly audience: EnvironmentId;
      readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
    }) => Effect.Effect<AuthFleetHandoffResult, AuthFleetHandoffError>;
    readonly redeem: (
      credential: string,
    ) => Effect.Effect<
      RedeemedFleetHandoff,
      FleetHandoffInvalidError | FleetHandoffReplayStateError
    >;
  }
>()("t3/auth/FleetHandoff") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const manifest = yield* FleetManifest.FleetManifest;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const signingKey =
    config.managedAccessToken === undefined
      ? undefined
      : Buffer.from(
          signPayload(SIGNING_KEY_CONTEXT, new TextEncoder().encode(config.managedAccessToken)),
          "base64url",
        );

  const issue: FleetHandoff["Service"]["issue"] = Effect.fn("FleetHandoff.issue")(
    function* (input) {
      const fleet = yield* manifest.read;
      if (signingKey === undefined || Option.isNone(fleet)) {
        return yield* new AuthFleetHandoffError({ reason: "not-configured" });
      }
      if (!fleet.value.some((environment) => environment.environmentId === input.audience)) {
        return yield* new AuthFleetHandoffError({ reason: "not-a-member" });
      }
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { milliseconds: Duration.toMillis(HANDOFF_TTL) });
      // Neither randomness nor encoding these claims can fail on a working host.
      const nonce = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const claims = yield* encodeHandoffClaims({
        aud: input.audience,
        iss: yield* identity.getEnvironmentId,
        exp: expiresAt.epochMilliseconds,
        nonce,
        scopes: input.scopes.filter(isGrantScope),
      }).pipe(Effect.orDie);
      const payload = base64UrlEncode(claims);
      return {
        credential: `${CREDENTIAL_PREFIX}${payload}.${signPayload(payload, signingKey)}`,
        expiresAt: DateTime.toUtc(expiresAt),
      };
    },
  );

  const redeem: FleetHandoff["Service"]["redeem"] = Effect.fn("FleetHandoff.redeem")(
    function* (credential) {
      if (signingKey === undefined) {
        return yield* new FleetHandoffInvalidError({ reason: "not-configured" });
      }
      const [payload, signature, ...rest] = credential.slice(CREDENTIAL_PREFIX.length).split(".");
      if (!isFleetHandoffCredential(credential) || !payload || !signature || rest.length > 0) {
        return yield* new FleetHandoffInvalidError({ reason: "malformed" });
      }
      if (!timingSafeEqualBase64Url(signature, signPayload(payload, signingKey))) {
        return yield* new FleetHandoffInvalidError({ reason: "signature" });
      }
      const claims = yield* Effect.try(() => base64UrlDecodeUtf8(payload)).pipe(
        Effect.flatMap(decodeHandoffClaims),
        Effect.mapError((cause) => new FleetHandoffInvalidError({ reason: "malformed", cause })),
      );
      if (claims.aud !== (yield* identity.getEnvironmentId)) {
        return yield* new FleetHandoffInvalidError({ reason: "audience" });
      }
      if ((yield* DateTime.now).epochMilliseconds >= claims.exp) {
        return yield* new FleetHandoffInvalidError({ reason: "expired" });
      }
      const scopes = claims.scopes.filter(isGrantScope);
      if (scopes.length === 0) {
        return yield* new FleetHandoffInvalidError({ reason: "malformed" });
      }
      // Markers are files, so a redeemed nonce stays spent across restarts.
      yield* secretStore
        .create(
          `${FLEET_HANDOFF_REPLAY_MARKER_PREFIX}${claims.nonce}`,
          new TextEncoder().encode(`iss=${claims.iss}\nexp=${claims.exp}`),
        )
        .pipe(
          Effect.mapError((cause) =>
            ServerSecretStore.isSecretAlreadyExistsError(cause)
              ? new FleetHandoffInvalidError({ reason: "replayed", cause })
              : new FleetHandoffReplayStateError({ cause }),
          ),
        );
      return { issuer: claims.iss, scopes };
    },
  );

  return FleetHandoff.of({ issue, redeem });
});

export const layer = Layer.effect(FleetHandoff, make).pipe(Layer.provideMerge(FleetManifest.layer));
