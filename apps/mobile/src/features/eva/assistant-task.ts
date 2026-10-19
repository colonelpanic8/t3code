import * as DateTime from "effect/DateTime";

import { evaExtension } from "../../native/eva-extension";
import { environmentThreadShells } from "../../state/threads";
import {
  assistantMessageNoticeRow,
  assistantMessageRows,
  assistantModelNoticeRow,
  assistantModelRows,
} from "./assistant-rows";
import {
  parseAssistantRequestJob,
  runAssistantRequest,
  type DispatchOutcome,
} from "./assistant-requests";
import {
  connectAssistantEnvironment,
  holdAssistantRuntime,
  readThreadMessages,
  waitForAtom,
  type AssistantRuntimeHold,
} from "./assistant-runtime";

export const ASSISTANT_TASK_KEY = "T3EvaAssistantTask";

// The provider parks its binder thread for 17 seconds; a cold start spends
// part of that loading JavaScript.
const QUERY_CONNECT_TIMEOUT_MS = 9_000;
const THREAD_LOOKUP_TIMEOUT_MS = 3_000;
const REQUEST_CONNECT_TIMEOUT_MS = 15_000;
// Headless tasks are cut off at 90 seconds; stop waiting before that and
// leave the request pending for a status poll to resume.
const REQUEST_DISPATCH_TIMEOUT_MS = 60_000;

interface QueryParams {
  readonly environmentId?: unknown;
  readonly threadId?: unknown;
  readonly provider?: unknown;
  readonly q?: unknown;
  readonly limit?: unknown;
}

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;
const limitOf = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;

function withTimeout(
  promise: Promise<DispatchOutcome>,
  timeoutMs: number,
): Promise<DispatchOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DispatchOutcome>((resolve) => {
    timer = setTimeout(
      () => resolve({ kind: "transient", message: "The environment did not answer in time." }),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A query may omit the environment; the cached thread shells know which one holds the thread. */
function environmentOfThread(threadId: string): Promise<string | null> {
  return waitForAtom(
    environmentThreadShells.threadShellsAtom,
    (threads) => threads.find((thread) => thread.id === threadId)?.environmentId ?? null,
    THREAD_LOOKUP_TIMEOUT_MS,
  );
}

async function answerMessages(hold: AssistantRuntimeHold, params: QueryParams) {
  const threadId = text(params.threadId);
  const requestedEnvironmentId = text(params.environmentId);
  if (threadId === null) return [];
  const notice = (message: string) => [
    assistantMessageNoticeRow({ environmentId: requestedEnvironmentId, threadId, text: message }),
  ];
  const environmentId = requestedEnvironmentId ?? (await environmentOfThread(threadId));
  if (environmentId === null) return notice("T3 Code does not know that thread.");
  const connection = await connectAssistantEnvironment(
    hold,
    environmentId,
    QUERY_CONNECT_TIMEOUT_MS,
  );
  if (connection.kind !== "connected") {
    return notice(
      connection.kind === "unknown_environment"
        ? "T3 Code has no environment with that ID."
        : "The thread's environment is not connected; ask again in a moment.",
    );
  }
  const projection = await readThreadMessages(environmentId, threadId);
  if (projection === null)
    return notice("T3 Code could not read that thread; try again in a moment.");
  return assistantMessageRows({
    environmentId,
    environmentName: connection.environment.environmentName,
    threadId,
    threadTitle: connection.environment.thread(threadId)?.title ?? "",
    messages: projection.messages.map((message) => ({
      id: message.id,
      role: message.role,
      text: message.text,
      createdAt: DateTime.formatIso(message.createdAt),
    })),
    limit: limitOf(params.limit, 10),
  });
}

async function answerModels(hold: AssistantRuntimeHold, params: QueryParams) {
  const environmentId = text(params.environmentId);
  if (environmentId === null) return [];
  const connection = await connectAssistantEnvironment(
    hold,
    environmentId,
    QUERY_CONNECT_TIMEOUT_MS,
  );
  if (connection.kind !== "connected") {
    return [
      assistantModelNoticeRow(
        environmentId,
        connection.kind === "unknown_environment"
          ? "T3 Code has no environment with that ID."
          : "That environment is not connected; ask again in a moment.",
      ),
    ];
  }
  return assistantModelRows({
    environmentId,
    environmentName: connection.environment.environmentName,
    providers: connection.environment.providers(),
    provider: text(params.provider),
    q: text(params.q),
  });
}

async function answerQuery(
  kind: "messages" | "models",
  requestId: string,
  rawParams: string,
): Promise<void> {
  if (!evaExtension) return;
  const hold = holdAssistantRuntime();
  let rows: ReadonlyArray<unknown>;
  try {
    const params = JSON.parse(rawParams) as QueryParams;
    rows =
      kind === "messages" ? await answerMessages(hold, params) : await answerModels(hold, params);
  } catch {
    rows = [];
  } finally {
    hold.release();
  }
  evaExtension.resolveAssistantQuery(requestId, JSON.stringify({ rows }));
}

async function runRequest(raw: unknown): Promise<void> {
  const native = evaExtension;
  const job = parseAssistantRequestJob(raw);
  if (!native || !job) return;
  const hold = holdAssistantRuntime();
  try {
    await runAssistantRequest(job, {
      connect: async (environmentId) => {
        const connection = await connectAssistantEnvironment(
          hold,
          environmentId,
          REQUEST_CONNECT_TIMEOUT_MS,
        );
        if (connection.kind !== "connected") return connection;
        const { environment } = connection;
        return {
          kind: "connected",
          environment: {
            ...environment,
            startThread: (plan) =>
              withTimeout(environment.startThread(plan), REQUEST_DISPATCH_TIMEOUT_MS),
            sendMessage: (plan) =>
              withTimeout(environment.sendMessage(plan), REQUEST_DISPATCH_TIMEOUT_MS),
          },
        };
      },
      report: async (update) => {
        const stored = await native.reportAssistantRequest(job.key, JSON.stringify(update));
        return stored === null ? null : JSON.parse(stored);
      },
      now: () => new Date(),
    });
  } finally {
    hold.release();
    native.finishAssistantRequest(job.key);
  }
}

/**
 * Headless JS task native code starts for assistant work. It runs whether or
 * not any screen is mounted, so it must not depend on React state.
 */
export async function runAssistantTask(data: unknown): Promise<void> {
  if (typeof data !== "object" || data === null) return;
  const task = data as Record<string, unknown>;
  if (task.kind === "request") {
    await runRequest(task);
    return;
  }
  if (
    (task.kind === "messages" || task.kind === "models") &&
    typeof task.requestId === "string" &&
    typeof task.params === "string"
  ) {
    await answerQuery(task.kind, task.requestId, task.params);
  }
}
