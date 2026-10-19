import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { hasRelayRoute } from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import { executeAtomQuery, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import { buildTemporaryWorktreeBranchName } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import { AsyncResult, type Atom } from "effect/reactivity";

import { environmentCatalog } from "../../connection/catalog";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { randomHex } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { orchestrationEnvironment } from "../../state/orchestration";
import { environmentPresentations } from "../../state/presentation";
import { environmentProjects } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { gitEnvironment } from "../../state/git";
import { environmentShell } from "../../state/shell";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import type { AssistantCatalogEnvironment } from "./assistant-catalog";
import type {
  AssistantEnvironmentClient,
  AssistantEnvironmentConnection,
  DispatchOutcome,
  PreparedWorkspace,
  SendMessagePlan,
  StartThreadPlan,
  WorkspaceRequest,
} from "./assistant-requests";
import type { ThreadActionPlan, ThreadActionPlanOf } from "./assistant-thread-actions";

const BRANCH_TIMEOUT_MS = 5_000;
const REFS_TIMEOUT_MS = 8_000;

/**
 * Keeps the connection runtime and every environment's shell alive. Nothing
 * runs until an atom is mounted, and a headless task mounts no component, so
 * the task holds this for as long as it works.
 */
export interface AssistantRuntimeHold {
  /** Mounts an atom until the hold is released. */
  readonly retain: (atom: Atom.Atom<unknown>) => void;
  readonly release: () => void;
}

export function holdAssistantRuntime(): AssistantRuntimeHold {
  const releases: Array<() => void> = [];
  const retain = (atom: Atom.Atom<unknown>) => {
    releases.push(appAtomRegistry.mount(atom));
  };
  retain(environmentCatalog.catalogAtom);
  retain(environmentPresentations.presentationsAtom);
  retain(environmentProjects.projectsAtom);
  retain(environmentThreadShells.threadShellsAtom);
  return { retain, release: () => releases.splice(0).forEach((release) => release()) };
}

/** Resolves with the first value that passes, or null when the wait runs out. */
export function waitForAtom<A, B>(
  atom: Atom.Atom<A>,
  select: (value: A) => B | null,
  timeoutMs: number,
): Promise<B | null> {
  const ready = select(appAtomRegistry.get(atom));
  if (ready !== null) return Promise.resolve(ready);
  return new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      resolve(null);
    }, timeoutMs);
    const check = (value: A) => {
      const selected = select(value);
      if (selected === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(selected);
    };
    unsubscribe = appAtomRegistry.subscribe(atom, check);
    check(appAtomRegistry.get(atom));
  });
}

export function environmentName(presentation: EnvironmentPresentation | null | undefined): string {
  return presentation?.entry.target.label ?? "";
}

export function assistantCatalogEnvironments(): ReadonlyArray<AssistantCatalogEnvironment> {
  return Array.from(appAtomRegistry.get(environmentPresentations.presentationsAtom).values()).map(
    (presentation) => ({
      id: presentation.entry.target.environmentId,
      name: environmentName(presentation),
      status: presentation.entry.enabled ? presentation.connection.phase : "disabled",
    }),
  );
}

function failureError(result: AtomCommandResult<unknown, unknown>): unknown {
  return AsyncResult.isFailure(result) ? Cause.squash(result.cause) : null;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "The environment did not accept the request.";
}

const DEFINITE_FAILURE_TAGS = new Set([
  "OrchestrationDispatchCommandError",
  "OrchestrationV2DispatchCommandError",
  "OrchestrationV2ThreadLaunchError",
  "EnvironmentAuthorizationError",
]);

/** Only a failure the server decided is final; anything else may have been lost in transit. */
export function classifyDispatch(result: AtomCommandResult<unknown, unknown>): DispatchOutcome {
  if (AsyncResult.isSuccess(result)) return { kind: "accepted" };
  const error = failureError(result);
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { _tag: unknown })._tag)
      : null;
  const message = failureMessage(error);
  return tag !== null && DEFINITE_FAILURE_TAGS.has(tag)
    ? { kind: "definite", message }
    : { kind: "transient", message };
}

async function currentBranch(environmentId: EnvironmentId, cwd: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRANCH_TIMEOUT_MS);
  try {
    const result = await executeAtomQuery(
      appAtomRegistry,
      vcsEnvironment.status({ environmentId, input: { cwd } }),
      { signal: controller.signal },
    );
    return AsyncResult.isSuccess(result) ? (result.value?.refName ?? null) : null;
  } finally {
    clearTimeout(timer);
  }
}

function startThreadInput(plan: StartThreadPlan) {
  const worktree = plan.workspace.mode === "worktree" ? plan.workspace : null;
  const input = buildProjectThreadStartTurnInput({
    projectId: ProjectId.make(plan.projectId),
    projectCwd: worktree?.projectCwd ?? "",
    threadId: plan.threadId,
    commandId: plan.commandId,
    messageId: plan.messageId,
    createdAt: plan.createdAt,
    text: plan.text,
    uploadedAttachments: [],
    modelSelection: plan.modelSelection as ModelSelection,
    runtimeMode: plan.runtimeMode,
    interactionMode: plan.interactionMode,
    workspaceMode: plan.workspace.mode,
    branch: worktree?.baseBranch ?? plan.workspace.branch,
    worktreePath: plan.workspace.mode === "local" ? (plan.workspace.worktreePath ?? null) : null,
    startFromOrigin: false,
    worktreeBranchName: worktree?.branch ?? "",
  });
  return {
    ...input,
    titleSeed: plan.title,
    bootstrap: {
      ...input.bootstrap,
      createThread: { ...input.bootstrap.createThread, title: plan.title },
    },
  };
}

function preparedFrom<A>(
  result: AtomCommandResult<A, unknown>,
  ready: (value: A) => PreparedWorkspace,
): PreparedWorkspace {
  if (AsyncResult.isSuccess(result)) return ready(result.value);
  const outcome = classifyDispatch(result);
  return outcome.kind === "definite" || outcome.kind === "transient"
    ? outcome
    : { kind: "transient", message: "The environment did not answer." };
}

/** An existing worktree for the branch if one has it checked out, else a new one. */
async function branchWorkspace(
  environmentId: EnvironmentId,
  cwd: string,
  branch: string,
): Promise<PreparedWorkspace> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REFS_TIMEOUT_MS);
  try {
    const refs = await executeAtomQuery(
      appAtomRegistry,
      vcsEnvironment.listRefs({
        environmentId,
        input: { cwd, query: branch, refKind: "local", refresh: true },
      }),
      { signal: controller.signal },
    );
    const existing = AsyncResult.isSuccess(refs)
      ? refs.value.refs.find((ref) => ref.name === branch && !ref.isRemote)
      : undefined;
    if (existing?.worktreePath) {
      return {
        kind: "ready",
        branch,
        worktreePath: existing.worktreePath === cwd ? null : existing.worktreePath,
      };
    }
  } finally {
    clearTimeout(timer);
  }
  return preparedFrom(
    await vcsEnvironment.createWorktree.run(appAtomRegistry, {
      environmentId,
      input: { cwd, refName: branch, path: null },
    }),
    ({ worktree }) => ({ kind: "ready", branch: worktree.refName, worktreePath: worktree.path }),
  );
}

async function prepareWorkspace(
  environmentId: EnvironmentId,
  request: WorkspaceRequest,
): Promise<PreparedWorkspace> {
  if (request.kind === "branch") return branchWorkspace(environmentId, request.cwd, request.branch);
  return preparedFrom(
    await gitEnvironment.preparePullRequestThread.run(appAtomRegistry, {
      environmentId,
      input: { cwd: request.cwd, reference: request.reference, mode: "worktree" },
    }),
    (checkout): PreparedWorkspace =>
      checkout.worktreePath !== null && !checkout.isOnPullRequestHead
        ? {
            kind: "definite",
            message:
              "The pull request's worktree has local changes and could not update to the pull " +
              "request head. Resolve them in T3 Code first.",
          }
        : { kind: "ready", branch: checkout.branch, worktreePath: checkout.worktreePath },
  );
}

async function configureThread(
  environmentId: EnvironmentId,
  plan: ThreadActionPlanOf<"configure_thread">,
): Promise<DispatchOutcome> {
  const threadId = ThreadId.make(plan.threadId);
  const steps: Array<() => Promise<AtomCommandResult<unknown, unknown>>> = [];
  if (plan.modelSelection !== null) {
    const modelSelection = plan.modelSelection as ModelSelection;
    steps.push(() =>
      threadEnvironment.updateMetadata.run(appAtomRegistry, {
        environmentId,
        input: { threadId, commandId: CommandId.make(plan.commandId), modelSelection },
      }),
    );
  }
  if (plan.runtimeMode !== null) {
    const runtimeMode = plan.runtimeMode;
    steps.push(() =>
      threadEnvironment.setRuntimeMode.run(appAtomRegistry, {
        environmentId,
        input: { threadId, commandId: CommandId.make(`${plan.commandId}:runtime`), runtimeMode },
      }),
    );
  }
  if (plan.interactionMode !== null) {
    const interactionMode = plan.interactionMode;
    steps.push(() =>
      threadEnvironment.setInteractionMode.run(appAtomRegistry, {
        environmentId,
        input: {
          threadId,
          commandId: CommandId.make(`${plan.commandId}:interaction`),
          interactionMode,
        },
      }),
    );
  }
  // Each step has its own command ID, so replaying after a partial run repeats none.
  for (const step of steps) {
    const outcome = classifyDispatch(await step());
    if (outcome.kind !== "accepted") return outcome;
  }
  return { kind: "accepted" };
}

async function dispatchThreadAction(
  environmentId: EnvironmentId,
  plan: ThreadActionPlan,
): Promise<DispatchOutcome> {
  const threadId = ThreadId.make(plan.threadId);
  const commandId = CommandId.make(plan.commandId);
  const target = { threadId, commandId };
  const run = async <W>(
    command: {
      readonly run: (
        registry: typeof appAtomRegistry,
        input: W,
      ) => Promise<AtomCommandResult<unknown, unknown>>;
    },
    input: W,
  ) => classifyDispatch(await command.run(appAtomRegistry, input));
  switch (plan.kind) {
    case "interrupt_thread":
      return run(threadEnvironment.interruptTurn, {
        environmentId,
        input: { ...target, ...(plan.runId === null ? {} : { runId: RunId.make(plan.runId) }) },
      });
    case "organize_thread":
      switch (plan.action) {
        case "pin":
          return run(threadEnvironment.pin, { environmentId, input: target });
        case "unpin":
          return run(threadEnvironment.unpin, { environmentId, input: target });
        case "snooze":
          return run(threadEnvironment.snooze, {
            environmentId,
            input: { ...target, snoozedUntil: plan.snoozedUntil ?? "" },
          });
        case "unsnooze":
          return run(threadEnvironment.unsnooze, {
            environmentId,
            input: { ...target, reason: "user" as const },
          });
        case "settle":
          return run(threadEnvironment.settle, { environmentId, input: target });
        case "unsettle":
          return run(threadEnvironment.unsettle, {
            environmentId,
            input: { ...target, reason: "user" as const },
          });
        case "archive":
          return run(threadEnvironment.archive, { environmentId, input: target });
        case "unarchive":
          return run(threadEnvironment.unarchive, { environmentId, input: target });
        case "mark_unread":
          return run(threadEnvironment.markUnread, { environmentId, input: target });
      }
      break;
    case "respond_to_approval":
      return run(threadEnvironment.respondToApproval, {
        environmentId,
        input: {
          ...target,
          requestId: RuntimeRequestId.make(plan.requestId),
          decision: plan.decision,
        },
      });
    case "answer_question":
      return run(threadEnvironment.respondToUserInput, {
        environmentId,
        input: {
          ...target,
          requestId: RuntimeRequestId.make(plan.requestId),
          answers: plan.answers,
        },
      });
    case "dismiss_question":
      return run(threadEnvironment.dismissUserInput, {
        environmentId,
        input: { ...target, requestId: RuntimeRequestId.make(plan.requestId) },
      });
    case "rename_thread":
      return run(threadEnvironment.updateMetadata, {
        environmentId,
        input: { ...target, title: plan.title },
      });
    case "configure_thread":
      return configureThread(environmentId, plan);
    case "fork_thread":
      return run(threadEnvironment.forkFromRun, {
        environmentId,
        input: {
          commandId,
          sourceThreadId: threadId,
          targetThreadId: ThreadId.make(plan.targetThreadId),
          runId: RunId.make(plan.runId),
          title: plan.title,
          creationSource: "mobile" as const,
        },
      });
    case "manage_queued_message":
      return plan.action === "remove" || plan.targetRunId === null
        ? run(threadEnvironment.cancelQueuedRun, {
            environmentId,
            input: { ...target, runId: RunId.make(plan.runId) },
          })
        : run(threadEnvironment.promoteQueuedRun, {
            environmentId,
            input: {
              ...target,
              queuedRunId: RunId.make(plan.runId),
              targetRunId: RunId.make(plan.targetRunId),
            },
          });
  }
  return { kind: "definite", message: "T3 Code does not know that action." };
}

function environmentClient(
  environmentId: EnvironmentId,
  presentation: EnvironmentPresentation,
): AssistantEnvironmentClient {
  return {
    environmentName: environmentName(presentation),
    project: (projectId) =>
      appAtomRegistry.get(
        environmentProjects.projectAtom({ environmentId, projectId: ProjectId.make(projectId) }),
      ),
    thread: (threadId) =>
      appAtomRegistry
        .get(environmentThreadShells.threadShellsAtom)
        .find((thread) => thread.environmentId === environmentId && thread.id === threadId) ?? null,
    providers: () =>
      appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId))?.providers ?? [],
    currentBranch: (cwd) => currentBranch(environmentId, cwd),
    newWorktreeBranchName: () => buildTemporaryWorktreeBranchName(randomHex),
    threadProjection: (threadId) => readThreadMessages(environmentId, threadId),
    prepareWorkspace: (request) => prepareWorkspace(environmentId, request),
    dispatchThreadAction: (plan) => dispatchThreadAction(environmentId, plan),
    startThread: async (plan) =>
      classifyDispatch(
        await threadEnvironment.startTurn.run(appAtomRegistry, {
          environmentId,
          input: startThreadInput(plan),
        }),
      ),
    sendMessage: async (plan: SendMessagePlan) =>
      classifyDispatch(
        await threadEnvironment.startTurn.run(appAtomRegistry, {
          environmentId,
          input: {
            commandId: CommandId.make(plan.commandId),
            threadId: ThreadId.make(plan.threadId),
            creationSource: "mobile",
            message: {
              messageId: MessageId.make(plan.messageId),
              role: "user",
              text: plan.text,
              attachments: [],
            },
            runtimeMode: plan.runtimeMode,
            interactionMode: plan.interactionMode,
            dispatchMode: plan.dispatchMode,
          },
        }),
      ),
  };
}

/**
 * Waits, bounded, for one environment to connect and its shell and server
 * config to arrive. The connection runtime dials enabled environments on its
 * own once mounted; this only waits for that.
 */
export async function connectAssistantEnvironment(
  hold: AssistantRuntimeHold,
  rawEnvironmentId: string,
  timeoutMs: number,
): Promise<AssistantEnvironmentConnection> {
  const catalogReady = await waitForAtom(
    environmentCatalog.catalogValueAtom,
    (catalog) => (catalog.isReady ? catalog : null),
    timeoutMs,
  );
  const environmentId = EnvironmentId.make(rawEnvironmentId);
  const entry = catalogReady?.entries.get(environmentId);
  if (!entry || !entry.enabled) return { kind: "unknown_environment" };
  const presentationAtom = environmentPresentations.presentationAtom(environmentId);
  hold.retain(environmentShell.stateAtom(environmentId));
  hold.retain(serverEnvironment.configValueAtom(environmentId));
  const ready = await waitForAtom(
    presentationAtom,
    (presentation) => {
      if (presentation?.connection.phase !== "connected") return null;
      const shell = appAtomRegistry.get(environmentShell.stateValueAtom(environmentId));
      const config = appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId));
      return shell.status === "live" && config !== null ? presentation : null;
    },
    timeoutMs,
  );
  if (ready) return { kind: "connected", environment: environmentClient(environmentId, ready) };
  const presentation = appAtomRegistry.get(presentationAtom);
  const name = environmentName(presentation);
  // Relay routes authenticate through T3 Connect, which only the app's UI can sign in to.
  if (hasRelayRoute(entry) && presentation?.connection.phase === "error") {
    return { kind: "needs_sign_in", environmentName: name };
  }
  return { kind: "offline", environmentName: name };
}

/** The enabled environments, once the catalog has loaded. */
export async function enabledAssistantEnvironments(
  timeoutMs: number,
): Promise<ReadonlyArray<string>> {
  const catalog = await waitForAtom(
    environmentCatalog.catalogValueAtom,
    (value) => (value.isReady ? value : null),
    timeoutMs,
  );
  return catalog === null ? [] : Array.from(enabledEnvironmentIds(catalog));
}

/** True when every enabled environment's shell is live, so a catalog built now is complete. */
export function allAssistantEnvironmentsLive(): boolean {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return false;
  for (const environmentId of enabledEnvironmentIds(catalog)) {
    if (appAtomRegistry.get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }
  return true;
}

export async function readThreadMessages(environmentId: string, threadId: string) {
  const result = await executeAtomQuery(
    appAtomRegistry,
    orchestrationEnvironment.v2.threadProjection({
      environmentId: EnvironmentId.make(environmentId),
      input: { threadId: ThreadId.make(threadId) },
    }),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}
