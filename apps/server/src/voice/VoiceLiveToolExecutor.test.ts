import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as VoiceLiveToolExecutor from "./VoiceLiveToolExecutor.ts";

const threadId = ThreadId.make("thread:voice-1");
const updatedAt = DateTime.makeUnsafe("2026-08-01T00:00:00Z");

const withExecutor = <A, E>(
  dependencies: Layer.Layer<
    | ThreadManagementService.ThreadManagementService
    | ThreadLaunchService.ThreadLaunchService
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
  >,
  body: (executor: VoiceLiveToolExecutor.VoiceLiveToolExecutor["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const executor = yield* VoiceLiveToolExecutor.VoiceLiveToolExecutor;
    return yield* body(executor);
  }).pipe(
    Effect.provide(
      VoiceLiveToolExecutor.layer.pipe(
        Layer.provide(Layer.mergeAll(NodeServices.layer, dependencies)),
      ),
    ),
  );

const emptyMocks = Layer.mergeAll(
  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
);

describe("VoiceLiveToolExecutor", () => {
  it.effect("returns an isError result naming the valid tools for an unknown tool", () =>
    withExecutor(emptyMocks, (executor) =>
      Effect.gen(function* () {
        const result = yield* executor.execute("reboot_host", {});
        assert.strictEqual(result.isError, true);
        const message = (result.result as { message: string }).message;
        assert.include(message, "reboot_host");
        for (const tool of VoiceLiveToolExecutor.VOICE_LIVE_TOOL_NAMES) {
          assert.include(message, tool);
        }
      }),
    ),
  );

  it.effect("returns an isError result for invalid arguments", () =>
    withExecutor(emptyMocks, (executor) =>
      Effect.gen(function* () {
        const result = yield* executor.execute("read_thread", { threadId: 42 });
        assert.strictEqual(result.isError, true);
        assert.include((result.result as { message: string }).message, "Invalid arguments");
      }),
    ),
  );

  it.effect("read_thread returns a bounded, truncated conversation tail", () =>
    Effect.gen(function* () {
      const projection = {
        thread: { id: threadId, title: "Voice thread" },
        visibleTurnItems: [
          ...Array.from({ length: 45 }, (_, index) => ({
            position: index,
            item: {
              type: "assistant_message" as const,
              text: `message ${index}`,
              updatedAt,
            },
          })),
          {
            position: 45,
            item: {
              type: "assistant_message" as const,
              text: "x".repeat(5_000),
              updatedAt,
            },
          },
          {
            position: 46,
            item: { type: "checkpoint" as const, updatedAt },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const dependencies = Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
      );
      yield* withExecutor(dependencies, (executor) =>
        Effect.gen(function* () {
          const result = yield* executor.execute("read_thread", { threadId });
          assert.notStrictEqual(result.isError, true);
          const payload = result.result as {
            items: ReadonlyArray<{ type: string; text: string }>;
            shownItems: number;
            totalItems: number;
          };
          // Checkpoints are invisible to voice; the tail is capped at 30 of
          // the 46 message items, ending with the long, truncated one.
          assert.strictEqual(payload.totalItems, 46);
          assert.strictEqual(payload.shownItems, 30);
          assert.strictEqual(payload.items.length, 30);
          const last = payload.items.at(-1)!;
          assert.include(last.text, "…[truncated]");
          assert.isBelow(last.text.length, 2_100);
          assert.strictEqual(payload.items[0]!.text, "message 16");
        }),
      );
    }),
  );

  it.effect("send_message routes through sendToThread with the thread's project", () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const snapshot = {
        schemaVersion: 1,
        threads: [
          {
            id: threadId,
            projectId: "project-1",
            title: "Voice thread",
            status: "idle",
            updatedAt,
            archivedAt: null,
          },
        ],
        archivedThreads: [],
      } as unknown as OrchestrationV2ThreadShellSnapshot;
      const dependencies = Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getShellSnapshot: () => Effect.succeed(snapshot),
          sendToThread: (input) =>
            Ref.update(sent, (all) => [...all, input]).pipe(
              Effect.as({
                run: { id: "run-1", status: "running" },
                delivery: "started",
              } as never),
            ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({}),
      );
      yield* withExecutor(dependencies, (executor) =>
        Effect.gen(function* () {
          const result = yield* executor.execute("send_message", {
            threadId,
            message: "ship it",
          });
          assert.notStrictEqual(result.isError, true);
          const payload = result.result as { threadId: string; runId: string; status: string };
          assert.strictEqual(payload.threadId, threadId);
          assert.strictEqual(payload.runId, "run-1");
          const dispatched = yield* Ref.get(sent);
          assert.strictEqual(dispatched.length, 1);
          const input = dispatched[0] as {
            projectId: string;
            text: string;
            mode: string;
            createdBy: string;
          };
          assert.strictEqual(input.projectId, "project-1");
          assert.strictEqual(input.text, "ship it");
          assert.strictEqual(input.mode, "auto");
          assert.strictEqual(input.createdBy, "user");

          const missing = yield* executor.execute("send_message", {
            threadId: ThreadId.make("thread:nope"),
            message: "hello",
          });
          assert.strictEqual(missing.isError, true);
        }),
      );
    }),
  );
});
