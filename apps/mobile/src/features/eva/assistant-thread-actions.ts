import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  derivePendingThreadRequests,
  type ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import { snoozeWakeLabel } from "@t3tools/client-runtime/state/thread-settled";
import {
  deriveThreadQueueWorkflowState,
  resolveActiveThreadRun,
} from "@t3tools/client-runtime/state/thread-workflows";
import {
  ProviderApprovalDecision,
  ProviderInteractionMode,
  RuntimeMode,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { assistantRequestIds } from "./assistant-ids";
import {
  findProviderModel,
  ModelSelectionPlan,
  parseModelOptions,
  resolveModelSelection,
} from "./assistant-models";
import { done, stop } from "./assistant-outcome";

export const THREAD_ACTION_OPERATIONS = [
  "interrupt_thread",
  "organize_thread",
  "respond_to_approval",
  "answer_question",
  "dismiss_question",
  "rename_thread",
  "configure_thread",
  "fork_thread",
  "manage_queued_message",
] as const;
export type ThreadActionOperation = (typeof THREAD_ACTION_OPERATIONS)[number];

export function isThreadActionOperation(value: unknown): value is ThreadActionOperation {
  return (THREAD_ACTION_OPERATIONS as ReadonlyArray<unknown>).includes(value);
}

const OrganizeAction = Schema.Literals([
  "pin",
  "unpin",
  "snooze",
  "unsnooze",
  "settle",
  "unsettle",
  "archive",
  "unarchive",
  "mark_unread",
]);
type OrganizeAction = typeof OrganizeAction.Type;

const ApprovalChoice = Schema.Literals([
  "accept",
  "accept_for_session",
  "accept_always",
  "decline",
  "cancel",
]);

const QueueAction = Schema.Literals(["remove", "steer"]);

const Target = { environmentId: Schema.String, threadId: Schema.String };

const ArgumentSchemas = {
  interrupt_thread: Schema.Struct(Target),
  organize_thread: Schema.Struct({
    ...Target,
    action: OrganizeAction,
    snoozeMinutes: Schema.optional(Schema.Number),
    snoozeUntil: Schema.optional(Schema.String),
  }),
  respond_to_approval: Schema.Struct({
    ...Target,
    requestId: Schema.String,
    decision: ApprovalChoice,
  }),
  answer_question: Schema.Struct({
    ...Target,
    requestId: Schema.String,
    answer: Schema.optional(Schema.String),
    answersJson: Schema.optional(Schema.String),
  }),
  dismiss_question: Schema.Struct({ ...Target, requestId: Schema.String }),
  rename_thread: Schema.Struct({ ...Target, title: Schema.String }),
  configure_thread: Schema.Struct({
    ...Target,
    provider: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    modelOptions: Schema.optional(Schema.String),
    runtimeMode: Schema.optional(RuntimeMode),
    interactionMode: Schema.optional(ProviderInteractionMode),
  }),
  fork_thread: Schema.Struct({ ...Target, title: Schema.optional(Schema.String) }),
  manage_queued_message: Schema.Struct({
    ...Target,
    runId: Schema.String,
    action: QueueAction,
  }),
} as const;

const PlanBase = {
  environmentId: Schema.String,
  threadId: Schema.String,
  commandId: Schema.String,
  /** Read out when the request completes. */
  summary: Schema.String,
};

const AnswerValue = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

export const ThreadActionPlan = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("interrupt_thread"),
    ...PlanBase,
    runId: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("organize_thread"),
    ...PlanBase,
    action: OrganizeAction,
    snoozedUntil: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("respond_to_approval"),
    ...PlanBase,
    requestId: Schema.String,
    decision: ProviderApprovalDecision,
  }),
  Schema.Struct({
    kind: Schema.Literal("answer_question"),
    ...PlanBase,
    requestId: Schema.String,
    answers: Schema.Record(Schema.String, AnswerValue),
  }),
  Schema.Struct({
    kind: Schema.Literal("dismiss_question"),
    ...PlanBase,
    requestId: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("rename_thread"), ...PlanBase, title: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("configure_thread"),
    ...PlanBase,
    modelSelection: Schema.NullOr(ModelSelectionPlan),
    runtimeMode: Schema.NullOr(RuntimeMode),
    interactionMode: Schema.NullOr(ProviderInteractionMode),
  }),
  Schema.Struct({
    kind: Schema.Literal("fork_thread"),
    ...PlanBase,
    targetThreadId: Schema.String,
    runId: Schema.String,
    title: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("manage_queued_message"),
    ...PlanBase,
    runId: Schema.String,
    action: QueueAction,
    targetRunId: Schema.NullOr(Schema.String),
  }),
]);
export type ThreadActionPlan = typeof ThreadActionPlan.Type;
export type ThreadActionPlanOf<K extends ThreadActionPlan["kind"]> = Extract<
  ThreadActionPlan,
  { readonly kind: K }
>;

/** What planning reads from one connected environment. */
export interface ThreadActionEnvironment {
  readonly environmentName: string;
  thread(threadId: string): EnvironmentThreadShell | null;
  providers(): ReadonlyArray<ServerProvider>;
  /** Null when the environment did not answer; planning retries on the next status poll. */
  threadProjection(threadId: string): Promise<OrchestrationV2ThreadProjection | null>;
}

interface PlanInput {
  readonly key: string;
  readonly environment: ThreadActionEnvironment;
  readonly now: Date;
}

const argumentDecoders = Object.fromEntries(
  Object.entries(ArgumentSchemas).map(([operation, schema]) => [
    operation,
    Schema.decodeUnknownOption(schema as Schema.Codec<unknown>),
  ]),
) as Record<
  ThreadActionOperation,
  (raw: unknown) => ReturnType<ReturnType<typeof Schema.decodeUnknownOption>>
>;

function decodeArguments<O extends ThreadActionOperation>(operation: O, raw: unknown) {
  const decoded = argumentDecoders[operation](raw);
  if (decoded._tag === "None") {
    throw stop("rejected", "invalid_arguments", "T3 Code could not read the saved request.");
  }
  return decoded.value as (typeof ArgumentSchemas)[O]["Type"];
}

function shellOf(environment: ThreadActionEnvironment, threadId: string): EnvironmentThreadShell {
  const thread = environment.thread(threadId);
  if (!thread || thread.deletedAt !== null) {
    throw stop("rejected", "unknown_thread", "That thread is not in this environment.");
  }
  return thread;
}

async function projectionOf(
  environment: ThreadActionEnvironment,
  threadId: string,
): Promise<OrchestrationV2ThreadProjection> {
  const projection = await environment.threadProjection(threadId);
  // Left pending rather than closed: a status poll plans it again.
  if (projection === null) throw new Error("The environment did not return the thread.");
  return projection;
}

function nameOf(thread: Pick<EnvironmentThreadShell, "title"> | null): string {
  const title = thread?.title.trim() ?? "";
  return title === "" ? "the thread" : `“${title}”`;
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function onEnvironment(environment: ThreadActionEnvironment): string {
  return environment.environmentName === "" ? "" : ` on ${environment.environmentName}`;
}

const ORGANIZE_VERBS: Record<OrganizeAction, string> = {
  pin: "Pinned",
  unpin: "Unpinned",
  snooze: "Snoozed",
  unsnooze: "Woke",
  settle: "Settled",
  unsettle: "Reopened",
  archive: "Archived",
  unarchive: "Unarchived",
  mark_unread: "Marked unread",
};

/** Null when the thread already is as asked. */
function organizeAlreadyDone(
  action: OrganizeAction,
  thread: EnvironmentThreadShell,
  now: Date,
): string | null {
  switch (action) {
    case "pin":
      return thread.pinnedAt !== null ? "already pinned" : null;
    case "unpin":
      return thread.pinnedAt === null ? "not pinned" : null;
    case "unsnooze":
      return thread.snoozedUntil === null || Date.parse(thread.snoozedUntil) <= now.getTime()
        ? "not snoozed"
        : null;
    case "settle":
      return thread.settledOverride === "settled" ? "already settled" : null;
    case "unsettle":
      return thread.settledOverride !== "settled" ? "not settled" : null;
    case "archive":
      return thread.archivedAt !== null ? "already archived" : null;
    case "unarchive":
      return thread.archivedAt === null ? "not archived" : null;
    case "snooze":
    case "mark_unread":
      return null;
  }
}

function snoozeTarget(args: { snoozeMinutes?: number; snoozeUntil?: string }, now: Date): string {
  if (args.snoozeMinutes !== undefined) {
    return new Date(now.getTime() + args.snoozeMinutes * 60_000).toISOString();
  }
  const until = Date.parse(args.snoozeUntil ?? "");
  if (Number.isNaN(until)) {
    throw stop("rejected", "invalid_snooze", "snoozeUntil is not an ISO 8601 date-time.");
  }
  if (until <= now.getTime()) {
    throw stop("rejected", "invalid_snooze", "snoozeUntil is in the past.");
  }
  return new Date(until).toISOString();
}

const APPROVAL_DECISIONS: Record<typeof ApprovalChoice.Type, ProviderApprovalDecision> = {
  accept: "accept",
  accept_for_session: "acceptForSession",
  accept_always: "acceptAlways",
  decline: "decline",
  cancel: "cancel",
};

const APPROVAL_VERBS: Record<ProviderApprovalDecision, string> = {
  accept: "Approved",
  acceptForSession: "Approved for the session",
  acceptAlways: "Always approved",
  decline: "Declined",
  cancel: "Declined and stopped",
};

/** The wire choices EVA may send for an approval, in its own vocabulary. */
export function approvalChoices(
  options:
    | ReadonlyArray<{ readonly decision: ProviderApprovalDecision; readonly label: string }>
    | undefined,
): ReadonlyArray<{ readonly choice: string; readonly label: string }> {
  const byDecision = new Map(
    Object.entries(APPROVAL_DECISIONS).map(([choice, decision]) => [decision, choice]),
  );
  if (options === undefined || options.length === 0) {
    return [
      { choice: "accept", label: "Allow once" },
      { choice: "accept_for_session", label: "Allow for this session" },
      { choice: "decline", label: "Deny" },
      { choice: "cancel", label: "Deny and stop the turn" },
    ];
  }
  return options.map((option) => ({
    choice: byDecision.get(option.decision) ?? option.decision,
    label: option.label,
  }));
}

const normalize = (value: string) => value.trim().toLowerCase();

function optionValue(option: ThreadUserInputQuestion["options"][number]): string {
  return option.value ?? option.label;
}

function matchOption(question: ThreadUserInputQuestion, raw: string): string | null {
  const wanted = normalize(raw);
  const match = question.options.find(
    (option) =>
      normalize(option.label) === wanted ||
      (option.value !== undefined && normalize(option.value) === wanted),
  );
  if (match) return optionValue(match);
  // A spoken "option 2" or "2".
  const index = /^(?:option\s*)?(\d+)$/.exec(wanted)?.[1];
  const byIndex = index === undefined ? undefined : question.options[Number(index) - 1];
  return byIndex ? optionValue(byIndex) : null;
}

/** One question's options in the form the pending requests list reads out. */
export function describeQuestion(question: ThreadUserInputQuestion): string {
  const parts = [`${question.id}: ${question.question}`];
  if (question.options.length > 0) {
    parts.push(`options ${question.options.map((option) => option.label).join(" | ")}`);
  }
  if (question.multiSelect) parts.push("several allowed");
  if (question.allowCustomAnswer !== false) parts.push("free text allowed");
  return parts.join("; ");
}

function resolveAnswer(
  question: ThreadUserInputQuestion,
  raw: unknown,
): string | ReadonlyArray<string> {
  const invalid = (message: string) =>
    stop("rejected", "invalid_answer", `${message} ${describeQuestion(question)}.`);
  const custom = question.allowCustomAnswer !== false;
  if (question.multiSelect) {
    const parts = (Array.isArray(raw) ? raw : String(raw).split(","))
      .map((part) => String(part))
      .filter((part) => part.trim() !== "");
    const matched = parts.map((part) => matchOption(question, part));
    if (parts.length > 0 && matched.every((value) => value !== null)) {
      return Array.from(new Set(matched as string[]));
    }
    if (custom && typeof raw === "string" && raw.trim() !== "") return raw.trim();
    throw invalid("That answer does not name the question's options.");
  }
  if (typeof raw !== "string" || raw.trim() === "") throw invalid("The answer is empty.");
  const matched = matchOption(question, raw);
  if (matched !== null) return matched;
  if (custom) return raw.trim();
  throw invalid("That answer is not one of the question's options.");
}

/** Maps EVA's answer (or answers by question ID or header) onto the request's questions. */
export function resolveQuestionAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  input: { readonly answer?: string | undefined; readonly answersJson?: string | undefined },
): Record<string, string | ReadonlyArray<string>> {
  let raw: Record<string, unknown>;
  if (input.answer !== undefined) {
    const [only] = questions;
    if (questions.length !== 1 || only === undefined) {
      throw stop(
        "rejected",
        "answers_required",
        `This request asks ${questions.length} questions; pass answersJson. ${questions.map(describeQuestion).join(". ")}.`,
      );
    }
    raw = { [only.id]: input.answer };
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.answersJson ?? "");
    } catch {
      throw stop("rejected", "invalid_answer", "answersJson is not valid JSON.");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw stop("rejected", "invalid_answer", "answersJson must be a JSON object.");
    }
    raw = {};
    for (const [key, value] of Object.entries(parsed)) {
      const question = questions.find(
        (candidate) => candidate.id === key || normalize(candidate.header) === normalize(key),
      );
      if (!question) {
        throw stop(
          "rejected",
          "invalid_answer",
          `No question is called ${key}. ${questions.map(describeQuestion).join(". ")}.`,
        );
      }
      raw[question.id] = value;
    }
  }
  const answers: Record<string, string | ReadonlyArray<string>> = {};
  for (const question of questions) {
    const value = raw[question.id] ?? question.initialAnswer;
    if (value === undefined) {
      throw stop(
        "rejected",
        "answers_required",
        `Answer every question. Missing ${describeQuestion(question)}.`,
      );
    }
    answers[question.id] = resolveAnswer(question, value);
  }
  return answers;
}

function latestForkableRunId(projection: OrchestrationV2ThreadProjection): string | null {
  const item = projection.turnItems.findLast(
    (candidate) =>
      candidate.type === "assistant_message" &&
      candidate.status === "completed" &&
      candidate.runId !== null,
  );
  return item?.runId ?? null;
}

async function planInterrupt(input: PlanInput, raw: unknown) {
  const args = decodeArguments("interrupt_thread", raw);
  const thread = shellOf(input.environment, args.threadId);
  const name = nameOf(thread);
  const run = resolveActiveThreadRun(await projectionOf(input.environment, thread.id));
  if (run === null) {
    throw done(`${capitalized(name)} is not running a turn${onEnvironment(input.environment)}.`);
  }
  return {
    kind: "interrupt_thread" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `Stopped ${name}'s turn${onEnvironment(input.environment)}.`,
    runId: run.id,
  };
}

function planOrganize(input: PlanInput, raw: unknown) {
  const args = decodeArguments("organize_thread", raw);
  const env = onEnvironment(input.environment);
  const thread = input.environment.thread(args.threadId);
  // Archived threads can drop out of the shell list; let the server decide.
  if (thread === null && args.action !== "unarchive") shellOf(input.environment, args.threadId);
  const name = nameOf(thread);
  if (thread !== null) {
    const already = organizeAlreadyDone(args.action, thread, input.now);
    if (already !== null) throw done(`${capitalized(name)} is ${already}${env}.`);
  }
  const snoozedUntil = args.action === "snooze" ? snoozeTarget(args, input.now) : null;
  const until =
    snoozedUntil === null
      ? ""
      : ` for ${snoozeWakeLabel(snoozedUntil, { now: input.now.toISOString() })}, until ${snoozedUntil}`;
  return {
    kind: "organize_thread" as const,
    environmentId: args.environmentId,
    threadId: args.threadId,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `${ORGANIZE_VERBS[args.action]} ${name}${until}${env}.`,
    action: args.action,
    snoozedUntil,
  };
}

async function pendingRequestsOf(input: PlanInput, threadId: string) {
  const thread = shellOf(input.environment, threadId);
  return {
    thread,
    pending: derivePendingThreadRequests(await projectionOf(input.environment, thread.id)),
  };
}

function notPending(kind: "approval" | "question", other: boolean) {
  return other
    ? stop(
        "rejected",
        "wrong_request_kind",
        kind === "approval"
          ? "That request is a question; answer it with answer_question."
          : "That request is an approval; answer it with respond_to_approval.",
      )
    : stop(
        "rejected",
        "request_not_pending",
        `That ${kind} is no longer pending; list pending requests again.`,
      );
}

async function planApproval(input: PlanInput, raw: unknown) {
  const args = decodeArguments("respond_to_approval", raw);
  const { thread, pending } = await pendingRequestsOf(input, args.threadId);
  const approval = pending.approvals.find((candidate) => candidate.requestId === args.requestId);
  if (!approval) {
    throw notPending(
      "approval",
      pending.userInputs.some((request) => request.requestId === args.requestId),
    );
  }
  if (approval.responseCapability !== "live") {
    throw stop(
      "rejected",
      "request_not_resumable",
      "That approval can no longer be answered because its agent session ended.",
    );
  }
  const decision = APPROVAL_DECISIONS[args.decision];
  if (approval.options !== undefined && !approval.options.some((o) => o.decision === decision)) {
    const allowed = approvalChoices(approval.options)
      .map((choice) => choice.choice)
      .join(", ");
    throw stop("rejected", "decision_not_offered", `That approval only offers ${allowed}.`);
  }
  return {
    kind: "respond_to_approval" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `${APPROVAL_VERBS[decision]} the request in ${nameOf(thread)}${onEnvironment(input.environment)}.`,
    requestId: approval.requestId,
    decision,
  };
}

async function planAnswer(input: PlanInput, raw: unknown) {
  const args = decodeArguments("answer_question", raw);
  const { thread, pending } = await pendingRequestsOf(input, args.threadId);
  const request = pending.userInputs.find((candidate) => candidate.requestId === args.requestId);
  if (!request) {
    throw notPending(
      "question",
      pending.approvals.some((approval) => approval.requestId === args.requestId),
    );
  }
  if (request.responseCapability === "not_resumable") {
    throw stop(
      "rejected",
      "request_not_resumable",
      "That question can no longer be answered because its agent session ended.",
    );
  }
  return {
    kind: "answer_question" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `Answered the question in ${nameOf(thread)}${onEnvironment(input.environment)}.`,
    requestId: request.requestId,
    answers: resolveQuestionAnswers(request.questions, args),
  };
}

async function planDismiss(input: PlanInput, raw: unknown) {
  const args = decodeArguments("dismiss_question", raw);
  const { thread, pending } = await pendingRequestsOf(input, args.threadId);
  const request = pending.userInputs.find((candidate) => candidate.requestId === args.requestId);
  if (!request) {
    throw notPending(
      "question",
      pending.approvals.some((approval) => approval.requestId === args.requestId),
    );
  }
  if (!request.dismissible) {
    throw stop(
      "rejected",
      "not_dismissible",
      "That question cannot be dismissed; answer it instead.",
    );
  }
  return {
    kind: "dismiss_question" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `Dismissed the question in ${nameOf(thread)}${onEnvironment(input.environment)}.`,
    requestId: request.requestId,
  };
}

function planRename(input: PlanInput, raw: unknown) {
  const args = decodeArguments("rename_thread", raw);
  const thread = shellOf(input.environment, args.threadId);
  const title = args.title.trim();
  const env = onEnvironment(input.environment);
  if (title === thread.title.trim()) throw done(`The thread is already called “${title}”${env}.`);
  return {
    kind: "rename_thread" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `Renamed ${nameOf(thread)} to “${title}”${env}.`,
    title,
  };
}

function sameOptions(
  left: ModelSelectionPlan["options"] | undefined,
  right: ModelSelectionPlan["options"] | undefined,
): boolean {
  const key = (options: ModelSelectionPlan["options"] | undefined) =>
    JSON.stringify([...(options ?? [])].sort((a, b) => a.id.localeCompare(b.id)));
  return key(left) === key(right);
}

function planConfigure(input: PlanInput, raw: unknown) {
  const args = decodeArguments("configure_thread", raw);
  const thread = shellOf(input.environment, args.threadId);
  const providers = input.environment.providers();
  const current = thread.modelSelection;
  const changes: string[] = [];
  let modelSelection: ModelSelectionPlan | null = null;
  if (args.provider !== undefined || args.model !== undefined || args.modelOptions !== undefined) {
    const base =
      args.provider !== undefined || args.model !== undefined
        ? resolveModelSelection({
            provider: args.provider ?? current.instanceId,
            model: args.model,
            projectDefault: null,
            providers,
          })
        : { instanceId: current.instanceId, model: current.model };
    const model = findProviderModel(providers, base);
    const options =
      args.modelOptions === undefined ? undefined : parseModelOptions(args.modelOptions, model);
    const next: ModelSelectionPlan = options === undefined ? base : { ...base, options };
    const currentOptions = current.options as ModelSelectionPlan["options"] | undefined;
    if (
      next.instanceId !== current.instanceId ||
      next.model !== current.model ||
      (options !== undefined && !sameOptions(options, currentOptions))
    ) {
      modelSelection = next;
      const label = model?.name ?? next.model;
      changes.push(
        options === undefined || options.length === 0
          ? `model ${label}`
          : `model ${label} with ${options.map((o) => `${o.id}=${String(o.value)}`).join(", ")}`,
      );
    }
  }
  const runtimeMode =
    args.runtimeMode !== undefined && args.runtimeMode !== thread.runtimeMode
      ? args.runtimeMode
      : null;
  if (runtimeMode !== null) changes.push(`runtime mode ${runtimeMode}`);
  const interactionMode =
    args.interactionMode !== undefined && args.interactionMode !== thread.interactionMode
      ? args.interactionMode
      : null;
  if (interactionMode !== null) changes.push(`interaction mode ${interactionMode}`);
  const name = nameOf(thread);
  const env = onEnvironment(input.environment);
  if (changes.length === 0) throw done(`${capitalized(name)} already uses those settings${env}.`);
  return {
    kind: "configure_thread" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary: `Set ${name} to ${changes.join(", ")}${env}; it applies from the next turn.`,
    modelSelection,
    runtimeMode,
    interactionMode,
  };
}

async function planFork(input: PlanInput, raw: unknown) {
  const args = decodeArguments("fork_thread", raw);
  const thread = shellOf(input.environment, args.threadId);
  const runId = latestForkableRunId(await projectionOf(input.environment, thread.id));
  if (runId === null) {
    throw stop("rejected", "nothing_to_fork", "That thread has no finished response to fork from.");
  }
  const ids = assistantRequestIds(input.key);
  const title = args.title?.trim() || `${thread.title} fork`;
  return {
    kind: "fork_thread" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: ids.commandId,
    summary: `Forked ${nameOf(thread)} into “${title}”${onEnvironment(input.environment)}.`,
    targetThreadId: ids.threadId,
    runId,
    title,
  };
}

async function planQueued(input: PlanInput, raw: unknown) {
  const args = decodeArguments("manage_queued_message", raw);
  const thread = shellOf(input.environment, args.threadId);
  const workflow = deriveThreadQueueWorkflowState(await projectionOf(input.environment, thread.id));
  if (!workflow.queuedRuns.some((queued) => queued.run.id === args.runId)) {
    throw stop(
      "rejected",
      "not_queued",
      "That message is no longer queued; list the queued messages again.",
    );
  }
  const name = nameOf(thread);
  const env = onEnvironment(input.environment);
  let targetRunId: string | null = null;
  if (args.action === "steer") {
    if (workflow.activeRun === null || !workflow.canPromoteToSteer) {
      throw stop(
        "rejected",
        "cannot_steer",
        "Nothing is running that the message can steer into; it sends when the thread is free.",
      );
    }
    targetRunId = workflow.activeRun.id;
  }
  return {
    kind: "manage_queued_message" as const,
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId: assistantRequestIds(input.key).commandId,
    summary:
      args.action === "remove"
        ? `Removed the queued message from ${name}${env}.`
        : `Steered the queued message into ${name}'s running turn${env}.`,
    runId: args.runId,
    action: args.action,
    targetRunId,
  };
}

/**
 * Resolves one thread action against the environment as it is now. Throws an
 * Outcome when the request ends here: rejected, or already done.
 */
export async function planThreadAction(
  operation: ThreadActionOperation,
  args: unknown,
  input: PlanInput,
): Promise<ThreadActionPlan> {
  switch (operation) {
    case "interrupt_thread":
      return planInterrupt(input, args);
    case "organize_thread":
      return planOrganize(input, args);
    case "respond_to_approval":
      return planApproval(input, args);
    case "answer_question":
      return planAnswer(input, args);
    case "dismiss_question":
      return planDismiss(input, args);
    case "rename_thread":
      return planRename(input, args);
    case "configure_thread":
      return planConfigure(input, args);
    case "fork_thread":
      return planFork(input, args);
    case "manage_queued_message":
      return planQueued(input, args);
  }
}
