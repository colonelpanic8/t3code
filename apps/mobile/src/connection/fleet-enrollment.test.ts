import { describe, expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionOnboarding,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { decodeFleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { enrollThroughFleetAnchor, isFleetEnrollmentExpired } from "./fleet-enrollment";

const CREDENTIAL = `t3enroll1.${"A".repeat(43)}`;
const enrollment = Result.getOrThrow(
  decodeFleetEnrollment(
    new TextEncoder().encode(
      JSON.stringify({
        version: 1,
        type: "t3code.fleet-enrollment",
        anchor: {
          environmentId: "anchor",
          label: "Anchor",
          httpBaseUrl: "http://anchor.test:3773",
          wsBaseUrl: "ws://anchor.test:3773",
        },
        credential: CREDENTIAL,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    ),
  ),
);
const anchorId = EnvironmentId.make("anchor");

function enroll(
  saved: SupervisorConnectionState | null,
  input = enrollment,
  pairings: Array<unknown> = [],
) {
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    state: (environmentId: EnvironmentId) =>
      saved === null
        ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId }))
        : Effect.succeed(saved),
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const onboarding = ConnectionOnboarding.ConnectionOnboarding.of({
    registerPairing: (input: unknown) =>
      Effect.sync(() => pairings.push(input)).pipe(Effect.as(anchorId)),
  } as unknown as ConnectionOnboarding.ConnectionOnboarding["Service"]);
  return enrollThroughFleetAnchor(input).pipe(
    Effect.map((outcome) => ({ outcome, pairings })),
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
        Layer.succeed(ConnectionOnboarding.ConnectionOnboarding, onboarding),
      ),
    ),
  );
}

const blocked = (reason: "authentication" | "configuration"): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "blocked",
  lastFailure: new ConnectionBlockedError({ reason, detail: "fixture" }),
});

describe("fleet enrollment", () => {
  it.effect("pairs a new anchor, checking it is the expected machine", () =>
    Effect.gen(function* () {
      const { outcome, pairings } = yield* enroll(null);
      expect(outcome).toBe("enrolled");
      expect(pairings).toEqual([
        {
          host: "http://anchor.test:3773",
          pairingCode: CREDENTIAL,
          expectedEnvironmentId: "anchor",
        },
      ]);
    }),
  );

  it.effect("re-enrolls a saved anchor whose session was rejected", () =>
    Effect.gen(function* () {
      const { outcome, pairings } = yield* enroll(blocked("authentication"));
      expect(outcome).toBe("enrolled");
      expect(pairings).toHaveLength(1);
    }),
  );

  it.effect("leaves an otherwise saved anchor alone", () =>
    Effect.gen(function* () {
      for (const state of [
        { ...AVAILABLE_CONNECTION_STATE, desired: true, phase: "connected" as const },
        blocked("configuration"),
      ]) {
        const { outcome, pairings } = yield* enroll(state);
        expect(outcome).toBe("already-enrolled");
        expect(pairings).toEqual([]);
      }
    }),
  );

  it.effect("refuses an enrollment that expired while awaiting confirmation without pairing", () =>
    Effect.gen(function* () {
      const pairings: Array<unknown> = [];
      const expired = { ...enrollment, expiresAt: DateTime.makeUnsafe(0) };
      const error = yield* Effect.flip(enroll(null, expired, pairings));
      expect(error._tag).toBe("FleetEnrollmentExpiredError");
      expect(pairings).toEqual([]);
    }),
  );

  it("treats the expiry instant as expired", () => {
    expect(isFleetEnrollmentExpired(enrollment, enrollment.expiresAt)).toBe(true);
    expect(
      isFleetEnrollmentExpired(enrollment, DateTime.makeUnsafe("2098-12-31T23:59:59.999Z")),
    ).toBe(false);
  });
});
