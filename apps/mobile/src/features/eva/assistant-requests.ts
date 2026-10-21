import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderInteractionMode,
  RuntimeMode,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { assistantThreadRow, type AssistantThreadRow } from "./assistant-catalog";
import { assistantRequestIds } from "./assistant-ids";
import {
  findProviderModel,
  ModelSelectionPlan,
  parseModelOptions,
  resolveModelSelection,
} from "./assistant-models";
import { clip, Outcome, stop, type AssistantRequestState } from "./assistant-outcome";
import {
  isThreadActionOperation,
  planThreadAction,
  ThreadActionPlan,
  type ThreadActionEnvironment,
  type ThreadActionOperation,
} from "./assistant-thread-actions";

export { assistantRequestIds } from "./assistant-ids";
export { resolveModelSelection } from "./assistant-models";
export type { AssistantRequestState } from "./assistant-outcome";

export interface AssistantRequestUpdate {
  readonly state?: AssistantRequestState;
  readonly dispatchStarted?: boolean;
  readonly plan?: AssistantRequestPlan;
  readonly environmentName?: string;
  readonly threadId?: string;
  /** Catalog row for a thread a request created, served until the published catalog lists it. */
  readonly catalog?: { readonly thread: AssistantThreadRow };
  /** Read out instead of the operation's default sentence once the request completes. */
  readonly summary?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

const StartThreadArguments = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  prompt: Schema.String,
  title: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  modelOptions: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspace: Schema.optional(Schema.Literals(["local", "worktree", "branch", "pull_request"])),
  baseBranch: Schema.optional(Schema.String),
  branch: Schema.optional(Schema.String),
  pullRequest: Schema.optional(Schema.String),
});
type StartThreadArguments = typeof StartThreadArguments.Type;

const SendMessageArguments = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  prompt: Schema.String,
  activeTurnBehavior: Schema.optional(Schema.Literals(["steer", "queue", "restart"])),
});
type SendMessageArguments = typeof SendMessageArguments.Type;

const StartThreadPlan = Schema.Struct({
  kind: Schema.Literal("start_thread"),
  environmentId: Schema.String,
  projectId: Schema.String,
  threadId: Schema.String,
  commandId: Schema.String,
  messageId: Schema.String,
  createdAt: Schema.String,
  text: Schema.String,
  title: Schema.String,
  modelSelection: ModelSelectionPlan,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspace: Schema.Union([
    Schema.Struct({
      mode: Schema.Literal("local"),
      branch: Schema.NullOr(Schema.String),
      /** An existing checkout outside the project directory, such as a pull request worktree. */
      worktreePath: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    Schema.Struct({
      mode: Schema.Literal("worktree"),
      projectCwd: Schema.String,
      baseBranch: Schema.String,
      branch: Schema.String,
    }),
  ]),
});

const SendMessagePlan = Schema.Struct({
  kind: Schema.Literal("send_message"),
  environmentId: Schema.String,
  threadId: Schema.String,
  commandId: Schema.String,
  messageId: Schema.String,
  text: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  dispatchMode: Schema.Literals(["auto", "steer", "queue", "restart"]),
});

const AssistantRequestPlan = Schema.Union([StartThreadPlan, SendMessagePlan, ThreadActionPlan]);
export type AssistantRequestPlan = typeof AssistantRequestPlan.Type;
export type StartThreadPlan = typeof StartThreadPlan.Type;
export type SendMessagePlan = typeof SendMessagePlan.Type;

const decodePlan = Schema.decodeUnknownOption(AssistantRequestPlan);
const decodeStartThreadArguments = Schema.decodeUnknownOption(StartThreadArguments);
const decodeSendMessageArguments = Schema.decodeUnknownOption(SendMessageArguments);

const PENDING_STATES = new Set(["accepted", "waiting_for_host", "submitted"]);

export type AssistantOperationName = "start_thread" | "send_message" | ThreadActionOperation;

export interface AssistantRequestJob {
  readonly key: string;
  readonly operation: AssistantOperationName;
  readonly arguments: unknown;
  readonly plan: AssistantRequestPlan | null;
  readonly dispatchStarted: boolean;
}

/** Parses the task data native code hands over; anything malformed is dropped whole. */
export function parseAssistantRequestJob(raw: unknown): AssistantRequestJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.key !== "string" || data.key.length === 0) return null;
  const operation = data.operation;
  if (
    operation !== "start_thread" &&
    operation !== "send_message" &&
    !isThreadActionOperation(operation)
  ) {
    return null;
  }
  if (typeof data.arguments !== "string" || typeof data.plan !== "string") return null;
  if (data.dispatchStarted !== "true" && data.dispatchStarted !== "false") return null;
  try {
    let plan: AssistantRequestPlan | null = null;
    if (data.plan) {
      const decoded = decodePlan(JSON.parse(data.plan));
      if (decoded._tag === "None") return null;
      plan = decoded.value;
    }
    return {
      key: data.key,
      operation,
      arguments: JSON.parse(data.arguments),
      plan,
      dispatchStarted: data.dispatchStarted === "true",
    };
  } catch {
    return null;
  }
}

/** A checkout made ready before the thread starts in it. */
export type PreparedWorkspace =
  | { readonly kind: "ready"; readonly branch: string; readonly worktreePath: string | null }
  | { readonly kind: "definite"; readonly message: string }
  | { readonly kind: "transient"; readonly message: string };

export type WorkspaceRequest =
  | { readonly kind: "branch"; readonly cwd: string; readonly branch: string }
  | { readonly kind: "pull_request"; readonly cwd: string; readonly reference: string };

/** What the executor needs from one connected environment. */
export interface AssistantEnvironmentClient extends ThreadActionEnvironment {
  project(projectId: string): EnvironmentProject | null;
  currentBranch(cwd: string): Promise<string | null>;
  newWorktreeBranchName(): string;
  /** Not deduplicated by the server: repeating it must reuse what an earlier run made. */
  prepareWorkspace(request: WorkspaceRequest): Promise<PreparedWorkspace>;
  startThread(plan: StartThreadPlan): Promise<DispatchOutcome>;
  sendMessage(plan: SendMessagePlan): Promise<DispatchOutcome>;
  dispatchThreadAction(plan: ThreadActionPlan): Promise<DispatchOutcome>;
}

/**
 * definite: the server decided and the request will not succeed as sent.
 * transient: the reply was lost or the connection dropped; replaying is safe.
 */
export type DispatchOutcome =
  | { readonly kind: "accepted" }
  | { readonly kind: "definite"; readonly message: string }
  | { readonly kind: "transient"; readonly message: string };

/** environmentName is the label the catalog shows; empty when T3 Code knows none. */
export type AssistantEnvironmentConnection =
  | { readonly kind: "connected"; readonly environment: AssistantEnvironmentClient }
  | { readonly kind: "unknown_environment" }
  | { readonly kind: "offline"; readonly environmentName: string }
  | { readonly kind: "needs_sign_in"; readonly environmentName: string };

export interface AssistantRequestDeps {
  connect(environmentId: string): Promise<AssistantEnvironmentConnection>;
  /** Resolves with the stored request once the native journal has committed the update. */
  report(update: AssistantRequestUpdate): Promise<unknown>;
  now(): Date;
}

async function connected(deps: AssistantRequestDeps, environmentId: string) {
  const connection = await deps.connect(environmentId);
  switch (connection.kind) {
    case "connected":
      return connection.environment;
    case "unknown_environment":
      throw stop("rejected", "unknown_environment", "T3 Code has no environment with that ID.");
    case "needs_sign_in":
      throw new Outcome({
        state: "needs_configuration",
        environmentName: connection.environmentName,
        error: {
          code: "sign_in_required",
          message: "This environment connects through T3 Connect; open T3 Code to sign in first.",
        },
      });
    case "offline":
      throw new Outcome({
        state: "waiting_for_host",
        environmentName: connection.environmentName,
        error: { code: "environment_offline", message: "The environment is offline." },
      });
  }
}

export function threadTitleFromPrompt(prompt: string): string {
  const compact = prompt.trim().replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

/**
 * Resolves defaults once, against the environment as it is now, into the
 * exact launch. Nothing interactive is consulted.
 */
export async function planStartThread(input: {
  readonly key: string;
  readonly args: StartThreadArguments;
  readonly environment: AssistantEnvironmentClient;
  readonly now: Date;
}): Promise<StartThreadPlan> {
  const { args, environment } = input;
  const project = environment.project(args.projectId);
  if (!project) {
    throw stop("rejected", "unknown_project", "That project is not in this environment.");
  }
  const providers = environment.providers();
  const resolved = resolveModelSelection({
    provider: args.provider,
    model: args.model,
    projectDefault: project.defaultModelSelection ?? null,
    providers,
  });
  const modelSelection: ModelSelectionPlan =
    args.modelOptions === undefined
      ? resolved
      : {
          ...resolved,
          options: parseModelOptions(args.modelOptions, findProviderModel(providers, resolved)),
        };
  let workspace: StartThreadPlan["workspace"] = { mode: "local", branch: null };
  if (args.workspace === "branch" || args.workspace === "pull_request") {
    const prepared = await environment.prepareWorkspace(
      args.workspace === "branch"
        ? { kind: "branch", cwd: project.workspaceRoot, branch: args.branch ?? "" }
        : { kind: "pull_request", cwd: project.workspaceRoot, reference: args.pullRequest ?? "" },
    );
    if (prepared.kind === "definite") {
      throw stop("rejected", "workspace_unavailable", prepared.message);
    }
    // Left pending: a status poll prepares it again, reusing what this run made.
    if (prepared.kind === "transient") throw new Error(prepared.message);
    workspace = { mode: "local", branch: prepared.branch, worktreePath: prepared.worktreePath };
  } else if (args.workspace === "worktree") {
    const baseBranch = args.baseBranch ?? (await environment.currentBranch(project.workspaceRoot));
    if (!baseBranch) {
      throw stop(
        "rejected",
        "no_base_branch",
        "The project has no current branch to start a worktree from; pass baseBranch.",
      );
    }
    workspace = {
      mode: "worktree",
      projectCwd: project.workspaceRoot,
      baseBranch,
      branch: environment.newWorktreeBranchName(),
    };
  }
  const ids = assistantRequestIds(input.key);
  return {
    kind: "start_thread",
    environmentId: args.environmentId,
    projectId: project.id,
    ...ids,
    createdAt: input.now.toISOString(),
    text: args.prompt,
    title: args.title ?? threadTitleFromPrompt(args.prompt),
    modelSelection,
    runtimeMode: args.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode: args.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
    workspace,
  };
}

export function planSendMessage(input: {
  readonly key: string;
  readonly args: SendMessageArguments;
  readonly environment: AssistantEnvironmentClient;
}): SendMessagePlan {
  const { args, environment } = input;
  const thread = environment.thread(args.threadId);
  if (!thread) {
    throw stop("rejected", "unknown_thread", "That thread is not in this environment.");
  }
  if (thread.archivedAt !== null || thread.deletedAt !== null) {
    throw stop("rejected", "thread_archived", "That thread is archived.");
  }
  const { commandId, messageId } = assistantRequestIds(input.key);
  return {
    kind: "send_message",
    environmentId: args.environmentId,
    threadId: thread.id,
    commandId,
    messageId,
    text: args.prompt,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    dispatchMode: args.activeTurnBehavior ?? "steer",
  };
}

function createdThreadUpdate(
  plan: StartThreadPlan,
  environment: AssistantEnvironmentClient,
): AssistantRequestUpdate {
  const project = environment.project(plan.projectId);
  const thread = environment.thread(plan.threadId);
  const row = assistantThreadRow({
    thread: thread ?? {
      environmentId: plan.environmentId as EnvironmentThreadShell["environmentId"],
      id: plan.threadId as EnvironmentThreadShell["id"],
      projectId: plan.projectId as EnvironmentThreadShell["projectId"],
      title: plan.title,
      branch: plan.workspace.branch,
      worktreePath: null,
      modelSelection: plan.modelSelection as ModelSelection,
      runtime: null,
      latestRun: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      latestUserMessageAt: plan.createdAt,
      updatedAt: plan.createdAt,
      archivedAt: null,
      deletedAt: null,
    },
    environmentName: environment.environmentName,
    projectName: project?.title ?? "",
  });
  return { state: "completed", threadId: plan.threadId, catalog: { thread: row } };
}

function forkedThreadUpdate(
  plan: Extract<ThreadActionPlan, { readonly kind: "fork_thread" }>,
  environment: AssistantEnvironmentClient,
): AssistantRequestUpdate {
  const source = environment.thread(plan.threadId);
  const created = environment.thread(plan.targetThreadId);
  const update: AssistantRequestUpdate = { state: "completed", summary: plan.summary };
  const thread =
    created ?? (source ? { ...source, id: plan.targetThreadId, title: plan.title } : null);
  if (thread === null) return update;
  const project = environment.project(thread.projectId);
  return {
    ...update,
    catalog: {
      thread: assistantThreadRow({
        thread: thread as EnvironmentThreadShell,
        environmentName: environment.environmentName,
        projectName: project?.title ?? "",
      }),
    },
  };
}

function completedUpdate(
  plan: AssistantRequestPlan,
  environment: AssistantEnvironmentClient,
): AssistantRequestUpdate {
  switch (plan.kind) {
    case "start_thread":
      return createdThreadUpdate(plan, environment);
    case "send_message":
      return { state: "completed", threadId: plan.threadId };
    case "fork_thread":
      return forkedThreadUpdate(plan, environment);
    default:
      return { state: "completed", summary: plan.summary };
  }
}

/**
 * Runs one journaled request to the furthest state it can reach now. The plan
 * is committed with dispatchStarted before the first send, and every later run
 * replays that exact plan under the same command ID, which the server's
 * receipts turn into the first outcome rather than a second run.
 */
export async function runAssistantRequest(
  job: AssistantRequestJob,
  deps: AssistantRequestDeps,
): Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  const report = (update: AssistantRequestUpdate) => {
    const committed = queue.then(() => deps.report(update));
    queue = committed.catch(() => undefined);
    return committed;
  };

  try {
    let plan = job.plan;
    const environmentId = (job.arguments as { environmentId?: unknown } | null)?.environmentId;
    if (typeof environmentId !== "string") {
      throw stop(
        job.dispatchStarted ? "uncertain" : "rejected",
        "invalid_saved_request",
        "T3 Code could not read the saved request.",
      );
    }
    const environment = await connected(deps, environmentId);
    if (!plan || !job.dispatchStarted) {
      if (!plan) {
        if (job.operation === "start_thread") {
          const args = decodeStartThreadArguments(job.arguments);
          if (args._tag === "None") {
            throw stop(
              "rejected",
              "invalid_arguments",
              "T3 Code could not read the saved request.",
            );
          }
          plan = await planStartThread({
            key: job.key,
            args: args.value,
            environment,
            now: deps.now(),
          });
        } else if (job.operation === "send_message") {
          const args = decodeSendMessageArguments(job.arguments);
          if (args._tag === "None") {
            throw stop(
              "rejected",
              "invalid_arguments",
              "T3 Code could not read the saved request.",
            );
          }
          plan = planSendMessage({ key: job.key, args: args.value, environment });
        } else {
          plan = await planThreadAction(job.operation, job.arguments, {
            key: job.key,
            environment,
            now: deps.now(),
          });
        }
      }
      // Another run may have committed first; dispatch whatever the journal holds.
      const stored = await report({
        plan,
        dispatchStarted: true,
        state: "accepted",
        environmentName: environment.environmentName,
        threadId: plan.threadId,
      });
      const storedState = (stored as { state?: unknown } | null)?.state;
      const storedPlan = decodePlan((stored as { plan?: unknown } | null)?.plan);
      if (typeof storedState !== "string" || storedPlan._tag === "None") {
        throw new Error("The journal did not store the request plan");
      }
      if (!PENDING_STATES.has(storedState)) return;
      plan = storedPlan.value;
    }

    const outcome =
      plan.kind === "start_thread"
        ? await environment.startThread(plan)
        : plan.kind === "send_message"
          ? await environment.sendMessage(plan)
          : await environment.dispatchThreadAction(plan);
    switch (outcome.kind) {
      case "accepted":
        await report(completedUpdate(plan, environment));
        break;
      case "definite":
        await report({
          state: "failed",
          error: { code: "rejected", message: clip(outcome.message) },
        });
        break;
      case "transient":
        // Left pending: a status poll replays the same plan.
        break;
    }
  } catch (error) {
    if (error instanceof Outcome) await report(error.update).catch(() => undefined);
  }
  await queue;
}
