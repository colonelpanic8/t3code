import {
  CommandId,
  type Coordinator,
  type CoordinatorConfig,
  CoordinatorError,
  CoordinatorId,
  type CoordinatorInbox,
  type CoordinatorInboxItem,
  CoordinatorInboxItem as CoordinatorInboxItemSchema,
  type CoordinatorInboxSource,
  type CoordinatorInboxThreadRef,
  type CoordinatorListResult,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { CoordinatorToolkit } from "../mcp/toolkits/coordinator/tools.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { deriveAttention, sortInboxItems } from "./attention.ts";

const StoredCoordinator = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  notes: Schema.Array(CoordinatorInboxItemSchema),
});
type StoredCoordinator = typeof StoredCoordinator.Type;

const StateFile = Schema.Struct({
  version: Schema.Literal(1),
  coordinators: Schema.Record(Schema.String, StoredCoordinator),
});
type StateFile = typeof StateFile.Type;

const decodeStateFile = Schema.decodeUnknownEffect(Schema.fromJsonString(StateFile));

const PEER_REFRESH = Duration.seconds(30);
/** Events that can change what needs the user; message and turn-item streaming cannot. */
const ATTENTION_EVENTS: ReadonlySet<string> = new Set([
  "run.updated",
  "runtime-request.updated",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.settled",
  "thread.unsettled",
  "thread.snoozed",
  "thread.unsnoozed",
  "thread.visited",
  "thread.marked-unread",
  "thread.metadata-updated",
]);
const PEER_CALL_TIMEOUT = Duration.seconds(15);
/** Local thread changes arrive in bursts; one recompute per burst is enough. */
const LOCAL_CHANGE_DEBOUNCE = Duration.millis(750);

interface PeerAttention {
  readonly source: CoordinatorInboxSource;
  readonly items: ReadonlyArray<CoordinatorInboxItem>;
}

export class CoordinatorService extends Context.Service<
  CoordinatorService,
  {
    readonly list: Effect.Effect<CoordinatorListResult>;
    readonly subscribeList: Stream.Stream<CoordinatorListResult>;
    readonly inbox: (id: CoordinatorId) => Effect.Effect<CoordinatorInbox, CoordinatorError>;
    readonly subscribeInbox: (
      id: CoordinatorId,
    ) => Stream.Stream<CoordinatorInbox, CoordinatorError>;
    /** This environment's own items, which coordinators elsewhere ask for over links. */
    readonly localAttention: Effect.Effect<ReadonlyArray<CoordinatorInboxItem>>;
    readonly post: (
      id: CoordinatorId,
      note: {
        readonly title: string;
        readonly detail: string | null;
        readonly thread: CoordinatorInboxThreadRef | null;
      },
    ) => Effect.Effect<CoordinatorInboxItem, CoordinatorError>;
    /** Removes a note. Items about threads leave when the thread no longer needs the user. */
    readonly resolve: (id: CoordinatorId, itemId: string) => Effect.Effect<void, CoordinatorError>;
    /** Starts a fresh session in the coordinator's thread with its brief and the inbox. */
    readonly wake: (id: CoordinatorId) => Effect.Effect<void, CoordinatorError>;
    /** The coordinator a thread belongs to, or the only one when `threadId` is not one. */
    readonly resolveId: (input: {
      readonly coordinatorId: CoordinatorId | undefined;
      readonly threadId: ThreadId | undefined;
    }) => Effect.Effect<CoordinatorId, CoordinatorError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/coordinator/CoordinatorService") {}

const errorText = (cause: unknown) =>
  cause instanceof Error
    ? cause.message
    : typeof cause === "object" && cause !== null && "message" in cause
      ? String(cause.message)
      : String(cause);

const briefFor = (
  coordinator: Coordinator,
  config: CoordinatorConfig,
  inbox: CoordinatorInbox,
): string => {
  const lines = [
    `You are ${coordinator.name}, the user's coordinator. This is a fresh session: earlier sessions in this thread are not in your context, so keep anything worth remembering in files in this workspace.`,
    "You watch agent work across the user's environments and tell the user what needs them. `t3_inbox` (action list) shows the inbox; pass `environmentId` to any T3 tool to act in a linked environment. Post a note with `t3_inbox` (action post) when a thread needs the user but is not already listed, for example one that ended by asking a question in prose. Resolve your notes once they are handled.",
  ];
  if (config.instructions) lines.push("", config.instructions);
  lines.push("", "Current inbox:");
  if (inbox.items.length === 0) lines.push("- (empty)");
  for (const item of inbox.items.slice(0, 40)) {
    const where = item.thread
      ? ` [${item.environmentLabel ?? item.thread.environmentId} ${item.thread.threadId}]`
      : "";
    lines.push(`- ${item.kind}: ${item.title}${where}${item.detail ? `: ${item.detail}` : ""}`);
  }
  const down = inbox.sources.filter((source) => source.status === "unreachable");
  if (down.length > 0) {
    lines.push("", `Unreachable: ${down.map((source) => source.label).join(", ")}.`);
  }
  lines.push(
    "",
    "Reply with a short briefing: what needs the user first, then anything notable that finished.",
  );
  return lines.join("\n");
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsService = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const links = yield* PeerLinks.PeerLinks;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const random = yield* SecureRandom.SecureRandom;

  const statePath = path.join(config.stateDir, "coordinators.json");
  const stateLock = yield* Semaphore.make(1);
  const coordinatorsRef = yield* Ref.make<ReadonlyMap<CoordinatorId, Coordinator>>(new Map());
  const peersRef = yield* Ref.make<ReadonlyMap<EnvironmentId, PeerAttention>>(new Map());
  const listChanged = yield* PubSub.sliding<void>(1);
  const inboxChanged = yield* PubSub.sliding<void>(1);

  const uuid = random.uuidV4();
  const now = DateTime.now;

  const readState = fileSystem.readFileString(statePath).pipe(
    Effect.flatMap(decodeStateFile),
    Effect.orElseSucceed((): StateFile => ({ version: 1, coordinators: {} })),
  );
  const writeState = (state: StateFile) =>
    fileSystem.makeDirectory(config.stateDir, { recursive: true }).pipe(
      Effect.andThen(
        fileSystem.writeFileString(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`),
      ),
      Effect.andThen(fileSystem.rename(`${statePath}.tmp`, statePath)),
      Effect.mapError((cause) => new CoordinatorError({ message: errorText(cause) })),
    );
  const updateState = <A, E>(
    change: (state: StateFile) => Effect.Effect<readonly [A, StateFile], E>,
  ) =>
    stateLock.withPermits(1)(
      Effect.gen(function* () {
        const [result, next] = yield* change(yield* readState);
        yield* writeState(next);
        return result;
      }),
    );

  const hereId = yield* environment.getEnvironmentId;
  const hereLabel = environment.getDescriptor.pipe(Effect.map((descriptor) => descriptor.label));

  /** Makes sure the coordinator's project and thread exist; a new thread is pinned once. */
  const reconcileOne = Effect.fn("CoordinatorService.reconcileOne")(function* (
    id: CoordinatorId,
    coordinatorConfig: CoordinatorConfig,
    settings: ServerSettings,
    stored: StoredCoordinator | undefined,
  ) {
    const projectId: ProjectId =
      coordinatorConfig.workspaceRoot !== undefined
        ? (yield* projects.bootstrap({
            commandId: CommandId.make(`coordinator:${id}:project:${yield* uuid}`),
            projectId: ProjectId.make(yield* uuid),
            title: coordinatorConfig.name,
            workspaceRoot: coordinatorConfig.workspaceRoot,
          })).project.id
        : stored !== undefined &&
            Option.isSome(
              yield* projects.getById(stored.projectId).pipe(Effect.orElseSucceed(Option.none)),
            )
          ? stored.projectId
          : (yield* folders.createNamedProject({ name: coordinatorConfig.name })).projectId;

    const existing =
      stored !== undefined && stored.projectId === projectId
        ? yield* threads.getThreadShell(stored.threadId).pipe(Effect.orElseSucceed(() => null))
        : null;
    if (existing !== null && existing.deletedAt === null) {
      return { projectId, threadId: existing.id };
    }

    const project = yield* projects.getById(projectId).pipe(Effect.orElseSucceed(Option.none));
    const resolved = resolveProjectSettings(
      settings,
      projectId,
      Option.getOrNull(project),
    ).settings;
    const threadId = ThreadId.make(`coordinator-${id}-${yield* uuid}`);
    yield* threadLaunch.launch({
      commandId: CommandId.make(`coordinator:${id}:launch:${threadId}`),
      threadId,
      projectId,
      title: coordinatorConfig.name,
      modelSelection: coordinatorConfig.modelSelection ??
        resolved.defaultModelSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
      runtimeMode: resolved.defaultRuntimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      workspaceStrategy: { type: "root" },
      createdBy: "system",
      creationSource: "server",
    });
    yield* threads
      .dispatch({
        type: "thread.pin",
        commandId: CommandId.make(`coordinator:${id}:pin:${threadId}`),
        threadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    return { projectId, threadId };
  });

  const reconcile = Effect.fn("CoordinatorService.reconcile")(function* (settings: ServerSettings) {
    const configured = Object.entries(settings.coordinators).map(
      ([id, value]) => [CoordinatorId.make(id), value] as const,
    );
    const next = new Map<CoordinatorId, Coordinator>();
    yield* updateState((state) =>
      Effect.gen(function* () {
        const coordinators = { ...state.coordinators };
        for (const [id, coordinatorConfig] of configured) {
          const stored = coordinators[id];
          const outcome = yield* reconcileOne(id, coordinatorConfig, settings, stored).pipe(
            Effect.result,
          );
          if (outcome._tag === "Success") {
            coordinators[id] = {
              projectId: outcome.success.projectId,
              threadId: outcome.success.threadId,
              notes: stored?.notes ?? [],
            };
          } else {
            yield* Effect.logWarning("Coordinator could not be set up", {
              coordinatorId: id,
              error: errorText(outcome.failure),
            });
          }
          const kept = coordinators[id];
          const project =
            kept === undefined
              ? Option.none()
              : yield* projects.getById(kept.projectId).pipe(Effect.orElseSucceed(Option.none));
          next.set(id, {
            id,
            name: coordinatorConfig.name,
            projectId: kept?.projectId ?? null,
            threadId: kept?.threadId ?? null,
            workspaceRoot: Option.match(project, {
              onNone: () => coordinatorConfig.workspaceRoot ?? null,
              onSome: (value) => value.workspaceRoot,
            }),
            wakeEveryMinutes: coordinatorConfig.wakeEveryMinutes ?? null,
            error: outcome._tag === "Success" ? null : errorText(outcome.failure),
          });
        }
        return [undefined, { ...state, coordinators }] as const;
      }),
    ).pipe(Effect.catch((error) => Effect.logWarning("Coordinator state was not saved", error)));
    yield* Ref.set(coordinatorsRef, next);
    yield* PubSub.publish(listChanged, undefined);
    yield* PubSub.publish(inboxChanged, undefined);
  });

  const list: CoordinatorService["Service"]["list"] = Ref.get(coordinatorsRef).pipe(
    Effect.map((coordinators) => ({ coordinators: [...coordinators.values()] })),
  );

  const coordinatorThreadIds = Ref.get(coordinatorsRef).pipe(
    Effect.map(
      (coordinators) =>
        new Set(
          [...coordinators.values()].flatMap((coordinator) =>
            coordinator.threadId === null ? [] : [coordinator.threadId],
          ),
        ),
    ),
  );

  const localAttention: CoordinatorService["Service"]["localAttention"] = Effect.gen(function* () {
    const snapshot = yield* threads.getShellSnapshot({ unsettledOnly: true });
    return deriveAttention({
      environmentId: hereId,
      environmentLabel: yield* hereLabel,
      threads: snapshot.threads,
      now: yield* now,
      exclude: yield* coordinatorThreadIds,
    });
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Coordinator attention could not be read", error).pipe(Effect.as([])),
    ),
    Effect.withSpan("CoordinatorService.localAttention"),
  );

  const requireCoordinator = (id: CoordinatorId) =>
    Ref.get(coordinatorsRef).pipe(
      Effect.flatMap((coordinators) => {
        const found = coordinators.get(id);
        return found === undefined
          ? Effect.fail(new CoordinatorError({ message: `No coordinator named ${id} here.` }))
          : Effect.succeed(found);
      }),
    );

  /** Peers are asked as a coordinator's own thread, so its modes bound the call. */
  const peerScope = Effect.gen(function* () {
    for (const coordinator of (yield* Ref.get(coordinatorsRef)).values()) {
      if (coordinator.threadId === null) continue;
      const thread = yield* threads
        .getThreadShell(coordinator.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (thread === null) continue;
      return Option.some<McpInvocationContext.McpInvocationScope>({
        environmentId: hereId,
        requestNamespace: `coordinator:${coordinator.id}`,
        thread: {
          threadId: thread.id,
          providerSessionId: `coordinator:${coordinator.id}`,
          providerInstanceId: thread.providerInstanceId,
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
      });
    }
    return Option.none<McpInvocationContext.McpInvocationScope>();
  });

  const refreshPeers = Effect.gen(function* () {
    const found = yield* peerScope;
    if (Option.isNone(found) || !(yield* links.enabled)) {
      yield* Ref.set(peersRef, new Map());
      return;
    }
    const scope = found.value;
    const linked = yield* links.list.pipe(Effect.orElseSucceed(() => []));
    const previous = yield* Ref.get(peersRef);
    const checkedAt = DateTime.formatIso(yield* now);
    const results = yield* Effect.forEach(
      linked,
      (link) =>
        forwarding
          .call(scope, CoordinatorToolkit.tools.t3_inbox, link.environmentId, { action: "local" })
          .pipe(
            Effect.timeout(PEER_CALL_TIMEOUT),
            Effect.map((result): PeerAttention => ({
              source: {
                environmentId: link.environmentId,
                label: link.label,
                status: "ok",
                error: null,
                checkedAt,
              },
              items: result.items,
            })),
            Effect.catch((cause) =>
              Effect.succeed<PeerAttention>({
                source: {
                  environmentId: link.environmentId,
                  label: link.label,
                  status: "unreachable",
                  error: errorText(cause),
                  checkedAt: previous.get(link.environmentId)?.source.checkedAt ?? null,
                },
                items: previous.get(link.environmentId)?.items ?? [],
              }),
            ),
            Effect.map((attention) => [link.environmentId, attention] as const),
          ),
      { concurrency: "unbounded" },
    );
    yield* Ref.set(peersRef, new Map(results));
    yield* PubSub.publish(inboxChanged, undefined);
  }).pipe(Effect.withSpan("CoordinatorService.refreshPeers"));

  const inbox: CoordinatorService["Service"]["inbox"] = Effect.fn("CoordinatorService.inbox")(
    function* (id) {
      yield* requireCoordinator(id);
      const state = yield* readState;
      const notes = state.coordinators[id]?.notes ?? [];
      const local = yield* localAttention;
      const peers = [...(yield* Ref.get(peersRef)).values()];
      return {
        coordinatorId: id,
        items: sortInboxItems([...notes, ...local, ...peers.flatMap((peer) => peer.items)]),
        sources: [
          {
            environmentId: hereId,
            label: yield* hereLabel,
            status: "ok" as const,
            error: null,
            checkedAt: DateTime.formatIso(yield* now),
          },
          ...peers.map((peer) => peer.source),
        ],
      };
    },
  );

  const subscribeInbox: CoordinatorService["Service"]["subscribeInbox"] = (id) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* requireCoordinator(id);
        const changes = yield* PubSub.subscribe(inboxChanged);
        return Stream.concat(
          Stream.fromEffect(inbox(id)),
          Stream.fromSubscription(changes).pipe(
            Stream.debounce(LOCAL_CHANGE_DEBOUNCE),
            Stream.mapEffect(() => inbox(id)),
          ),
        );
      }),
    );

  const subscribeList: CoordinatorService["Service"]["subscribeList"] = Stream.unwrap(
    Effect.gen(function* () {
      const changes = yield* PubSub.subscribe(listChanged);
      return Stream.concat(
        Stream.fromEffect(list),
        Stream.fromSubscription(changes).pipe(Stream.mapEffect(() => list)),
      );
    }),
  );

  const post: CoordinatorService["Service"]["post"] = Effect.fn("CoordinatorService.post")(
    function* (id, note) {
      yield* requireCoordinator(id);
      const item: CoordinatorInboxItem = {
        id: `note:${yield* uuid}`,
        kind: "note",
        title: note.title,
        detail: note.detail,
        thread: note.thread,
        environmentLabel: null,
        since: DateTime.formatIso(yield* now),
      };
      yield* updateState((state) => {
        const stored = state.coordinators[id];
        return stored === undefined
          ? Effect.fail(new CoordinatorError({ message: `Coordinator ${id} is not set up yet.` }))
          : Effect.succeed([
              undefined,
              {
                ...state,
                coordinators: {
                  ...state.coordinators,
                  [id]: { ...stored, notes: [...stored.notes, item] },
                },
              },
            ] as const);
      });
      yield* PubSub.publish(inboxChanged, undefined);
      return item;
    },
  );

  const resolve: CoordinatorService["Service"]["resolve"] = Effect.fn("CoordinatorService.resolve")(
    function* (id, itemId) {
      yield* requireCoordinator(id);
      yield* updateState((state) => {
        const stored = state.coordinators[id];
        if (stored === undefined || !stored.notes.some((note) => note.id === itemId)) {
          return Effect.fail(
            new CoordinatorError({
              message: `No note ${itemId}. Only notes can be resolved; items about threads leave once the thread no longer needs the user.`,
            }),
          );
        }
        return Effect.succeed([
          undefined,
          {
            ...state,
            coordinators: {
              ...state.coordinators,
              [id]: { ...stored, notes: stored.notes.filter((note) => note.id !== itemId) },
            },
          },
        ] as const);
      });
      yield* PubSub.publish(inboxChanged, undefined);
    },
  );

  const wake: CoordinatorService["Service"]["wake"] = Effect.fn("CoordinatorService.wake")(
    function* (id) {
      const coordinator = yield* requireCoordinator(id);
      if (coordinator.threadId === null || coordinator.projectId === null) {
        return yield* new CoordinatorError({
          message: coordinator.error ?? `Coordinator ${id} has no thread yet.`,
        });
      }
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError((cause) => new CoordinatorError({ message: errorText(cause) })),
      );
      const coordinatorConfig = settings.coordinators[id];
      if (coordinatorConfig === undefined) {
        return yield* new CoordinatorError({ message: `Coordinator ${id} was removed.` });
      }
      yield* refreshPeers;
      const brief = briefFor(coordinator, coordinatorConfig, yield* inbox(id));
      const key = yield* uuid;
      yield* threads
        .sendToThread({
          projectId: coordinator.projectId,
          commandId: CommandId.make(`coordinator:${id}:wake:${key}`),
          threadId: coordinator.threadId,
          messageId: MessageId.make(`coordinator:${id}:wake:${key}`),
          text: brief,
          attachments: [],
          mode: "queue",
          freshContext: true,
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError((cause) => new CoordinatorError({ message: errorText(cause) })));
    },
  );

  const resolveId: CoordinatorService["Service"]["resolveId"] = Effect.fn(
    "CoordinatorService.resolveId",
  )(function* (input) {
    const coordinators = [...(yield* Ref.get(coordinatorsRef)).values()];
    if (input.coordinatorId !== undefined) return input.coordinatorId;
    const own = coordinators.find(
      (coordinator) => input.threadId !== undefined && coordinator.threadId === input.threadId,
    );
    if (own !== undefined) return own.id;
    if (coordinators.length === 1) return coordinators[0]!.id;
    return yield* new CoordinatorError({
      message:
        coordinators.length === 0
          ? "This environment has no coordinators. Add one under `coordinators` in its settings.json."
          : `Pass coordinatorId: one of ${coordinators.map((coordinator) => coordinator.id).join(", ")}.`,
    });
  });

  /** Wakes each coordinator on its own interval; restarted whenever settings change. */
  const runWakes = (coordinators: ReadonlyArray<Coordinator>) =>
    Effect.forEach(
      coordinators.filter((coordinator) => coordinator.wakeEveryMinutes !== null),
      (coordinator) =>
        Effect.gen(function* () {
          const thread =
            coordinator.threadId === null
              ? null
              : yield* threads
                  .getThreadShell(coordinator.threadId)
                  .pipe(Effect.orElseSucceed(() => null));
          // A session already working, or one the user is talking to, is not interrupted.
          if (thread !== null && thread.activeRunId !== null) return;
          yield* wake(coordinator.id);
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Coordinator wake failed", { coordinatorId: coordinator.id, cause }),
          ),
          Effect.repeat(Schedule.spaced(Duration.minutes(coordinator.wakeEveryMinutes ?? 60))),
          Effect.delay(Duration.minutes(coordinator.wakeEveryMinutes ?? 60)),
        ),
      { concurrency: "unbounded", discard: true },
    );

  const start: CoordinatorService["Service"]["start"] = Effect.fn("CoordinatorService.start")(
    function* () {
      const settingsChanges = settingsService.streamChanges.pipe(
        Stream.map((settings) => JSON.stringify(settings.coordinators)),
        Stream.changes,
      );
      yield* forkParked(
        Stream.concat(
          Stream.fromEffect(
            settingsService.getSettings.pipe(
              Effect.map((settings) => JSON.stringify(settings.coordinators)),
            ),
          ),
          settingsChanges,
        ).pipe(
          Stream.changes,
          Stream.mapEffect(() => settingsService.getSettings),
          Stream.switchMap((settings) =>
            Stream.fromEffect(
              reconcile(settings).pipe(
                // The first refresh can run before any coordinator thread exists to ask as.
                Effect.andThen(refreshPeers.pipe(Effect.ignoreCause({ log: true }))),
                Effect.andThen(Ref.get(coordinatorsRef)),
                Effect.flatMap((coordinators) => runWakes([...coordinators.values()])),
              ),
            ),
          ),
          Stream.runDrain,
          Effect.ignoreCause({ log: true }),
        ),
      );
      yield* forkParked(
        refreshPeers.pipe(
          Effect.ignoreCause({ log: true }),
          Effect.repeat(Schedule.spaced(PEER_REFRESH)),
        ),
      );
      yield* forkParked(
        orchestrator.streamDomainEvents.pipe(
          Stream.filter((event) => ATTENTION_EVENTS.has(event.type)),
          Stream.runForEach(() => PubSub.publish(inboxChanged, undefined)),
          Effect.ignoreCause({ log: true }),
        ),
      );
    },
  );

  return CoordinatorService.of({
    list,
    subscribeList,
    inbox,
    subscribeInbox,
    localAttention,
    post,
    resolve,
    wake,
    resolveId,
    start,
  });
});

export const layer = Layer.effect(CoordinatorService, make);
