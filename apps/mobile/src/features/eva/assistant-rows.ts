import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  deriveThreadQueueWorkflowState,
  resolveActiveThreadRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import type { OrchestrationV2ThreadProjection, ServerProvider } from "@t3tools/contracts";

import { threadLastActivityAt, threadStatus } from "./assistant-catalog";
import { describeModelOptions } from "./assistant-models";
import { approvalChoices, describeQuestion } from "./assistant-thread-actions";

const MAX_TEXT_LENGTH = 1000;
const ELLIPSIS = "…";

export interface AssistantMessageRow {
  readonly id: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly role: string;
  readonly createdAt: string | null;
  readonly text: string;
}

export interface AssistantModelRow {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly provider: string;
  readonly providerLabel: string;
  readonly status: string;
  readonly model: string;
  readonly modelLabel: string;
  readonly isDefault: number;
  readonly options: string;
  readonly note: string;
}

interface ThreadMessage {
  readonly id: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

function clipText(text: string, max = MAX_TEXT_LENGTH): string {
  const trimmed = text.trim();
  const chars = Array.from(trimmed);
  return chars.length <= max
    ? trimmed
    : `${chars.slice(0, max - ELLIPSIS.length).join("")}${ELLIPSIS}`;
}

/** The newest user and assistant messages of one thread, most recent first. */
export function assistantMessageRows(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly messages: ReadonlyArray<ThreadMessage>;
  readonly limit: number;
}): ReadonlyArray<AssistantMessageRow> {
  return input.messages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") && message.text.trim() !== "",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, input.limit)
    .map((message) => ({
      id: message.id,
      environmentId: input.environmentId,
      environmentName: input.environmentName,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      role: message.role,
      createdAt: message.createdAt,
      text: clipText(message.text),
    }));
}

export function assistantMessageNoticeRow(input: {
  readonly environmentId: string | null;
  readonly threadId: string;
  readonly text: string;
}): AssistantMessageRow {
  return {
    id: "notice",
    environmentId: input.environmentId ?? "",
    environmentName: "",
    threadId: input.threadId,
    threadTitle: "",
    role: "notice",
    createdAt: null,
    text: input.text,
  };
}

/**
 * One row per selectable model. A provider with nothing selectable is one row
 * with an empty model and the reason in note.
 */
export function assistantModelRows(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly provider: string | null;
  readonly q: string | null;
}): ReadonlyArray<AssistantModelRow> {
  const query = input.q?.toLowerCase() ?? null;
  const rows: AssistantModelRow[] = [];
  for (const provider of input.providers) {
    if (input.provider !== null && provider.instanceId !== input.provider) continue;
    const base = {
      environmentId: input.environmentId,
      environmentName: input.environmentName,
      provider: provider.instanceId,
      providerLabel: provider.displayName ?? provider.driver,
      status: provider.enabled ? provider.status : "disabled",
    };
    if (!provider.enabled || provider.models.length === 0) {
      rows.push({
        ...base,
        model: "",
        modelLabel: "",
        isDefault: 0,
        options: "",
        note: provider.enabled ? "This provider offers no models." : "This provider is turned off.",
      });
      continue;
    }
    for (const model of provider.models) {
      rows.push({
        ...base,
        model: model.slug,
        modelLabel: model.name,
        isDefault: model.isDefault ? 1 : 0,
        options: describeModelOptions(model),
        note: provider.message ?? "",
      });
    }
  }
  if (query === null) return rows;
  return rows.filter((row) =>
    [row.provider, row.providerLabel, row.model, row.modelLabel].some((value) =>
      value.toLowerCase().includes(query),
    ),
  );
}

export function assistantModelNoticeRow(environmentId: string, note: string): AssistantModelRow {
  return {
    environmentId,
    environmentName: "",
    provider: "",
    providerLabel: "",
    status: "notice",
    model: "",
    modelLabel: "",
    isDefault: 0,
    options: "",
    note,
  };
}

interface ThreadContext {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly thread: Pick<EnvironmentThreadShell, "id" | "title">;
}

export interface AssistantRequestRow {
  readonly requestId: string;
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId: string;
  readonly threadTitle: string;
  /** approval, question, or notice. */
  readonly kind: string;
  readonly requestKind: string;
  readonly createdAt: string;
  readonly detail: string;
  readonly decisions: string;
  readonly questions: string;
  readonly answerable: number;
  readonly dismissible: number;
}

/** A thread's pending approvals and questions, oldest first, as EVA reads and answers them. */
export function assistantRequestRows(
  context: ThreadContext,
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): ReadonlyArray<AssistantRequestRow> {
  const pending = derivePendingThreadRequests(projection);
  const base = {
    environmentId: context.environmentId,
    environmentName: context.environmentName,
    threadId: context.thread.id,
    threadTitle: context.thread.title,
  };
  const approvals = pending.approvals.map((approval): AssistantRequestRow => ({
    ...base,
    requestId: approval.requestId,
    kind: "approval",
    requestKind: approval.requestKind,
    createdAt: approval.createdAt,
    detail: clipText(
      [approval.appName, approval.detail].filter((part) => part !== undefined).join(": "),
    ),
    decisions: approvalChoices(approval.options)
      .map((choice) => `${choice.choice} (${choice.label})`)
      .join(", "),
    questions: "",
    answerable: approval.responseCapability === "live" ? 1 : 0,
    dismissible: 0,
  }));
  const questions = pending.userInputs.map((request): AssistantRequestRow => ({
    ...base,
    requestId: request.requestId,
    kind: "question",
    requestKind: "user_input",
    createdAt: request.createdAt,
    detail: clipText(request.questions.map((question) => question.question).join(" ")),
    decisions: "",
    questions: clipText(request.questions.map(describeQuestion).join(". "), 2 * MAX_TEXT_LENGTH),
    answerable: request.responseCapability === "not_resumable" ? 0 : 1,
    dismissible: request.dismissible ? 1 : 0,
  }));
  return [...approvals, ...questions].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}

export function assistantRequestNoticeRow(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly threadId?: string;
  readonly detail: string;
}): AssistantRequestRow {
  return {
    requestId: "notice",
    environmentId: input.environmentId,
    environmentName: input.environmentName,
    threadId: input.threadId ?? "",
    threadTitle: "",
    kind: "notice",
    requestKind: "",
    createdAt: "",
    detail: input.detail,
    decisions: "",
    questions: "",
    answerable: 0,
    dismissible: 0,
  };
}

type StatusThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "branch"
  | "worktreePath"
  | "modelSelection"
  | "runtimeMode"
  | "interactionMode"
  | "runtime"
  | "latestRun"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "latestUserMessageAt"
  | "updatedAt"
  | "pinnedAt"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "snoozedUntil"
>;

/** One thread's live state: what it is doing, what waits on the user, and what it said last. */
export function assistantThreadStatusRow(input: {
  readonly environmentId: string;
  readonly environmentName: string;
  readonly projectName: string;
  readonly thread: StatusThread;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly now: Date;
}) {
  const { thread, projection } = input;
  const pending = derivePendingThreadRequests(projection);
  const queue = deriveThreadQueueWorkflowState(projection);
  const lastAssistant = projection.messages.findLast(
    (message) => message.role === "assistant" && message.text.trim() !== "",
  );
  const snoozed =
    thread.snoozedUntil !== null && Date.parse(thread.snoozedUntil) > input.now.getTime()
      ? thread.snoozedUntil
      : "";
  return {
    id: thread.id,
    environmentId: input.environmentId,
    environmentName: input.environmentName,
    projectId: thread.projectId,
    projectName: input.projectName,
    title: thread.title,
    status:
      pending.approvals.length > 0 || pending.userInputs.length > 0
        ? "needs_input"
        : threadStatus(thread),
    activeRunStatus: resolveActiveThreadRun(projection)?.status ?? "",
    queuedCount: queue.queuedRuns.length,
    pendingApprovals: pending.approvals.length,
    pendingQuestions: pending.userInputs.length,
    branch: thread.branch ?? "",
    worktreePath: thread.worktreePath ?? "",
    provider: thread.modelSelection.instanceId,
    model: thread.modelSelection.model,
    modelOptions: (thread.modelSelection.options ?? [])
      .map((option) => `${option.id}=${String(option.value)}`)
      .join(","),
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    pinned: thread.pinnedAt === null ? 0 : 1,
    archived: thread.archivedAt === null ? 0 : 1,
    settled: thread.settledOverride === "settled" ? 1 : 0,
    snoozedUntil: snoozed,
    lastActivityAt: threadLastActivityAt(thread),
    lastAssistantMessage: lastAssistant ? clipText(lastAssistant.text) : "",
    note: queue.isHeld ? "The queue is held until the user resumes it in T3 Code." : "",
  };
}

/** A thread's queued messages in the order they will send. */
export function assistantQueueRows(
  context: ThreadContext,
  projection: OrchestrationV2ThreadProjection,
) {
  const workflow = deriveThreadQueueWorkflowState(projection);
  return workflow.queuedRuns.map((queued, index) => ({
    runId: queued.run.id,
    environmentId: context.environmentId,
    environmentName: context.environmentName,
    threadId: context.thread.id,
    threadTitle: context.thread.title,
    position: index + 1,
    text: clipText(queued.text),
    held: queued.run.queueHeld === true ? 1 : 0,
    canSteer: workflow.activeRun !== null && workflow.canPromoteToSteer ? 1 : 0,
  }));
}
