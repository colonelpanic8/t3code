import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CoordinatorId,
  type CoordinatorInboxItem,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2ThreadShell,
  type PeerLinkSummary,
  type Project,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as CoordinatorService from "./CoordinatorService.ts";

const cos = CoordinatorId.make("cos");
const here = EnvironmentId.make("fleet:here");
const peer = EnvironmentId.make("fleet:peer");
const projectId = ProjectId.make("coordinator-project");

const peerItem: CoordinatorInboxItem = {
  id: "question:fleet:peer:worker:r1",
  kind: "question",
  title: "Worker",
  detail: "Rebase or merge?",
  thread: { environmentId: peer, threadId: ThreadId.make("worker") },
  environmentLabel: "peer",
  since: "2026-11-06T12:00:00.000Z",
};

/** A coordinator service over fakes; `threads` holds the threads that exist here. */
const makeService = (stateConfig: ServerConfig.ServerConfig["Service"]) =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const threads = yield* Ref.make<ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>>(new Map());
    const project = {
      id: projectId,
      title: "Chief of Staff",
      workspaceRoot: "/coordinator",
    } as Project;
    const layer = CoordinatorService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.succeed(ServerConfig.ServerConfig, stateConfig),
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: Effect.succeed({
              ...DEFAULT_SERVER_SETTINGS,
              coordinators: { [cos]: { name: "Chief of Staff", workspaceRoot: "/coordinator" } },
            }),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProjectService.ProjectService)({
            bootstrap: () => Effect.succeed({ project, created: false }),
            getById: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "" }),
          Layer.mock(ThreadLaunch.ThreadLaunchService)({
            launch: (input) =>
              Effect.gen(function* () {
                const threadId = input.threadId!;
                yield* Ref.update(launched, (ids) => [...ids, threadId]);
                yield* Ref.update(threads, (map) =>
                  new Map(map).set(threadId, {
                    id: threadId,
                    providerInstanceId: input.modelSelection.instanceId,
                    deletedAt: null,
                    activeRunId: null,
                  } as OrchestrationV2ThreadShell),
                );
                return {} as ThreadLaunch.ThreadLaunchResult;
              }),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Ref.get(threads).pipe(Effect.map((map) => map.get(threadId) ?? null)),
            dispatch: () => Effect.succeed({} as Orchestrator.OrchestratorV2DispatchResult),
            getShellSnapshot: () =>
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads: [],
                archivedThreads: [],
              }),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(here),
            getDescriptor: Effect.succeed({ label: "here" } as ExecutionEnvironmentDescriptor),
          }),
          Layer.mock(PeerLinks.PeerLinks)({
            enabled: Effect.succeed(true),
            list: Effect.succeed([
              { environmentId: peer, label: "peer", status: "reachable" } as PeerLinkSummary,
            ]),
          }),
          Layer.mock(PeerForwarding.PeerForwarding)({
            call: () => Effect.succeed({ items: [peerItem] } as never),
          }),
        ),
      ),
    );
    return { layer, launched, threads };
  });

const untilInbox = (
  service: CoordinatorService.CoordinatorService["Service"],
  ready: (items: ReadonlyArray<CoordinatorInboxItem>) => boolean,
) =>
  service.subscribeInbox(cos).pipe(
    Stream.filter((inbox) => ready(inbox.items)),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

it.live("keeps one thread per coordinator and merges the fleet inbox with its notes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const first = yield* makeService(config);
      const service = yield* CoordinatorService.CoordinatorService.pipe(
        Effect.provide(first.layer),
      );
      yield* service.start();

      const listed = yield* service.subscribeList.pipe(
        Stream.filter((result) => result.coordinators.some((value) => value.threadId !== null)),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      const [launchedThread] = yield* Ref.get(first.launched);
      expect(listed.coordinators).toMatchObject([
        { id: cos, projectId, threadId: launchedThread, error: null },
      ]);
      expect(yield* service.resolveId({ coordinatorId: undefined, threadId: undefined })).toBe(cos);

      // Peers report through the link; a note from the agent sorts after questions.
      const note = yield* service.post(cos, {
        title: "The tray widget thread ended asking which icon set",
        detail: null,
        thread: null,
      });
      const merged = yield* untilInbox(service, (items) =>
        items.some((item) => item.id === peerItem.id),
      );
      expect(merged.items.map((item) => item.id)).toEqual([peerItem.id, note.id]);
      expect(merged.sources.map((source) => [source.environmentId, source.status])).toEqual([
        [here, "ok"],
        [peer, "ok"],
      ]);

      yield* service.resolve(cos, note.id);
      expect((yield* service.inbox(cos)).items.map((item) => item.id)).toEqual([peerItem.id]);
      const missing = yield* service.resolve(cos, peerItem.id).pipe(Effect.flip);
      expect(missing.message).toContain("Only notes can be resolved");

      // A restart finds the stored thread instead of starting another.
      const second = yield* makeService(config);
      yield* Ref.set(second.threads, yield* Ref.get(first.threads));
      const restarted = yield* CoordinatorService.CoordinatorService.pipe(
        Effect.provide(second.layer),
      );
      yield* restarted.start();
      const relisted = yield* restarted.subscribeList.pipe(
        Stream.filter((result) => result.coordinators.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(relisted.coordinators[0]?.threadId).toBe(launchedThread);
      expect(yield* Ref.get(second.launched)).toEqual([]);
    }),
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-coordinator-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
  ),
);
