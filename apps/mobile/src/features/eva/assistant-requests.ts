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
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { assistantThreadRow, type AssistantThreadRow } from "./assistant-catalog";

// States the native journal stores. See ReceiptState in the native module.
export type AssistantRequestState =
  | "accepted"
  | "waiting_for_host"
  | "submitted"
  | "completed"
  | "failed"
  | "uncertain"
  | "rejected"
  | "needs_configuration"
  | "needs_host_update";

export interface AssistantRequestUpdate {
  readonly state?: AssistantRequestState;
  readonly dispatchStarted?: boolean;
  readonly plan?: AssistantRequestPlan;
  readonly environmentName?: string;
  readonly threadId?: string;
  /** Catalog row for a thread a request created, served until the published catalog lists it. */
  readonly catalog?: { readonly thread: AssistantThreadRow };
  readonly error?: { readonly code: string; readonly message: string };
}

const MAX_ERROR_MESSAGE = 500;

const StartThreadArguments = Schema.Struct({
  environmentId: Schema.String,
  projectId: Schema.String,
  prompt: Schema.String,
  title: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  runtimeMode: Schema.optional(RuntimeMode),
  interactionMode: Schema.optional(ProviderInteractionMode),
  workspace: Schema.optional(Schema.Literals(["local", "worktree"])),
  baseBranch: Schema.optional(Schema.String),
});
type StartThreadArguments = typeof StartThreadArguments.Type;

const SendMessageArguments = Schema.Struct({
  environmentId: Schema.String,
  threadId: Schema.String,
  prompt: Schema.String,
  activeTurnBehavior: Schema.optional(Schema.Literals(["steer", "queue", "restart"])),
});
type SendMessageArguments = typeof SendMessageArguments.Type;

const ModelSelectionPlan = Schema.Struct({ instanceId: Schema.String, model: Schema.String });

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
    Schema.Struct({ mode: Schema.Literal("local"), branch: Schema.NullOr(Schema.String) }),
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

const AssistantRequestPlan = Schema.Union([StartThreadPlan, SendMessagePlan]);
export type AssistantRequestPlan = typeof AssistantRequestPlan.Type;
export type StartThreadPlan = typeof StartThreadPlan.Type;
export type SendMessagePlan = typeof SendMessagePlan.Type;

const decodePlan = Schema.decodeUnknownOption(AssistantRequestPlan);
const decodeStartThreadArguments = Schema.decodeUnknownOption(StartThreadArguments);
const decodeSendMessageArguments = Schema.decodeUnknownOption(SendMessageArguments);

const PENDING_STATES = new Set(["accepted", "waiting_for_host", "submitted"]);

export interface AssistantRequestJob {
  readonly key: string;
  readonly operation: "start_thread" | "send_message";
  readonly arguments: unknown;
  readonly plan: AssistantRequestPlan | null;
  readonly dispatchStarted: boolean;
}

/** Parses the task data native code hands over; anything malformed is dropped whole. */
export function parseAssistantRequestJob(raw: unknown): AssistantRequestJob | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.key !== "string" || data.key.length === 0) return null;
  if (data.operation !== "start_thread" && data.operation !== "send_message") return null;
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
      operation: data.operation,
      arguments: JSON.parse(data.arguments),
      plan,
      dispatchStarted: data.dispatchStarted === "true",
    };
  } catch {
    return null;
  }
}

function uuidShaped(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Server identities derived from the journal key (a SHA-256 of caller and
 * invocation ID). The server keeps a receipt per command ID, so replaying a
 * plan after a lost reply or process death returns the first outcome.
 */
export function assistantRequestIds(key: string) {
  return {
    commandId: `eva:${key}`,
    threadId: uuidShaped(key.slice(0, 32)),
    messageId: uuidShaped(key.slice(32, 64)),
  };
}

/** What the executor needs from one connected environment. */
export interface AssistantEnvironmentClient {
  readonly environmentName: string;
  project(projectId: string): EnvironmentProject | null;
  thread(threadId: string): EnvironmentThreadShell | null;
  providers(): ReadonlyArray<ServerProvider>;
  currentBranch(cwd: string): Promise<string | null>;
  newWorktreeBranchName(): string;
  startThread(plan: StartThreadPlan): Promise<DispatchOutcome>;
  sendMessage(plan: SendMessagePlan): Promise<DispatchOutcome>;
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

class Outcome extends Error {
  constructor(readonly update: AssistantRequestUpdate) {
    super(update.error?.message ?? update.state ?? "outcome");
  }
}

function clip(message: string): string {
  const chars = Array.from(message);
  return chars.length > MAX_ERROR_MESSAGE ? chars.slice(0, MAX_ERROR_MESSAGE).join("") : message;
}

function stop(state: AssistantRequestState, code: string, message: string): Outcome {
  return new Outcome({ state, error: { code, message: clip(message) } });
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

function defaultModel(provider: ServerProvider): string | null {
  return (provider.models.find((model) => model.isDefault) ?? provider.models[0])?.slug ?? null;
}

/** The request's provider and model, else the project's default, else the first ready provider's. */
export function resolveModelSelection(input: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly projectDefault: ModelSelection | null;
  readonly providers: ReadonlyArray<ServerProvider>;
}): { readonly instanceId: string; readonly model: string } {
  const usable = (provider: ServerProvider) => provider.enabled && provider.status !== "disabled";
  if (input.provider !== undefined) {
    const provider = input.providers.find((candidate) => candidate.instanceId === input.provider);
    if (!provider || !usable(provider)) {
      throw stop(
        "rejected",
        "unknown_provider",
        `Provider ${input.provider} is not enabled on this environment.`,
      );
    }
    if (provider.status === "error") {
      throw stop(
        "rejected",
        "provider_unavailable",
        `Provider ${input.provider} reports an error.`,
      );
    }
    const model = input.model ?? defaultModel(provider);
    if (
      model === null ||
      (input.model !== undefined && !provider.models.some((m) => m.slug === model))
    ) {
      throw stop(
        "rejected",
        "unknown_model",
        `Model ${input.model} is not offered by ${input.provider}.`,
      );
    }
    return { instanceId: provider.instanceId, model };
  }
  if (input.projectDefault) {
    return { instanceId: input.projectDefault.instanceId, model: input.projectDefault.model };
  }
  const ready = input.providers.find((provider) => usable(provider) && provider.status === "ready");
  const model = ready ? defaultModel(ready) : null;
  if (!ready || model === null) {
    throw stop(
      "needs_configuration",
      "provider_required",
      "No provider is ready on this environment.",
    );
  }
  return { instanceId: ready.instanceId, model };
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
  const modelSelection = resolveModelSelection({
    provider: args.provider,
    model: args.model,
    projectDefault: project.defaultModelSelection ?? null,
    providers: environment.providers(),
  });
  let workspace: StartThreadPlan["workspace"] = { mode: "local", branch: null };
  if (args.workspace === "worktree") {
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
        } else {
          const args = decodeSendMessageArguments(job.arguments);
          if (args._tag === "None") {
            throw stop(
              "rejected",
              "invalid_arguments",
              "T3 Code could not read the saved request.",
            );
          }
          plan = planSendMessage({ key: job.key, args: args.value, environment });
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
        : await environment.sendMessage(plan);
    switch (outcome.kind) {
      case "accepted":
        await report(
          plan.kind === "start_thread"
            ? createdThreadUpdate(plan, environment)
            : { state: "completed", threadId: plan.threadId },
        );
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
