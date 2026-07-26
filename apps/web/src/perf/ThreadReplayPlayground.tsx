import { Profiler, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LegendListRef } from "@legendapp/list/react";

import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationMessage,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/thread-reducer";

import { MessagesTimeline } from "../components/chat/MessagesTimeline";
import {
  deriveDisplayServerMessages,
  deriveRevertTurnCountByUserMessageId,
  deriveTimelineMessages,
  deriveTurnDiffSummaryByAssistantMessageId,
} from "../components/chat/threadTimelineModel";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../session-logic";

/**
 * Thread replay perf playground.
 *
 * Reproduces the "big chugging render" when a thread with a large backlog of
 * persisted streaming deltas is reopened: the client applies the replayed
 * `thread.message-sent` events one at a time, and every application publishes
 * a new thread state that re-runs the timeline derivation and re-renders the
 * streaming message's markdown.
 *
 * This page drives the real reducer (`applyThreadDetailEvent`), the real
 * derivation pipeline (`threadTimelineModel` + `deriveTimelineEntries`), and
 * the real `MessagesTimeline` component with synthetic events — no server,
 * no provider, no auth. Served by the web dev server at /perf.html.
 *
 * Query params:
 *   deltas  — number of streaming delta events to replay (default 2000)
 *   batch   — events applied per state publication (default 1 = today's
 *             behavior; raise to preview what client-side batching buys)
 *   history — settled message pairs present before the streaming one (default 8)
 *   code    — 1 to include code fences in the streamed markdown (default 1)
 *   auto    — 1 to start the replay on load
 */

const THREAD_ID = ThreadId.make("thread-perf");
const STREAMING_MESSAGE_ID = MessageId.make("msg-streaming");
const STREAMING_TURN_ID = TurnId.make("turn-perf");
const ENVIRONMENT_ID = EnvironmentId.make("environment-perf");
const BASE_TIME_MS = Date.parse("2026-04-01T00:00:00.000Z");

const isoAt = (offsetSeconds: number) =>
  new Date(BASE_TIME_MS + offsetSeconds * 1000).toISOString();

function chunkText(index: number, withCode: boolean): string {
  if (withCode && index % 40 === 12) {
    return "\n\n```ts\nconst step" + index + " = replay(" + index + ");\n```\n\n";
  }
  if (index % 23 === 0) {
    return "\n\nParagraph " + index + " of the streamed reply covers another detail. ";
  }
  return "token" + index + " lorem ipsum dolor sit amet ";
}

function historyMessage(pairIndex: number, role: "user" | "assistant"): OrchestrationMessage {
  const offset = pairIndex * 60 + (role === "user" ? 0 : 30);
  return {
    id: MessageId.make(`msg-history-${pairIndex}-${role}`),
    role,
    text:
      role === "user"
        ? `History question ${pairIndex}: how does step ${pairIndex} work?`
        : `History answer ${pairIndex} with some **markdown**, a list:\n\n- item one\n- item two\n\nand a fence:\n\n\`\`\`ts\nexport const answer${pairIndex} = ${pairIndex};\n\`\`\`\n`,
    turnId: role === "assistant" ? TurnId.make(`turn-history-${pairIndex}`) : null,
    streaming: false,
    createdAt: isoAt(offset),
    updatedAt: isoAt(offset),
  };
}

function makeBaseThread(historyPairs: number): OrchestrationThread {
  const messages: OrchestrationMessage[] = [];
  for (let index = 0; index < historyPairs; index += 1) {
    messages.push(historyMessage(index, "user"), historyMessage(index, "assistant"));
  }
  const startedAt = isoAt(historyPairs * 60);
  messages.push({
    id: MessageId.make("msg-final-user"),
    role: "user",
    text: "Please stream a very long answer.",
    turnId: null,
    streaming: false,
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-perf"),
    title: "Replay perf thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: STREAMING_TURN_ID,
      state: "running",
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      assistantMessageId: STREAMING_MESSAGE_ID,
    },
    createdAt: isoAt(0),
    updatedAt: startedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages,
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: STREAMING_TURN_ID,
      lastError: null,
      updatedAt: startedAt,
    },
  };
}

function makeDeltaEvents(count: number, historyPairs: number, withCode: boolean) {
  const streamStartSeconds = historyPairs * 60 + 5;
  return Array.from(
    { length: count },
    (_, index) =>
      ({
        eventId: EventId.make(`event-delta-${index}`),
        sequence: index + 1,
        occurredAt: isoAt(streamStartSeconds + index),
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
          text: chunkText(index, withCode),
          turnId: STREAMING_TURN_ID,
          streaming: true,
          createdAt: isoAt(streamStartSeconds),
          updatedAt: isoAt(streamStartSeconds + index),
        },
      }) as OrchestrationEvent,
  );
}

const macrotask = () =>
  new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });

interface ReplayStats {
  running: boolean;
  done: boolean;
  applied: number;
  totalDeltas: number;
  wallMs: number;
  commits: number;
  commitMs: number;
  longTasks: number;
  longTaskMs: number;
  maxStallMs: number;
}

const INITIAL_STATS: ReplayStats = {
  running: false,
  done: false,
  applied: 0,
  totalDeltas: 0,
  wallMs: 0,
  commits: 0,
  commitMs: 0,
  longTasks: 0,
  longTaskMs: 0,
  maxStallMs: 0,
};

function readParams() {
  const search = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number) => {
    const raw = Number(search.get(key));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
  };
  return {
    deltas: num("deltas", 2000),
    batch: num("batch", 1),
    history: num("history", 8),
    code: search.get("code") !== "0",
    auto: search.get("auto") === "1",
  };
}

function StatsPanel({ statsRef }: { statsRef: React.RefObject<ReplayStats> }) {
  const [snapshot, setSnapshot] = useState<ReplayStats>(INITIAL_STATS);
  useEffect(() => {
    const interval = window.setInterval(() => {
      setSnapshot({ ...statsRef.current });
    }, 250);
    return () => window.clearInterval(interval);
  }, [statsRef]);

  const s = snapshot;
  const status = s.running ? "replaying…" : s.done ? "done" : "idle";
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs text-muted-foreground">
      <span>status: {status}</span>
      <span>
        applied: {s.applied}/{s.totalDeltas}
      </span>
      <span>wall: {s.wallMs.toFixed(0)}ms</span>
      <span>react commits: {s.commits}</span>
      <span>commit time: {s.commitMs.toFixed(0)}ms</span>
      <span>
        long tasks: {s.longTasks} ({s.longTaskMs.toFixed(0)}ms)
      </span>
      <span>worst stall: {s.maxStallMs.toFixed(0)}ms</span>
    </div>
  );
}

const noop = () => {};

export function ThreadReplayPlayground() {
  const params = useMemo(readParams, []);
  const baseThread = useMemo(() => makeBaseThread(params.history), [params.history]);
  const [thread, setThread] = useState<OrchestrationThread>(baseThread);
  const listRef = useRef<LegendListRef | null>(null);
  const statsRef = useRef<ReplayStats>({ ...INITIAL_STATS, totalDeltas: params.deltas });
  const runningRef = useRef(false);

  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          statsRef.current.longTasks += 1;
          statsRef.current.longTaskMs += entry.duration;
        }
      });
      observer.observe({ entryTypes: ["longtask"] });
      return () => observer.disconnect();
    } catch {
      // Long task timing is unsupported in this browser (e.g. Firefox).
      return;
    }
  }, []);

  const runReplay = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    const stats = statsRef.current;
    Object.assign(stats, {
      ...INITIAL_STATS,
      running: true,
      totalDeltas: params.deltas,
    });
    setThread(baseThread);
    await macrotask();

    const events = makeDeltaEvents(params.deltas, params.history, params.code);
    const startedAt = performance.now();
    let current = baseThread;
    let previousTick = startedAt;
    for (let index = 0; index < events.length; index += params.batch) {
      for (let offset = 0; offset < params.batch && index + offset < events.length; offset += 1) {
        const result = applyThreadDetailEvent(
          current,
          events[index + offset] as OrchestrationEvent,
        );
        if (result.kind === "updated") {
          current = result.thread;
        }
      }
      stats.applied = Math.min(index + params.batch, events.length);
      setThread(current);
      // One macrotask per publication mirrors the one-event-at-a-time stream
      // apply in threads.ts and lets React commit between applications.
      await macrotask();
      const now = performance.now();
      stats.maxStallMs = Math.max(stats.maxStallMs, now - previousTick);
      previousTick = now;
      stats.wallMs = now - startedAt;
    }
    stats.wallMs = performance.now() - startedAt;
    stats.running = false;
    stats.done = true;
    runningRef.current = false;
  }, [baseThread, params]);

  useEffect(() => {
    if (params.auto) {
      void runReplay();
    }
  }, [params.auto, runReplay]);

  const onProfilerRender = useCallback((_id: string, _phase: string, actualDuration: number) => {
    statsRef.current.commits += 1;
    statsRef.current.commitMs += actualDuration;
  }, []);

  const environmentThread = useMemo(() => ({ ...thread, environmentId: ENVIRONMENT_ID }), [thread]);
  const displayServerMessages = useMemo(
    () => deriveDisplayServerMessages(environmentThread.messages, EMPTY_URL_MAP),
    [environmentThread.messages],
  );
  const timelineMessages = useMemo(
    () =>
      deriveTimelineMessages({
        displayServerMessages,
        attachmentPreviewHandoffByMessageId: EMPTY_HANDOFFS,
        optimisticUserMessages: EMPTY_MESSAGES,
      }),
    [displayServerMessages],
  );
  const workLogEntries = useMemo(
    () => deriveWorkLogEntries(environmentThread.activities),
    [environmentThread.activities],
  );
  const timelineEntries = useMemo(
    () => deriveTimelineEntries(timelineMessages, environmentThread.proposedPlans, workLogEntries),
    [environmentThread.proposedPlans, timelineMessages, workLogEntries],
  );
  const turnDiffSummaryByAssistantMessageId = useMemo(
    () => deriveTurnDiffSummaryByAssistantMessageId(environmentThread.checkpoints),
    [environmentThread.checkpoints],
  );
  const revertTurnCountByUserMessageId = useMemo(
    () =>
      deriveRevertTurnCountByUserMessageId({
        timelineEntries,
        turnDiffSummaryByAssistantMessageId,
        inferredCheckpointTurnCountByTurnId: EMPTY_TURN_COUNTS,
      }),
    [timelineEntries, turnDiffSummaryByAssistantMessageId],
  );

  return (
    <div className="flex h-screen flex-col gap-3 bg-background p-4 text-foreground">
      <div className="flex flex-wrap items-end gap-3">
        <h1 className="text-sm font-semibold">Thread replay playground</h1>
        <form method="get" className="flex flex-wrap items-end gap-2 text-xs">
          <label className="flex flex-col gap-1">
            deltas
            <input
              className="w-20 rounded border border-border bg-transparent px-1 py-0.5"
              name="deltas"
              defaultValue={params.deltas}
            />
          </label>
          <label className="flex flex-col gap-1">
            batch
            <input
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5"
              name="batch"
              defaultValue={params.batch}
            />
          </label>
          <label className="flex flex-col gap-1">
            history
            <input
              className="w-14 rounded border border-border bg-transparent px-1 py-0.5"
              name="history"
              defaultValue={params.history}
            />
          </label>
          <label className="flex flex-col gap-1">
            code
            <input
              className="w-10 rounded border border-border bg-transparent px-1 py-0.5"
              name="code"
              defaultValue={params.code ? "1" : "0"}
            />
          </label>
          <input type="hidden" name="auto" value="1" />
          <button className="rounded border border-border px-2 py-1 hover:bg-accent" type="submit">
            Run
          </button>
        </form>
      </div>
      <StatsPanel statsRef={statsRef} />
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border border-border">
        <Profiler id="messages-timeline" onRender={onProfilerRender}>
          <MessagesTimeline
            isWorking={true}
            activeTurnInProgress={true}
            activeTurnStartedAt={environmentThread.latestTurn?.startedAt ?? null}
            listRef={listRef}
            timelineEntries={timelineEntries}
            latestTurn={environmentThread.latestTurn}
            runningTurnId={
              environmentThread.session?.status === "running"
                ? environmentThread.session.activeTurnId
                : null
            }
            turnDiffSummaryByAssistantMessageId={turnDiffSummaryByAssistantMessageId}
            routeThreadKey="perf-thread"
            onOpenTurnDiff={noop}
            revertTurnCountByUserMessageId={revertTurnCountByUserMessageId}
            onRevertUserMessage={noop}
            isRevertingCheckpoint={false}
            onImageExpand={noop}
            activeThreadEnvironmentId={ENVIRONMENT_ID}
            markdownCwd={undefined}
            resolvedTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
            timestampFormat="locale"
            workspaceRoot={undefined}
            anchorMessageId={null}
            onAnchorReady={noop}
            onAnchorSizeChanged={noop}
            contentInsetEndAdjustment={0}
            onIsAtEndChange={noop}
            onManualNavigation={noop}
          />
        </Profiler>
      </div>
    </div>
  );
}

const EMPTY_URL_MAP: ReadonlyMap<string, string> = new Map();
const EMPTY_HANDOFFS: Record<string, string[]> = {};
const EMPTY_MESSAGES: ReadonlyArray<never> = [];
const EMPTY_TURN_COUNTS: Record<TurnId, number> = {};
