import type {
  AuthFleetHandoffResult,
  EnvironmentId,
  ServerFleetEnvironment,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/http/HttpClient";

import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import type * as RpcSession from "../rpc/session.ts";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { orchestrationProtocolCompatibilityError } from "./compatibility.ts";
import * as ConnectionCredentialStore from "./credentialStore.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import { BearerConnectionTarget, fleetConnectionId, fleetConnectionRoot } from "./model.ts";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { connectionRoutes } from "./routes.ts";
import * as ConnectionWakeups from "./wakeups.ts";

/**
 * A server can report the fleet its operator declared it part of. Once the
 * client is connected to a member, it joins every member it has not saved
 * with a handoff that member issues, so pairing one machine pairs the fleet.
 * Joined members reach each machine at its declared URL, follow the declared
 * labels and URLs, and leave when the fleet no longer lists them. A credential
 * belongs to the URLs it was issued for: a member whose URL changes joins again
 * there, and keeps its old route until that succeeds.
 *
 * A joined member records the saved environment it was joined through, its
 * root. Removing the root removes what joined through it, which is how a user
 * takes a fleet off a device. Environments the user saved are never changed.
 */

type CatalogEntries = ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>;

/** The environment a fleet member was joined through, or null for one the user saved. */
function fleetRoot(entry: ConnectionCatalogEntry): EnvironmentId | null {
  for (const route of connectionRoutes(entry)) {
    if (route.target._tag !== "BearerConnectionTarget") continue;
    const root = fleetConnectionRoot(route.target.connectionId);
    if (root !== null) return root;
  }
  return null;
}

/** Fleet members that would leave with `root`. */
export function fleetMembersJoinedThrough(
  entries: CatalogEntries,
  root: EnvironmentId,
): ReadonlyArray<EnvironmentId> {
  return [...entries].flatMap(([environmentId, entry]) =>
    fleetRoot(entry) === root ? [environmentId] : [],
  );
}

/** Fleet members whose root is no longer saved. */
export function orphanedFleetMembers(entries: CatalogEntries): ReadonlyArray<EnvironmentId> {
  return [...entries].flatMap(([environmentId, entry]) => {
    const root = fleetRoot(entry);
    return root !== null && !entries.has(root) ? [environmentId] : [];
  });
}

export interface FleetSyncPlan {
  readonly root: EnvironmentId;
  /** Declared members this client has not saved. */
  readonly join: ReadonlyArray<ServerFleetEnvironment>;
  /** Joined members whose declared label changed at the same URLs. */
  readonly relabel: ReadonlyArray<ServerFleetEnvironment>;
  /** Joined members whose declared URLs changed. */
  readonly rejoin: ReadonlyArray<ServerFleetEnvironment>;
  /** Joined members the fleet no longer lists. */
  readonly remove: ReadonlyArray<EnvironmentId>;
}

/**
 * What following `fleet`, as reported by `source`, changes. A server that does
 * not list itself is not a member, and a switched-off one is not followed, so
 * their reports are ignored.
 */
export function planFleetSync(input: {
  readonly entries: CatalogEntries;
  readonly source: EnvironmentId;
  readonly fleet: ReadonlyArray<ServerFleetEnvironment>;
}): FleetSyncPlan | null {
  const sourceEntry = input.entries.get(input.source);
  if (
    sourceEntry === undefined ||
    !sourceEntry.enabled ||
    !input.fleet.some((member) => member.environmentId === input.source)
  ) {
    return null;
  }
  const root = fleetRoot(sourceEntry) ?? input.source;
  const rootEntry = input.entries.get(root);
  if (rootEntry === undefined) return null;
  const join: Array<ServerFleetEnvironment> = [];
  const relabel: Array<ServerFleetEnvironment> = [];
  const rejoin: Array<ServerFleetEnvironment> = [];
  for (const member of input.fleet) {
    const entry = input.entries.get(member.environmentId);
    if (entry === undefined) {
      // A switched-off root brings in no new machines.
      if (rootEntry.enabled) join.push(member);
      continue;
    }
    if (fleetRoot(entry) !== root) continue;
    const profile = connectionRoutes(entry)
      .map((route) => Option.getOrNull(route.profile))
      .find(
        (candidate) =>
          candidate?._tag === "BearerConnectionProfile" &&
          fleetConnectionRoot(candidate.connectionId) !== null,
      );
    if (profile?._tag !== "BearerConnectionProfile") continue;
    if (profile.httpBaseUrl !== member.httpBaseUrl || profile.wsBaseUrl !== member.wsBaseUrl) {
      rejoin.push(member);
    } else if (profile.label !== member.label) {
      relabel.push(member);
    }
  }
  const declared = new Set(input.fleet.map((member) => member.environmentId));
  const remove = fleetMembersJoinedThrough(input.entries, root).filter(
    (environmentId) => !declared.has(environmentId),
  );
  return { root, join, relabel, rejoin, remove };
}

function fleetRegistration(
  member: ServerFleetEnvironment,
  root: EnvironmentId,
  credential: BearerConnectionCredential,
) {
  const connectionId = fleetConnectionId(member.environmentId, root);
  return new BearerConnectionRegistration({
    target: new BearerConnectionTarget({
      environmentId: member.environmentId,
      label: member.label,
      connectionId,
    }),
    profile: new BearerConnectionProfile({
      connectionId,
      environmentId: member.environmentId,
      label: member.label,
      httpBaseUrl: member.httpBaseUrl,
      wsBaseUrl: member.wsBaseUrl,
    }),
    credential,
  });
}

/**
 * Pairs with one member through a handoff. The member must answer as the
 * declared environment before a handoff is requested, so an unreachable or
 * misdeclared machine spends nothing.
 */
export const prepareFleetMemberRegistration = Effect.fn(
  "clientRuntime.connection.fleet.prepareMemberRegistration",
)(function* <E>(input: {
  readonly member: ServerFleetEnvironment;
  readonly root: EnvironmentId;
  readonly issueHandoff: (environmentId: EnvironmentId) => Effect.Effect<AuthFleetHandoffResult, E>;
}) {
  const { member } = input;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const descriptor = yield* fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: member.httpBaseUrl,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  if (descriptor.environmentId !== member.environmentId) {
    return yield* environmentMismatchError({
      expected: member.environmentId,
      actual: descriptor.environmentId,
    });
  }
  const compatibilityError = orchestrationProtocolCompatibilityError(descriptor);
  // An outdated member is still joined so it can be updated from this client.
  if (compatibilityError !== null && compatibilityError.serverUpdateRequired !== true) {
    return yield* compatibilityError;
  }
  const handoff = yield* input.issueHandoff(member.environmentId);
  const access = yield* bootstrapRemoteBearerSession({
    httpBaseUrl: member.httpBaseUrl,
    credential: handoff.credential,
    clientMetadata: presentation.metadata,
  }).pipe(Effect.mapError(mapRemoteEnvironmentError));
  return fleetRegistration(
    member,
    input.root,
    new BearerConnectionCredential({ token: access.access_token }),
  );
});

export type PendingFleetMemberStatus = "not-joined" | "joining" | "failed";

/**
 * A member a followed fleet declares that this client has not joined at its
 * declared URLs. It is derived from live reports and never saved: `join` is a
 * machine not on this device yet, `rejoin` one still reached at its old URLs.
 */
export interface PendingFleetMember {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The saved environment it joins through. */
  readonly root: EnvironmentId;
  readonly kind: "join" | "rejoin";
  readonly status: PendingFleetMemberStatus;
}

export class FleetMembership extends Context.Service<
  FleetMembership,
  {
    /** Members the connected, switched-on environments report and this client has not joined. */
    readonly pending: SubscriptionRef.SubscriptionRef<ReadonlyArray<PendingFleetMember>>;
    /** Tries every pending member again, through the sessions currently reporting it. */
    readonly retry: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/fleet/FleetMembership") {}

const PENDING_RETRY_INTERVAL = Duration.minutes(5);
const PENDING_RETRY_LIMIT = 3;

function samePending(
  previous: ReadonlyArray<PendingFleetMember>,
  next: ReadonlyArray<PendingFleetMember>,
): boolean {
  return (
    previous.length === next.length &&
    previous.every((member, index) => {
      const other = next[index]!;
      return (
        member.environmentId === other.environmentId &&
        member.label === other.label &&
        member.root === other.root &&
        member.kind === other.kind &&
        member.status === other.status
      );
    })
  );
}

/**
 * Follows every saved environment's sessions and applies the fleet each one
 * reports. A member that could not be joined stays pending and is tried again
 * on a manual retry, when the app returns or changes network, and a few times
 * on a timer after that, only ever through a session that reports it.
 */
export const make = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  // One sync at a time, each planned against the latest catalog, so members
  // reporting the same fleet at once join a new machine only once.
  const lock = yield* Semaphore.make(1);
  const followers = yield* FiberMap.make<EnvironmentId>();
  const retries = yield* FiberHandle.make();
  /** The fleet each live session reported, by the environment it reached. */
  const reports = new Map<
    EnvironmentId,
    {
      readonly session: RpcSession.RpcSession;
      readonly fleet: ReadonlyArray<ServerFleetEnvironment>;
    }
  >();
  const attempts = new Map<EnvironmentId, "joining" | "failed">();
  const pending = yield* SubscriptionRef.make<ReadonlyArray<PendingFleetMember>>([]);

  const pendingIn = (entries: CatalogEntries): ReadonlyArray<PendingFleetMember> => {
    const members = new Map<EnvironmentId, PendingFleetMember>();
    for (const [source, { fleet }] of reports) {
      const plan = planFleetSync({ entries, source, fleet });
      if (plan === null) continue;
      for (const [kind, declared] of [
        ["join", plan.join],
        ["rejoin", plan.rejoin],
      ] as const) {
        for (const member of declared) {
          if (members.has(member.environmentId)) continue;
          members.set(member.environmentId, {
            environmentId: member.environmentId,
            label: member.label,
            root: plan.root,
            kind,
            status: attempts.get(member.environmentId) ?? "not-joined",
          });
        }
      }
    }
    return [...members.values()];
  };

  const publish = SubscriptionRef.updateSomeEffect(pending, (current) =>
    Effect.map(SubscriptionRef.get(registry.entries), (entries) => {
      const next = pendingIn(entries);
      const ids = new Set(next.map((member) => member.environmentId));
      for (const environmentId of attempts.keys()) {
        if (!ids.has(environmentId)) attempts.delete(environmentId);
      }
      return samePending(current, next) ? Option.none() : Option.some(next);
    }),
  );

  const logFailure =
    (message: string, annotations: Record<string, unknown>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catch((error) => Effect.logWarning(message, { ...annotations, error })),
      );

  const applyPlan = Effect.fn("clientRuntime.connection.fleet.applyPlan")(function* (
    plan: FleetSyncPlan,
    session: RpcSession.RpcSession,
    attempted: Set<EnvironmentId>,
  ) {
    yield* Effect.forEach(
      plan.remove,
      (environmentId) =>
        registry
          .remove(environmentId)
          .pipe(logFailure("Could not remove a machine that left the fleet.", { environmentId })),
      { discard: true },
    );
    yield* Effect.forEach(
      plan.relabel,
      (member) =>
        credentials.get(fleetConnectionId(member.environmentId, plan.root)).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (credential) =>
                registry.register(fleetRegistration(member, plan.root, credential)),
            }),
          ),
          logFailure("Could not rename a fleet machine.", { environmentId: member.environmentId }),
        ),
      { discard: true },
    );
    const joinMember = (member: ServerFleetEnvironment, failure: string) =>
      Effect.sync(() => attempts.set(member.environmentId, "joining")).pipe(
        Effect.andThen(publish),
        Effect.andThen(
          prepareFleetMemberRegistration({
            member,
            root: plan.root,
            issueHandoff: (environmentId) =>
              session.client[WS_METHODS.serverIssueFleetHandoff]({ environmentId }),
          }),
        ),
        Effect.flatMap(registry.register),
        Effect.onExit((exit) =>
          Effect.sync(() =>
            Exit.isSuccess(exit)
              ? attempts.delete(member.environmentId)
              : attempts.set(member.environmentId, "failed"),
          ),
        ),
        Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        logFailure(failure, { environmentId: member.environmentId }),
      );
    // Several sessions can report the same member; a round tries it once.
    const unattempted = (members: ReadonlyArray<ServerFleetEnvironment>) =>
      members.filter((member) => {
        if (attempted.has(member.environmentId)) return false;
        attempted.add(member.environmentId);
        return true;
      });
    yield* Effect.all(
      [
        ...unattempted(plan.join).map((member) =>
          joinMember(member, "Could not join a fleet machine."),
        ),
        ...unattempted(plan.rejoin).map((member) =>
          joinMember(member, "Could not join a fleet machine at its new address."),
        ),
      ],
      { concurrency: "unbounded", discard: true },
    );
  });

  const followReport = (source: EnvironmentId, attempted: Set<EnvironmentId>) =>
    Effect.gen(function* () {
      const report = reports.get(source);
      if (report === undefined) return;
      const plan = planFleetSync({
        entries: yield* SubscriptionRef.get(registry.entries),
        source,
        fleet: report.fleet,
      });
      if (plan !== null) yield* applyPlan(plan, report.session, attempted);
    });

  const retryAll = lock
    .withPermits(1)(
      Effect.gen(function* () {
        const attempted = new Set<EnvironmentId>();
        for (const source of reports.keys()) yield* followReport(source, attempted);
      }),
    )
    .pipe(Effect.ensuring(publish), logFailure("Could not retry joining the fleet.", {}));

  const hasPending = Effect.map(
    SubscriptionRef.get(registry.entries),
    (entries) => pendingIn(entries).length > 0,
  );

  const retryWhilePending = Effect.gen(function* () {
    for (let attempt = 0; attempt < PENDING_RETRY_LIMIT; attempt++) {
      yield* Effect.sleep(PENDING_RETRY_INTERVAL);
      if (!(yield* hasPending)) return;
      yield* retryAll;
    }
  });

  // Bounded so an unreachable member does not keep a backgrounded app polling;
  // the next wakeup, session, or manual retry starts another round.
  const scheduleRetries = Effect.gen(function* () {
    if (!(yield* hasPending)) return;
    yield* FiberHandle.run(retries, retryWhilePending, { onlyIfMissing: true });
  });

  const retry = Effect.gen(function* () {
    if (!(yield* hasPending)) return;
    yield* retryAll;
    yield* scheduleRetries;
  });

  const syncFrom = (source: EnvironmentId, session: RpcSession.RpcSession) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const fleet = (yield* session.initialConfig).fleet;
          if (fleet === undefined) {
            reports.delete(source);
            return;
          }
          reports.set(source, { session, fleet });
          yield* followReport(source, new Set());
        }),
      )
      .pipe(
        logFailure("Could not sync the fleet.", { environmentId: source }),
        Effect.andThen(scheduleRetries),
        Effect.ensuring(publish),
      );

  const followSessions = (environmentId: EnvironmentId) =>
    registry
      .followStream(
        environmentId,
        Stream.unwrap(
          Effect.map(EnvironmentSupervisor.EnvironmentSupervisor, (supervisor) =>
            SubscriptionRef.changes(supervisor.session),
          ),
        ),
      )
      .pipe(
        Stream.runForEach(
          Option.match({
            onNone: () =>
              Effect.sync(() => reports.delete(environmentId)).pipe(Effect.andThen(publish)),
            onSome: (session) => syncFrom(environmentId, session),
          }),
        ),
      );

  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          orphanedFleetMembers(entries),
          (environmentId) =>
            registry.remove(environmentId).pipe(
              logFailure("Could not remove a fleet machine after its root was removed.", {
                environmentId,
              }),
            ),
          { discard: true },
        );
        for (const environmentId of entries.keys()) {
          yield* FiberMap.run(followers, environmentId, followSessions(environmentId), {
            onlyIfMissing: true,
          });
        }
        yield* publish;
      }),
    ),
    Effect.forkScoped,
  );

  yield* wakeups.changes.pipe(
    Stream.filter(ConnectionWakeups.resetsRetryBackoff),
    Stream.runForEach(() => retry),
    Effect.forkScoped,
  );

  return FleetMembership.of({ pending, retry });
});

export const layer = Layer.effect(FleetMembership, make);
