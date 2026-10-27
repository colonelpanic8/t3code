import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import { hasRelayRoute } from "@t3tools/client-runtime/connection";
import { executeAtomQuery, type AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
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
import { environmentShell } from "../../state/shell";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import type { AssistantCatalogEnvironment } from "./assistant-catalog";
import type {
  AssistantEnvironmentClient,
  AssistantEnvironmentConnection,
  DispatchOutcome,
  SendMessagePlan,
  StartThreadPlan,
} from "./assistant-requests";

const BRANCH_TIMEOUT_MS = 5_000;

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
    worktreePath: null,
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
