import {
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
  type ServerConfig,
  type ServerFleetEnvironment,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ClientCapabilities from "../platform/capabilities.ts";
import * as RpcHttp from "../rpc/http.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
  connectionRegistrationCatalogEntry,
} from "./catalog.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import {
  FleetMembership,
  fleetMembersJoinedThrough,
  layer as layerFleetMembership,
  orphanedFleetMembers,
  planFleetSync,
  prepareFleetMemberRegistration,
} from "./fleet.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  ConnectionBlockedError,
  type ConnectionBlockedReason,
  fleetConnectionId,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import {
  connectionRouteKind,
  connectionRoutes,
  isManagedConnectionEntry,
  mergeLearnedRoutes,
} from "./routes.ts";

const A = EnvironmentId.make("fleet:a");
const B = EnvironmentId.make("fleet:b");
const C = EnvironmentId.make("fleet:c");
const D = EnvironmentId.make("fleet:d");

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

    expect(plan).toEqual({
      root: A,
      join: [member(B), member(C)],
      relabel: [],
      rejoin: [],
      remove: [],
    });
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
      relabel: [{ ...member(B), label: "renamed" }],
      rejoin: [],
      remove: [C],
    });
  });

  it("joins a member again when either of its URLs changes, even alongside a new label", () => {
    const movedHttp = { ...member(B), httpBaseUrl: "https://b-new.example.ts.net/" };
    const movedWs = { ...member(C), label: "renamed", wsBaseUrl: "wss://c-new.example.ts.net/" };
    const plan = planFleetSync({
      entries: catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A)),
      source: A,
      fleet: [member(A), movedHttp, movedWs],
    });

    expect(plan).toEqual({
      root: A,
      join: [],
      relabel: [],
      rejoin: [movedHttp, movedWs],
      remove: [],
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
      fleet: [
        member(A),
        { ...member(B), label: "renamed", httpBaseUrl: "https://elsewhere.example.ts.net/" },
      ],
    });

    expect(plan).toEqual({ root: A, join: [], relabel: [], rejoin: [], remove: [] });
  });

  it("follows only switched-on environments and never joins through a switched-off root", () => {
    const off = (entry: ConnectionCatalogEntry) => ({ ...entry, enabled: false });
    const movedC = { ...member(C), httpBaseUrl: "https://c-new.example.ts.net/" };

    expect(
      planFleetSync({
        entries: catalog(off(pairedEntry(A))),
        source: A,
        fleet: [member(A), member(B)],
      }),
    ).toBeNull();
    expect(
      planFleetSync({
        entries: catalog(off(pairedEntry(A)), joinedEntry(member(B), A), joinedEntry(member(C), A)),
        source: B,
        fleet: [
          member(A),
          { ...member(B), label: "renamed" },
          movedC,
          member(EnvironmentId.make("fleet:d")),
        ],
      }),
    ).toEqual({
      root: A,
      join: [],
      relabel: [{ ...member(B), label: "renamed" }],
      rejoin: [],
      remove: [],
    });
  });

  it("joins a member again through its root after its session was rejected", () => {
    const plan = planFleetSync({
      entries: catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A)),
      source: A,
      fleet: [member(A), { ...member(B), label: "renamed" }, member(C)],
      rejected: new Set([A, B]),
    });

    expect(plan).toEqual({
      root: A,
      join: [],
      relabel: [],
      rejoin: [{ ...member(B), label: "renamed" }],
      remove: [],
    });
  });

  it("replaces a rejected credential only through the root, and never one the user owns", () => {
    const fleet = [member(A), member(B), member(C), member(D)];
    const entries = catalog(
      pairedEntry(A),
      joinedEntry(member(B), A),
      { ...joinedEntry(member(C), A), enabled: false },
      pairedEntry(D),
    );

    expect(
      planFleetSync({ entries, source: A, fleet, rejected: new Set([B, C, D]) })?.rejoin,
    ).toEqual([member(B)]);
    expect(
      planFleetSync({
        entries: catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A)),
        source: B,
        fleet,
        rejected: new Set([C]),
      })?.rejoin,
    ).toEqual([]);
  });

  it("takes a fleet off the device with the machine it joined through", () => {
    const joined = catalog(pairedEntry(A), joinedEntry(member(B), A), joinedEntry(member(C), A));
    const afterRemovingRoot = catalog(joinedEntry(member(B), A), joinedEntry(member(C), A));

    expect(fleetMembersJoinedThrough(joined, A)).toEqual([B, C]);
    expect(orphanedFleetMembers(joined)).toEqual([]);
    expect(orphanedFleetMembers(afterRemovingRoot)).toEqual([
      { environmentId: B, root: A },
      { environmentId: C, root: A },
    ]);
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

/** Members answer as `answeringAs`, or else as the environment their host is named after. */
function layerMemberHttp(calls: Array<string>, answeringAs?: EnvironmentId) {
  return RpcHttp.layerRemoteHttpClient(((input) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/.well-known/t3/environment")) {
      const environmentId =
        answeringAs ?? EnvironmentId.make(`fleet:${new URL(url).hostname.split(".")[0]}`);
      return Promise.resolve(
        Response.json({
          environmentId,
          label: environmentId,
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
      }).pipe(Effect.provide(Layer.mergeAll(layerClientPresentation, layerMemberHttp(calls, B))));

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
        Effect.provide(Layer.mergeAll(layerClientPresentation, layerMemberHttp(calls, C))),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "ConnectionBlockedError", reason: "configuration" });
      expect(handoffs).toBe(0);
      expect(calls).toEqual(["https://b.example.ts.net/.well-known/t3/environment"]);
    }),
  );
});

describe("following a fleet whose sessions are rejected", () => {
  const UNJOINABLE = EnvironmentId.make("fleet:unjoinable");
  const inPhase = (
    phase: SupervisorConnectionState["phase"],
    lastFailure: ConnectionBlockedError | null = null,
  ): SupervisorConnectionState => ({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase,
    lastFailure,
  });

  /**
   * Follows `fleet` from a catalog of `entries` whose connections settle only
   * when `observe` says so. Saving an environment starts it connecting again,
   * as the registry does. Every session reports `fleet` and refuses a handoff
   * for UNJOINABLE, so each round that tries pending members asks for one.
   */
  const followFleet = <A, E>(input: {
    readonly entries: ReadonlyArray<ConnectionCatalogEntry>;
    readonly fleet: ReadonlyArray<ServerFleetEnvironment>;
    readonly observe: (context: {
      readonly membership: FleetMembership["Service"];
      readonly connect: (environmentId: EnvironmentId) => Effect.Effect<void>;
      readonly block: (
        environmentId: EnvironmentId,
        reason?: ConnectionBlockedReason,
      ) => Effect.Effect<void>;
      readonly saved: Queue.Queue<BearerConnectionRegistration>;
      /** Each handoff asked for, as the environment asked and the member it is for. */
      readonly handoffs: Queue.Queue<readonly [EnvironmentId, EnvironmentId]>;
    }) => Effect.Effect<A, E>;
  }) =>
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
      >(catalog(...input.entries));
      const supervisors = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentId, EnvironmentSupervisor.EnvironmentSupervisor["Service"]>
      >(new Map());
      const saved = yield* Queue.unbounded<BearerConnectionRegistration>();
      const handoffs = yield* Queue.unbounded<readonly [EnvironmentId, EnvironmentId]>();

      const start = Effect.fn(function* (entry: ConnectionCatalogEntry) {
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: entry.target,
          state: yield* SubscriptionRef.make(inPhase("connecting")),
          session: yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>()),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        yield* SubscriptionRef.update(supervisors, (current) =>
          new Map(current).set(entry.target.environmentId, supervisor),
        );
      });
      yield* Effect.forEach(input.entries, start, { discard: true });
      const supervisorOf = (environmentId: EnvironmentId) =>
        Effect.map(SubscriptionRef.get(supervisors), (current) => current.get(environmentId)!);
      const sessionOf = (issuer: EnvironmentId) =>
        ({
          initialConfig: Effect.succeed({ fleet: input.fleet } as unknown as ServerConfig),
          client: {
            [WS_METHODS.serverIssueFleetHandoff]: ({
              environmentId,
            }: {
              readonly environmentId: EnvironmentId;
            }) =>
              Queue.offer(handoffs, [issuer, environmentId] as const).pipe(
                Effect.andThen(
                  environmentId === UNJOINABLE
                    ? Effect.fail(
                        new ConnectionBlockedError({ reason: "permission", detail: "Refused." }),
                      )
                    : Effect.succeed({
                        credential: "t3fleet1.handoff",
                        expiresAt: DateTime.makeUnsafe(0),
                      }),
                ),
              ),
          },
        }) as unknown as RpcSession.RpcSession;

      const registry = {
        entries,
        register: (
          registration: ConnectionRegistration,
          guard?: EnvironmentRegistry.CatalogGuard,
        ) =>
          Effect.gen(function* () {
            if (guard !== undefined && !guard.admits(yield* SubscriptionRef.get(entries))) {
              return false;
            }
            const entry = connectionRegistrationCatalogEntry(registration);
            yield* SubscriptionRef.update(entries, (current) =>
              new Map(current).set(entry.target.environmentId, entry),
            );
            yield* start(entry);
            if (registration._tag === "BearerConnectionRegistration") {
              yield* Queue.offer(saved, registration);
            }
            return true;
          }),
        followStream: <A, E, R>(environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          SubscriptionRef.changes(supervisors).pipe(
            Stream.map((current) => current.get(environmentId)),
            Stream.changesWith((previous, current) => previous === current),
            Stream.switchMap((supervisor) =>
              supervisor === undefined
                ? Stream.empty
                : Stream.provideService(
                    stream,
                    EnvironmentSupervisor.EnvironmentSupervisor,
                    supervisor,
                  ),
            ),
          ),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];

      return yield* Effect.gen(function* () {
        return yield* input.observe({
          membership: yield* FleetMembership,
          connect: Effect.fn(function* (environmentId) {
            const supervisor = yield* supervisorOf(environmentId);
            yield* SubscriptionRef.set(supervisor.session, Option.some(sessionOf(environmentId)));
            yield* SubscriptionRef.set(supervisor.state, inPhase("connected"));
          }),
          block: Effect.fn(function* (environmentId, reason = "authentication") {
            const supervisor = yield* supervisorOf(environmentId);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* SubscriptionRef.set(
              supervisor.state,
              inPhase("blocked", new ConnectionBlockedError({ reason, detail: reason })),
            );
          }),
          saved,
          handoffs,
        });
      }).pipe(
        Effect.provide(
          layerFleetMembership.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registry),
                Layer.succeed(
                  ConnectionCredentialStore.ConnectionCredentialStore,
                  ConnectionCredentialStore.ConnectionCredentialStore.of({
                    get: () => Effect.succeedNone,
                    put: () => Effect.void,
                    remove: () => Effect.void,
                  }),
                ),
                Layer.succeed(
                  ConnectionWakeups.ConnectionWakeups,
                  ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
                ),
                layerClientPresentation,
                layerMemberHttp([]),
              ),
            ),
          ),
        ),
      );
    });

  /** Resolves once the round that asked UNJOINABLE's handoff has finished. */
  const roundFinished = (membership: FleetMembership["Service"]) =>
    SubscriptionRef.changes(membership.pending).pipe(
      Stream.filter((pending) =>
        pending.some((member) => member.environmentId === UNJOINABLE && member.status === "failed"),
      ),
      Stream.runHead,
    );

  it.effect("joins members back through their root once it is enrolled again", () =>
    Effect.gen(function* () {
      const { rejoined, handoffs } = yield* followFleet({
        entries: [pairedEntry(A), ...[B, C, D].map((id) => joinedEntry(member(id), A))],
        fleet: [A, B, C, D, UNJOINABLE].map((id) => member(id)),
        observe: ({ membership, connect, block, saved, handoffs }) =>
          Effect.gen(function* () {
            yield* Effect.forEach([A, B, C], (id) => block(id), { discard: true });
            yield* block(D, "configuration");
            yield* connect(A);
            const rejoined = [yield* Queue.take(saved), yield* Queue.take(saved)];
            // A further round would try D as well if its block counted as a rejection.
            yield* membership.retry;
            return { rejoined, handoffs: yield* Queue.clear(handoffs) };
          }),
      });

      expect(
        rejoined.map((registration) => [
          registration.target.connectionId,
          registration.credential.token,
        ]),
      ).toEqual(
        expect.arrayContaining([
          [fleetConnectionId(B, A), "member-session"],
          [fleetConnectionId(C, A), "member-session"],
        ]),
      );
      expect(handoffs.filter(([, environmentId]) => environmentId !== UNJOINABLE)).toEqual(
        expect.arrayContaining([
          [A, B],
          [A, C],
        ]),
      );
      expect(handoffs.filter(([, environmentId]) => environmentId !== UNJOINABLE)).toHaveLength(2);
    }),
  );

  it.effect("joins a rejected member again once, and again only after it connects", () =>
    Effect.gen(function* () {
      const result = yield* followFleet({
        entries: [pairedEntry(A), joinedEntry(member(B), A)],
        fleet: [member(A), member(B), member(UNJOINABLE)],
        observe: ({ membership, connect, block, saved, handoffs }) =>
          Effect.gen(function* () {
            yield* connect(A);
            yield* Queue.take(handoffs);
            yield* roundFinished(membership);
            yield* block(B);
            const rejoined = [yield* Queue.take(handoffs), yield* Queue.take(handoffs)];
            yield* Queue.take(saved);
            yield* roundFinished(membership);
            // The member refuses the credential it was just joined with.
            yield* block(B);
            const afterRefusal = [yield* Queue.take(handoffs)];
            yield* roundFinished(membership);
            afterRefusal.push(...(yield* Queue.clear(handoffs)));
            yield* connect(B);
            yield* block(B);
            yield* Queue.take(saved);
            return { rejoined, afterRefusal };
          }),
      });

      expect(result.rejoined).toEqual(
        expect.arrayContaining([
          [A, B],
          [A, UNJOINABLE],
        ]),
      );
      expect(result.afterRefusal).toEqual([[A, UNJOINABLE]]);
    }),
  );
});
