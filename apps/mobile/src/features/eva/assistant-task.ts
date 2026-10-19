import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { evaExtension } from "../../native/eva-extension";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentProjects } from "../../state/projects";
import { environmentThreadShells } from "../../state/threads";
import { assistantCatalogJson } from "./AssistantCatalogSync";
import {
  assistantMessageNoticeRow,
  assistantMessageRows,
  assistantModelNoticeRow,
  assistantModelRows,
  assistantQueueRows,
  assistantRequestNoticeRow,
  assistantRequestRows,
  assistantThreadStatusRow,
} from "./assistant-rows";
import {
  parseAssistantRequestJob,
  runAssistantRequest,
  type AssistantEnvironmentConnection,
  type DispatchOutcome,
  type PreparedWorkspace,
} from "./assistant-requests";
import {
  allAssistantEnvironmentsLive,
  connectAssistantEnvironment,
  enabledAssistantEnvironments,
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
const PROJECTION_TIMEOUT_MS = 5_000;
// Threads whose pending requests one cross-host listing reads.
const MAX_REQUEST_THREADS = 12;
const REQUEST_CONNECT_TIMEOUT_MS = 15_000;
// Headless tasks are cut off at 90 seconds; stop waiting before that and
// leave the request pending for a status poll to resume.
const REQUEST_DISPATCH_TIMEOUT_MS = 60_000;

const LIVE_QUERY_KINDS = ["messages", "models", "requests", "thread_status", "queue"] as const;
type LiveQueryKind = (typeof LIVE_QUERY_KINDS)[number];

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

function withTimeout<A>(promise: Promise<A>, timeoutMs: number, onTimeout: () => A): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<A>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const dispatchTimedOut = (): DispatchOutcome => ({
  kind: "transient",
  message: "The environment did not answer in time.",
});
const workspaceTimedOut = (): PreparedWorkspace => ({
  kind: "transient",
  message: "The environment did not prepare the checkout in time.",
});

function boundedProjection(
  environmentId: string,
  threadId: string,
): Promise<OrchestrationV2ThreadProjection | null> {
  return withTimeout(
    readThreadMessages(environmentId, threadId),
    PROJECTION_TIMEOUT_MS,
    () => null,
  );
}

/** A query may omit the environment; the cached thread shells know which one holds the thread. */
function environmentOfThread(threadId: string): Promise<string | null> {
  return waitForAtom(
    environmentThreadShells.threadShellsAtom,
    (threads) => threads.find((thread) => thread.id === threadId)?.environmentId ?? null,
    THREAD_LOOKUP_TIMEOUT_MS,
  );
}

function threadShell(environmentId: string, threadId: string): EnvironmentThreadShell | null {
  return (
    appAtomRegistry
      .get(environmentThreadShells.threadShellsAtom)
      .find((thread) => thread.environmentId === environmentId && thread.id === threadId) ?? null
  );
}

function projectName(environmentId: string, projectId: string): string {
  return (
    appAtomRegistry
      .get(environmentProjects.projectsAtom)
      .find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title ?? ""
  );
}

function unreachable(connection: Exclude<AssistantEnvironmentConnection, { kind: "connected" }>) {
  return connection.kind === "unknown_environment"
    ? "T3 Code has no environment with that ID."
    : "That environment is not connected; ask again in a moment.";
}

type ThreadTarget =
  | {
      readonly kind: "ready";
      readonly environmentId: string;
      readonly environmentName: string;
      readonly threadId: string;
    }
  | { readonly kind: "unavailable"; readonly message: string };

/** Connects the environment holding one thread, finding it when the query omits it. */
async function connectThread(
  hold: AssistantRuntimeHold,
  params: QueryParams,
): Promise<ThreadTarget | null> {
  const threadId = text(params.threadId);
  if (threadId === null) return null;
  const environmentId = text(params.environmentId) ?? (await environmentOfThread(threadId));
  if (environmentId === null) {
    return { kind: "unavailable", message: "T3 Code does not know that thread." };
  }
  const connection = await connectAssistantEnvironment(
    hold,
    environmentId,
    QUERY_CONNECT_TIMEOUT_MS,
  );
  if (connection.kind !== "connected") {
    return { kind: "unavailable", message: unreachable(connection) };
  }
  return {
    kind: "ready",
    environmentId,
    environmentName: connection.environment.environmentName,
    threadId,
  };
}

async function answerMessages(hold: AssistantRuntimeHold, params: QueryParams) {
  const threadId = text(params.threadId);
  if (threadId === null) return [];
  const notice = (message: string) => [
    assistantMessageNoticeRow({
      environmentId: text(params.environmentId),
      threadId,
      text: message,
    }),
  ];
  const target = await connectThread(hold, params);
  if (target === null) return [];
  if (target.kind === "unavailable") return notice(target.message);
  const projection = await readThreadMessages(target.environmentId, threadId);
  if (projection === null)
    return notice("T3 Code could not read that thread; try again in a moment.");
  return assistantMessageRows({
    environmentId: target.environmentId,
    environmentName: target.environmentName,
    threadId,
    threadTitle: threadShell(target.environmentId, threadId)?.title ?? "",
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
    return [assistantModelNoticeRow(environmentId, unreachable(connection))];
  }
  return assistantModelRows({
    environmentId,
    environmentName: connection.environment.environmentName,
    providers: connection.environment.providers(),
    provider: text(params.provider),
    q: text(params.q),
  });
}

/**
 * Pending approvals and questions, across every enabled environment unless the
 * query names one. A host that cannot be reached is a notice row, not silence.
 */
async function answerRequests(hold: AssistantRuntimeHold, params: QueryParams) {
  const threadId = text(params.threadId);
  let environmentId = text(params.environmentId);
  if (environmentId === null && threadId !== null) {
    environmentId = await environmentOfThread(threadId);
    if (environmentId === null) {
      return [
        assistantRequestNoticeRow({
          environmentId: "",
          environmentName: "",
          threadId,
          detail: "T3 Code does not know that thread.",
        }),
      ];
    }
  }
  const environmentIds =
    environmentId === null
      ? await enabledAssistantEnvironments(QUERY_CONNECT_TIMEOUT_MS)
      : [environmentId];
  const connections = await Promise.all(
    environmentIds.map(async (id) => ({
      id,
      connection: await connectAssistantEnvironment(hold, id, QUERY_CONNECT_TIMEOUT_MS),
    })),
  );
  const notices = [];
  const names = new Map<string, string>();
  for (const { id, connection } of connections) {
    if (connection.kind === "connected") {
      names.set(id, connection.environment.environmentName);
      continue;
    }
    const name = connection.kind === "unknown_environment" ? "" : connection.environmentName;
    notices.push(
      assistantRequestNoticeRow({
        environmentId: id,
        environmentName: name,
        detail:
          connection.kind === "unknown_environment"
            ? "T3 Code has no environment with that ID."
            : `${name || "This environment"} is not connected, so its requests are not listed.`,
      }),
    );
  }
  const waiting = appAtomRegistry
    .get(environmentThreadShells.threadShellsAtom)
    .filter(
      (thread) =>
        names.has(thread.environmentId) &&
        (threadId === null || thread.id === threadId) &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        (threadId !== null || thread.hasPendingApprovals || thread.hasPendingUserInput),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_REQUEST_THREADS);
  const rows = await Promise.all(
    waiting.map(async (thread) => {
      const context = {
        environmentId: thread.environmentId,
        environmentName: names.get(thread.environmentId) ?? "",
        thread,
      };
      const projection = await boundedProjection(thread.environmentId, thread.id);
      return projection === null
        ? [
            assistantRequestNoticeRow({
              ...context,
              threadId: thread.id,
              detail: `T3 Code could not read “${thread.title}” in time; ask again in a moment.`,
            }),
          ]
        : assistantRequestRows(context, projection);
    }),
  );
  return [...rows.flat(), ...notices];
}

async function answerThreadStatus(hold: AssistantRuntimeHold, params: QueryParams) {
  const target = await connectThread(hold, params);
  if (target === null) return [];
  const notice = (message: string) => [
    {
      id: text(params.threadId),
      environmentId: text(params.environmentId) ?? "",
      status: "notice",
      note: message,
    },
  ];
  if (target.kind === "unavailable") return notice(target.message);
  const thread = threadShell(target.environmentId, target.threadId);
  if (thread === null) return notice("That thread is not in this environment.");
  const projection = await boundedProjection(target.environmentId, target.threadId);
  if (projection === null)
    return notice("T3 Code could not read that thread; try again in a moment.");
  return [
    assistantThreadStatusRow({
      environmentId: target.environmentId,
      environmentName: target.environmentName,
      projectName: projectName(target.environmentId, thread.projectId),
      thread,
      projection,
      now: new Date(),
    }),
  ];
}

async function answerQueue(hold: AssistantRuntimeHold, params: QueryParams) {
  const target = await connectThread(hold, params);
  if (target === null) return [];
  const notice = (message: string) => [
    {
      runId: "notice",
      environmentId: text(params.environmentId) ?? "",
      threadId: text(params.threadId),
      text: message,
    },
  ];
  if (target.kind === "unavailable") return notice(target.message);
  const thread = threadShell(target.environmentId, target.threadId);
  if (thread === null) return notice("That thread is not in this environment.");
  const projection = await boundedProjection(target.environmentId, target.threadId);
  if (projection === null)
    return notice("T3 Code could not read that thread; try again in a moment.");
  return assistantQueueRows(
    { environmentId: target.environmentId, environmentName: target.environmentName, thread },
    projection,
  );
}

const ANSWERS: Record<
  LiveQueryKind,
  (hold: AssistantRuntimeHold, params: QueryParams) => Promise<ReadonlyArray<unknown>>
> = {
  messages: answerMessages,
  models: answerModels,
  requests: answerRequests,
  thread_status: answerThreadStatus,
  queue: answerQueue,
};

/**
 * Refreshes the published catalog while this headless run has every
 * environment live, so threads created or renamed since the UI last ran show
 * up in the catalog tables.
 */
function republishCatalog(): void {
  const native = evaExtension;
  if (!native || !allAssistantEnvironmentsLive()) return;
  try {
    native.publishAssistantCatalog(assistantCatalogJson());
  } catch (error) {
    console.warn("[eva] Could not publish the assistant catalog", error);
  }
}

async function answerQuery(
  kind: LiveQueryKind,
  requestId: string,
  rawParams: string,
): Promise<void> {
  if (!evaExtension) return;
  const hold = holdAssistantRuntime();
  let rows: ReadonlyArray<unknown>;
  try {
    rows = await ANSWERS[kind](hold, JSON.parse(rawParams) as QueryParams);
  } catch {
    rows = [];
  }
  evaExtension.resolveAssistantQuery(requestId, JSON.stringify({ rows }));
  republishCatalog();
  hold.release();
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
        const bounded = <A>(promise: Promise<A>, onTimeout: () => A) =>
          withTimeout(promise, REQUEST_DISPATCH_TIMEOUT_MS, onTimeout);
        return {
          kind: "connected",
          environment: {
            ...environment,
            prepareWorkspace: (request) =>
              bounded(environment.prepareWorkspace(request), workspaceTimedOut),
            startThread: (plan) => bounded(environment.startThread(plan), dispatchTimedOut),
            sendMessage: (plan) => bounded(environment.sendMessage(plan), dispatchTimedOut),
            dispatchThreadAction: (plan) =>
              bounded(environment.dispatchThreadAction(plan), dispatchTimedOut),
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
    republishCatalog();
    hold.release();
    native.finishAssistantRequest(job.key);
  }
}

function isLiveQueryKind(value: unknown): value is LiveQueryKind {
  return (LIVE_QUERY_KINDS as ReadonlyArray<unknown>).includes(value);
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
    isLiveQueryKind(task.kind) &&
    typeof task.requestId === "string" &&
    typeof task.params === "string"
  ) {
    await answerQuery(task.kind, task.requestId, task.params);
  }
}
