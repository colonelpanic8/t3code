import { describe, expect, it } from "@effect/vitest";
import {
  AVAILABLE_CONNECTION_STATE,
  ConnectionBlockedError,
  ConnectionOnboarding,
  ConnectionTransientError,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { decodeFleetEnrollment } from "@t3tools/shared/fleetEnrollment";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import { failedFleetEntries, joinFleetEnrollment } from "./fleet-enrollment";

const credential = (letter: string) => `t3enroll1.${letter.repeat(43)}`;
const machine = (name: string, letter: string) => ({
  environmentId: name,
  label: name,
  httpBaseUrl: `http://${name}.test:3773`,
  wsBaseUrl: `ws://${name}.test:3773`,
  credential: credential(letter),
  expiresAt: "2099-01-01T00:00:00.000Z",
});
const { environments: bundle } = Result.getOrThrow(
  decodeFleetEnrollment(
    new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        type: "t3code.fleet-enrollment",
        environments: [machine("alpha", "A"), machine("beta", "B")],
      }),
    ),
  ),
);
const [alpha] = bundle;
const beta = bundle[1]!;

const connected: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};
const blocked = (reason: "authentication" | "configuration"): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "blocked",
  lastFailure: new ConnectionBlockedError({ reason, detail: "fixture" }),
});

/**
 * A device whose saved machines start as `saved`. A successful pairing saves
 * the machine; `pair` can fail or delay a host's pairing.
 */
function device(
  options: {
    readonly saved?: Record<string, SupervisorConnectionState>;
    readonly pair?: (
      host: string,
    ) => Effect.Effect<void, ConnectionTransientError | ConnectionBlockedError>;
  } = {},
) {
  const saved = new Map(Object.entries(options.saved ?? {}));
  const pairings: Array<{ host: string; pairingCode: string; expectedEnvironmentId: string }> = [];
  const registry = EnvironmentRegistry.EnvironmentRegistry.of({
    state: (environmentId: EnvironmentId) => {
      const state = saved.get(environmentId);
      return state === undefined
        ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId }))
        : Effect.succeed(state);
    },
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const onboarding = ConnectionOnboarding.ConnectionOnboarding.of({
    registerPairing: (input: {
      host: string;
      pairingCode: string;
      expectedEnvironmentId: EnvironmentId;
    }) =>
      Effect.sync(() => pairings.push(input)).pipe(
        Effect.andThen(options.pair?.(input.host) ?? Effect.void),
        Effect.tap(() => Effect.sync(() => saved.set(input.expectedEnvironmentId, connected))),
        Effect.as(input.expectedEnvironmentId),
      ),
  } as unknown as ConnectionOnboarding.ConnectionOnboarding["Service"]);
  const layer = Layer.mergeAll(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
    Layer.succeed(ConnectionOnboarding.ConnectionOnboarding, onboarding),
  );
  return {
    pairings,
    join: (entries: typeof bundle | ReadonlyArray<(typeof bundle)[number]>) =>
      joinFleetEnrollment(entries).pipe(
        Effect.map((outcomes) => [...outcomes]),
        Effect.provide(layer),
      ),
  };
}

const unreachable = (host: string) =>
  new ConnectionTransientError({ reason: "network", detail: `${host} is unreachable.` });

describe("joining a fleet enrollment", () => {
  it.effect("pairs every machine at its own address, checking each is the expected machine", () =>
    Effect.gen(function* () {
      const phone = device();
      expect(yield* phone.join(bundle)).toEqual([
        ["alpha", { kind: "joined" }],
        ["beta", { kind: "joined" }],
      ]);
      expect(phone.pairings).toEqual([
        {
          host: "http://alpha.test:3773",
          pairingCode: credential("A"),
          expectedEnvironmentId: "alpha",
        },
        {
          host: "http://beta.test:3773",
          pairingCode: credential("B"),
          expectedEnvironmentId: "beta",
        },
      ]);
    }),
  );

  it.effect("skips a saved machine unless its session was rejected", () =>
    Effect.gen(function* () {
      const phone = device({
        saved: { alpha: connected, beta: blocked("authentication") },
      });
      expect(yield* phone.join(bundle)).toEqual([
        ["alpha", { kind: "already-connected" }],
        ["beta", { kind: "joined" }],
      ]);
      expect(phone.pairings.map((pairing) => pairing.expectedEnvironmentId)).toEqual(["beta"]);

      const misconfigured = device({ saved: { alpha: blocked("configuration") } });
      expect(yield* misconfigured.join([alpha])).toEqual([
        ["alpha", { kind: "already-connected" }],
      ]);
    }),
  );

  it.effect("records a failed machine without holding up the others", () =>
    Effect.gen(function* () {
      const betaPaired = yield* Deferred.make<void>();
      // Alpha only fails once beta has paired, so a join that waited on alpha
      // before starting beta would never finish.
      const phone = device({
        pair: (host) =>
          host.includes("alpha")
            ? Deferred.await(betaPaired).pipe(Effect.andThen(Effect.fail(unreachable("alpha"))))
            : Deferred.succeed(betaPaired, undefined),
      });
      expect(yield* phone.join(bundle)).toEqual([
        ["alpha", { kind: "failed", message: "alpha is unreachable." }],
        ["beta", { kind: "joined" }],
      ]);
    }),
  );

  it.effect("explains a revoked or expired credential the machine rejected", () =>
    Effect.gen(function* () {
      const phone = device({
        pair: () =>
          Effect.fail(
            new ConnectionBlockedError({ reason: "authentication", detail: "Invalid grant." }),
          ),
      });
      expect(yield* phone.join([alpha])).toEqual([
        [
          "alpha",
          {
            kind: "failed",
            message: "Its enrollment was revoked or has expired. Export a new one.",
          },
        ],
      ]);
    }),
  );

  it.effect("retries only the machines that failed, and a re-import skips joined ones", () =>
    Effect.gen(function* () {
      let betaOnline = false;
      const phone = device({
        pair: (host) =>
          host.includes("beta") && !betaOnline ? Effect.fail(unreachable("beta")) : Effect.void,
      });
      const first = yield* phone.join(bundle);
      betaOnline = true;
      const retried = yield* phone.join(failedFleetEntries(bundle, new Map(first)));
      expect(retried).toEqual([["beta", { kind: "joined" }]]);
      expect(phone.pairings.map((pairing) => pairing.expectedEnvironmentId)).toEqual([
        "alpha",
        "beta",
        "beta",
      ]);

      expect(yield* phone.join(bundle)).toEqual([
        ["alpha", { kind: "already-connected" }],
        ["beta", { kind: "already-connected" }],
      ]);
      expect(phone.pairings).toHaveLength(3);
    }),
  );

  it.effect("refuses an expired machine without sending its credential", () =>
    Effect.gen(function* () {
      const phone = device();
      const expired = { ...alpha, expiresAt: DateTime.makeUnsafe(0) };
      expect(yield* phone.join([expired, beta])).toEqual([
        ["alpha", { kind: "expired" }],
        ["beta", { kind: "joined" }],
      ]);
      expect(phone.pairings.map((pairing) => pairing.expectedEnvironmentId)).toEqual(["beta"]);
    }),
  );
});
