/**
 * Reproduction / benchmark for the thread-resume replay chug.
 *
 * When a thread accumulates many persisted streaming `thread.message-sent`
 * delta events (assistant streaming enabled) and a client resumes its
 * subscription with `afterSequence`, the server replays every event
 * individually and the client applies them one at a time. Each apply copies
 * the whole message array, re-concatenates the whole accumulated text, and
 * publishes a new state to every subscriber (i.e. a React render of the full
 * timeline + markdown reparse per delta). Total work is quadratic in the
 * backlog.
 *
 * These tests quantify that on the real code paths so a fix can be verified:
 *  - "reducer replay cost" times the pure `applyThreadDetailEvent` fold,
 *    including a per-event full read of the accumulated text to model the
 *    renderer consuming each intermediate state (V8 cons strings make the
 *    concat itself cheap until the string is read).
 *  - "resume replay emissions" drives the real threads state machine through
 *    a resumed subscription and counts how many state values subscribers
 *    observe. Today this is one per delta event — the deterministic signature
 *    of the bug. A batching/coalescing fix should collapse it to a small
 *    number regardless of backlog size, and cut the wall time accordingly.
 *
 * Run with:
 *   pnpm --filter @t3tools/client-runtime test src/state/threadReplayPerf.test.ts
 *
 * For an end-to-end repro in the real app, see the chunked-response mode of
 * apps/server/scripts/acp-mock-agent.ts (T3_ACP_PROMPT_RESPONSE_CHUNK_COUNT)
 * with the `enableAssistantStreaming` server setting turned on.
 */
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import { applyThreadDetailEvent } from "./threadReducer.ts";
import { CACHED_SNAPSHOT_SEQUENCE, makeThreadSyncHarness } from "./threadsSyncHarness.test-util.ts";

const THREAD_ID = ThreadId.make("thread-1");
const STREAMING_MESSAGE_ID = MessageId.make("msg-streaming");
const TURN_ID = TurnId.make("turn-1");
const CHUNK_TEXT = "another twenty-four chars. ";

const baseThread: OrchestrationThread = {
  id: THREAD_ID,
  projectId: ProjectId.make("project-1"),
  title: "Replay perf thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const streamingDeltaEvent = (index: number, sequence: number): OrchestrationEvent =>
  ({
    eventId: EventId.make(`event-delta-${index}`),
    sequence,
    occurredAt: "2026-04-01T01:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    type: "thread.message-sent",
    payload: {
      threadId: THREAD_ID,
      messageId: STREAMING_MESSAGE_ID,
      role: "assistant",
      text: CHUNK_TEXT,
      turnId: TURN_ID,
      streaming: true,
      createdAt: "2026-04-01T01:00:00.000Z",
      updatedAt: "2026-04-01T01:00:00.000Z",
    },
  }) as OrchestrationEvent;

/**
 * Force the accumulated text to be read the way a renderer would. Without
 * this, V8 cons strings defer the O(length) concat cost to the first read,
 * which in the app happens on every emission (markdown parse of the full
 * message text).
 */
const readFullText = (text: string): number => {
  let total = 0;
  for (let index = 0; index < text.length; index += 256) {
    total += text.charCodeAt(index);
  }
  return total;
};

describe("thread replay performance", () => {
  it.effect("reducer replay cost grows superlinearly with delta backlog", () =>
    Effect.gen(function* () {
      const timings: Array<{ deltas: number; ms: number }> = [];

      for (const deltas of [1000, 2000, 4000, 8000]) {
        let thread = baseThread;
        const events = Array.from({ length: deltas }, (_, index) =>
          streamingDeltaEvent(index, index + 1),
        );

        const startedAt = performance.now();
        for (const event of events) {
          const result = applyThreadDetailEvent(thread, event);
          if (result.kind === "updated") {
            thread = result.thread;
          }
          // Model the renderer consuming each intermediate state.
          readFullText(thread.messages[0]?.text ?? "");
        }
        const ms = performance.now() - startedAt;

        expect(thread.messages).toHaveLength(1);
        expect(thread.messages[0]?.text).toHaveLength(deltas * CHUNK_TEXT.length);
        timings.push({ deltas, ms });
      }

      // Report the curve; doubling the backlog roughly quadruples total cost
      // when the behavior is quadratic.
      yield* Effect.log(
        `[threadReplayPerf] reducer fold: ${timings
          .map(({ deltas, ms }) => `${deltas} deltas -> ${ms.toFixed(1)}ms`)
          .join(", ")}`,
      );
    }),
  );

  it.effect("resume replay publishes one state per delta event", () =>
    Effect.gen(function* () {
      const deltas = 2000;
      const harness = yield* makeThreadSyncHarness({
        cached: baseThread,
        completionMarker: true,
      });

      // Wait for the cached thread to be published before starting the clock.
      yield* Queue.take(harness.observed).pipe(
        Effect.repeat({
          until: (state) => Option.isSome(state.data),
        }),
      );

      const startedAt = performance.now();
      const items: Array<OrchestrationThreadStreamItem> = Array.from(
        { length: deltas },
        (_, index) => ({
          kind: "event",
          event: streamingDeltaEvent(index, CACHED_SNAPSHOT_SEQUENCE + 1 + index),
        }),
      );
      yield* Queue.offerAll(harness.inputs, items);
      yield* Queue.offer(harness.inputs, { kind: "synchronized" });

      // Drain observed states until the replay has fully applied, counting
      // how many state publications subscribers had to process.
      let emissions = 0;
      let caughtUp = false;
      while (!caughtUp) {
        const state = yield* Queue.take(harness.observed);
        emissions += 1;
        // Model the renderer consuming each published state.
        if (Option.isSome(state.data)) {
          readFullText(state.data.value.messages[0]?.text ?? "");
        }
        caughtUp =
          state.status === "live" &&
          Option.isSome(state.data) &&
          (state.data.value.messages[0]?.text.length ?? 0) === deltas * CHUNK_TEXT.length;
      }
      const ms = performance.now() - startedAt;

      yield* Effect.log(
        `[threadReplayPerf] resume replay: ${deltas} deltas -> ${emissions} state emissions in ${ms.toFixed(1)}ms`,
      );

      // Drain-based batching in threads.ts must fold a replay backlog into
      // far fewer state publications than events; one publication per event
      // is the quadratic-reopen regression this test guards against.
      expect(emissions).toBeGreaterThanOrEqual(2);
      expect(emissions).toBeLessThan(deltas / 10);
    }),
  );
});
