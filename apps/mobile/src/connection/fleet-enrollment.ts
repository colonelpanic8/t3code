import {
  ConnectionOnboarding,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import type { FleetEnrollmentEntry } from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type FleetJoinOutcome =
  | { readonly kind: "joined" }
  | { readonly kind: "already-connected" }
  | { readonly kind: "expired" }
  | { readonly kind: "failed"; readonly message: string };

export type FleetJoinOutcomes = ReadonlyMap<EnvironmentId, FleetJoinOutcome>;

const isAuthenticationRejected = (state: SupervisorConnectionState) =>
  state.phase === "blocked" &&
  state.lastFailure?._tag === "ConnectionBlockedError" &&
  state.lastFailure.reason === "authentication";

/** An expired entry is refused before anything is sent. */
export const isFleetEnrollmentEntryExpired = (entry: FleetEnrollmentEntry, now: DateTime.Utc) =>
  DateTime.isLessThanOrEqualTo(entry.expiresAt, now);

/**
 * Redeems one machine's credential at that machine, through the same pairing
 * path as a typed code, so its descriptor must match before the credential is
 * sent. A saved machine is left alone unless its session was rejected, for
 * example after expiring, so re-importing a bundle reconnects it instead of
 * minting a needless second session.
 */
const joinEntry = Effect.fn("mobile.connection.joinFleetEnrollmentEntry")(function* (
  entry: FleetEnrollmentEntry,
) {
  const { environment } = entry;
  if (isFleetEnrollmentEntryExpired(entry, yield* DateTime.now)) {
    return { kind: "expired" } as const;
  }
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const saved = yield* registry.state(environment.environmentId).pipe(Effect.option);
  if (Option.isSome(saved) && !isAuthenticationRejected(saved.value)) {
    return { kind: "already-connected" } as const;
  }
  const onboarding = yield* ConnectionOnboarding.ConnectionOnboarding;
  return yield* onboarding
    .registerPairing({
      host: environment.httpBaseUrl,
      pairingCode: Redacted.value(entry.credential),
      expectedEnvironmentId: environment.environmentId,
    })
    .pipe(
      Effect.as<FleetJoinOutcome>({ kind: "joined" }),
      Effect.catch((error) =>
        Effect.succeed<FleetJoinOutcome>({
          kind: "failed",
          message:
            error._tag === "ConnectionBlockedError" && error.reason === "authentication"
              ? "Its enrollment was revoked or has expired. Export a new one."
              : error.message,
        }),
      ),
    );
});

/** Joins every machine independently and at once; one unreachable machine never holds up the rest. */
export const joinFleetEnrollment = Effect.fn("mobile.connection.joinFleetEnrollment")(function* (
  entries: ReadonlyArray<FleetEnrollmentEntry>,
) {
  const outcomes = yield* Effect.forEach(entries, joinEntry, { concurrency: "unbounded" });
  return new Map(
    entries.map((entry, index) => [entry.environment.environmentId, outcomes[index]!] as const),
  ) satisfies FleetJoinOutcomes;
});

/** The machines whose last join failed, which a retry pairs again. Expired ones stay expired. */
export const failedFleetEntries = (
  entries: ReadonlyArray<FleetEnrollmentEntry>,
  outcomes: FleetJoinOutcomes,
) => entries.filter((entry) => outcomes.get(entry.environment.environmentId)?.kind === "failed");
