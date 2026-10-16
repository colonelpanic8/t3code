import {
  ConnectionOnboarding,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { FleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

const isAuthenticationRejected = (state: SupervisorConnectionState) =>
  state.phase === "blocked" &&
  state.lastFailure?._tag === "ConnectionBlockedError" &&
  state.lastFailure.reason === "authentication";

/**
 * Redeems a fleet enrollment at its anchor, through the same pairing path as a
 * typed code, so the descriptor must match the anchor before the credential is
 * sent. A saved anchor is left alone unless its session was rejected, for
 * example after expiring, so re-importing the file reconnects it instead of
 * minting a needless second session.
 */
export const enrollThroughFleetAnchor = Effect.fn("mobile.connection.enrollThroughFleetAnchor")(
  function* (enrollment: FleetEnrollment) {
    const { anchor } = enrollment;
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const saved = yield* registry.state(anchor.environmentId).pipe(Effect.option);
    if (Option.isSome(saved) && !isAuthenticationRejected(saved.value)) {
      return "already-enrolled" as const;
    }
    const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
    yield* onboarding.registerPairing({
      host: anchor.httpBaseUrl,
      pairingCode: Redacted.value(enrollment.credential),
      expectedEnvironmentId: anchor.environmentId,
    });
    return "enrolled" as const;
  },
);

/** An expired enrollment is refused before anything is sent. */
export const isFleetEnrollmentExpired = (enrollment: FleetEnrollment, now: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(enrollment.expiresAt, now);
