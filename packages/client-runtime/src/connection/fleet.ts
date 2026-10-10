import type {
  AuthFleetHandoffResult,
  EnvironmentId,
  ServerFleetEnvironment,
} from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
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

/**
 * A server can report the fleet its operator declared it part of. Once the
 * client is connected to a member, it joins every member it has not saved
 * with a handoff that member issues, so pairing one machine pairs the fleet.
 * Joined members reach each machine at its declared URL, follow the declared
 * labels and URLs, and leave when the fleet no longer lists them.
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
  /** Joined members whose declared label or URLs changed. */
  readonly update: ReadonlyArray<ServerFleetEnvironment>;
  /** Joined members the fleet no longer lists. */
  readonly remove: ReadonlyArray<EnvironmentId>;
}

/**
 * What following `fleet`, as reported by `source`, changes. A server that does
 * not list itself is not a member, so its report is ignored.
 */
export function planFleetSync(input: {
  readonly entries: CatalogEntries;
  readonly source: EnvironmentId;
  readonly fleet: ReadonlyArray<ServerFleetEnvironment>;
}): FleetSyncPlan | null {
  const sourceEntry = input.entries.get(input.source);
  if (
    sourceEntry === undefined ||
    !input.fleet.some((member) => member.environmentId === input.source)
  ) {
    return null;
  }
  const root = fleetRoot(sourceEntry) ?? input.source;
  const join: Array<ServerFleetEnvironment> = [];
  const update: Array<ServerFleetEnvironment> = [];
  for (const member of input.fleet) {
    const entry = input.entries.get(member.environmentId);
    if (entry === undefined) {
      join.push(member);
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
    if (
      profile?._tag === "BearerConnectionProfile" &&
      (profile.label !== member.label ||
        profile.httpBaseUrl !== member.httpBaseUrl ||
        profile.wsBaseUrl !== member.wsBaseUrl)
    ) {
      update.push(member);
    }
  }
  const declared = new Set(input.fleet.map((member) => member.environmentId));
  const remove = fleetMembersJoinedThrough(input.entries, root).filter(
    (environmentId) => !declared.has(environmentId),
  );
  return { root, join, update, remove };
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

/**
 * Follows every saved environment's sessions and applies the fleet each one
 * reports. Runs for the life of the connection layer.
 */
export const syncFleets = Effect.fn("clientRuntime.connection.syncFleets")(function* () {
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const credentials = yield* ConnectionCredentialStore.ConnectionCredentialStore;
  const presentation = yield* ClientCapabilities.ClientPresentation;
  const httpClient = yield* HttpClient.HttpClient;
  // One sync at a time, each planned against the latest catalog, so members
  // reporting the same fleet at once join a new machine only once.
  const lock = yield* Semaphore.make(1);
  const followers = yield* FiberMap.make<EnvironmentId>();

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
      plan.update,
      (member) =>
        credentials.get(fleetConnectionId(member.environmentId, plan.root)).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (credential) =>
                registry.register(fleetRegistration(member, plan.root, credential)),
            }),
          ),
          logFailure("Could not update a fleet machine.", { environmentId: member.environmentId }),
        ),
      { discard: true },
    );
    yield* Effect.forEach(
      plan.join,
      (member) =>
        prepareFleetMemberRegistration({
          member,
          root: plan.root,
          issueHandoff: (environmentId) =>
            session.client[WS_METHODS.serverIssueFleetHandoff]({ environmentId }),
        }).pipe(
          Effect.flatMap(registry.register),
          Effect.provideService(ClientCapabilities.ClientPresentation, presentation),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          // Offline or off the tailnet: the next connection to any member tries again.
          logFailure("Could not join a fleet machine.", { environmentId: member.environmentId }),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const syncFrom = (source: EnvironmentId, session: RpcSession.RpcSession) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const fleet = (yield* session.initialConfig).fleet;
          if (fleet === undefined) return;
          const plan = planFleetSync({
            entries: yield* SubscriptionRef.get(registry.entries),
            source,
            fleet,
          });
          if (plan !== null) yield* applyPlan(plan, session);
        }),
      )
      .pipe(logFailure("Could not sync the fleet.", { environmentId: source }));

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
            onNone: () => Effect.void,
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
      }),
    ),
  );
});
