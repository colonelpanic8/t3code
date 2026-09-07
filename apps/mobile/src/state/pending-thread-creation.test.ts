import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isPendingThreadCreationVisible,
  pendingThreadCreationMessage,
  pendingThreadCreationShell,
  resolvePendingThreadCreation,
  type PendingThreadCreation,
} from "./pending-thread-creation";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const creation: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
  commandId: CommandId.make("command-1"),
  text: "Fix the flaky login test",
  attachments: [
    {
      id: "draft-image",
      type: "image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUri: "data:image/png;base64,AAAA",
    },
  ],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  runtimeMode: "full-access",
  creation: {
    projectId: ProjectId.make("project-1"),
    workspaceMode: "worktree",
    branch: "main",
    worktreePath: null,
  },
  createdAt: "2026-08-24T12:00:00.000Z",
};

function detail(
  messageIds: ReadonlyArray<string>,
  runStatus?: OrchestrationV2ThreadProjection["runs"][number]["status"],
): Pick<OrchestrationV2ThreadProjection, "messages" | "runs"> {
  return {
    messages: messageIds.map((id) => ({ id: MessageId.make(id) })),
    runs:
      runStatus === undefined
        ? []
        : [{ id: RunId.make("run-1"), ordinal: 0, status: runStatus }],
  } as unknown as Pick<OrchestrationV2ThreadProjection, "messages" | "runs">;
}

describe("resolvePendingThreadCreation", () => {
  const threadKey = `${creation.environmentId}:${creation.threadId}`;
  const pending: PendingThreadCreation = { message: creation, outcome: null };

  it("keeps setup visible through the prompt echo and shell cleanup until detail has a run", () => {
    let previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous: null,
      detail: null,
    });
    expect(previous).toBe(pending);

    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: detail([]),
    });
    expect(previous).toBe(pending);

    // The user message arrives before the provider publishes a run.
    previous = resolvePendingThreadCreation({
      threadKey,
      pending,
      previous,
      detail: detail([creation.messageId]),
    });
    expect(previous).toBe(pending);

    // The shell stream may observe the run and collect the global outcome
    // before this screen's detail stream catches up.
    previous = resolvePendingThreadCreation({
      threadKey,
      pending: null,
      previous,
      detail: detail([creation.messageId]),
    });
    expect(previous).toBe(pending);

    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous,
        detail: detail([creation.messageId], "running"),
      }),
    ).toBeNull();
  });

  it("keeps the prompt until both the run and its message have arrived", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending,
        previous: null,
        detail: detail([], "running"),
      }),
    ).toBe(pending);
  });

  it.each(["failed", "cancelled", "interrupted"] as const)(
    "ends setup when startup is %s",
    (status) => {
      expect(
        resolvePendingThreadCreation({
          threadKey,
          pending: null,
          previous: pending,
          detail: detail([creation.messageId], status),
        }),
      ).toBeNull();
    },
  );

  it("preserves rejected task recovery", () => {
    const failed: PendingThreadCreation = {
      message: creation,
      outcome: { kind: "failed", message: creation, reason: "Checkout failed" },
    };
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: failed,
        previous: pending,
        detail: detail([], "failed"),
      }),
    ).toBe(failed);
  });

  it("does not carry setup into another thread or invent it for existing threads", () => {
    expect(
      resolvePendingThreadCreation({
        threadKey: "another-thread",
        pending: null,
        previous: pending,
        detail: null,
      }),
    ).toBeNull();
    expect(
      resolvePendingThreadCreation({
        threadKey,
        pending: null,
        previous: null,
        detail: null,
      }),
    ).toBeNull();
  });
});

describe("pendingThreadCreationShell", () => {
  it("shapes a queued creation as the thread shell the screen renders before creation", () => {
    expect(pendingThreadCreationShell(creation)).toMatchObject({
      environmentId: creation.environmentId,
      id: creation.threadId,
      projectId: creation.creation!.projectId,
      title: "Fix the flaky login test",
      modelSelection: creation.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      providerInstanceId: creation.modelSelection!.instanceId,
      latestRun: null,
      runtime: null,
      latestUserMessageAt: creation.createdAt,
    });
  });

  it("keeps a local task's explicit worktree path", () => {
    expect(
      pendingThreadCreationShell({
        ...creation,
        creation: {
          ...creation.creation!,
          workspaceMode: "local",
          worktreePath: "/repo/.worktrees/feature",
        },
      })?.worktreePath,
    ).toBe("/repo/.worktrees/feature");
  });

  it("returns null for a follow-up message or a creation without a model", () => {
    expect(pendingThreadCreationShell({ ...creation, creation: undefined })).toBeNull();
    expect(pendingThreadCreationShell({ ...creation, modelSelection: undefined })).toBeNull();
  });
});

describe("isPendingThreadCreationVisible", () => {
  const creationMessageId = String(creation.messageId);

  it("stands in before any detail has loaded", () => {
    expect(isPendingThreadCreationVisible({ creationMessageId, loadedMessageIds: null })).toBe(
      true,
    );
  });

  // The regression: the server creates the thread, THEN builds the worktree,
  // then starts the turn. The shell and an empty detail arrive seconds before
  // the prompt, and keying on the shell left the thread empty for that whole
  // window.
  it("keeps standing in while the created thread has no messages yet", () => {
    expect(isPendingThreadCreationVisible({ creationMessageId, loadedMessageIds: [] })).toBe(true);
  });

  it("keeps standing in when the thread holds only unrelated messages", () => {
    expect(
      isPendingThreadCreationVisible({ creationMessageId, loadedMessageIds: ["someone-else"] }),
    ).toBe(true);
  });

  it("stands down once the delivered prompt lands under the same id", () => {
    expect(
      isPendingThreadCreationVisible({
        creationMessageId,
        loadedMessageIds: ["someone-else", creationMessageId],
      }),
    ).toBe(false);
  });
});

describe("pendingThreadCreationMessage", () => {
  it("renders the queued prompt as the first user message", () => {
    expect(pendingThreadCreationMessage(creation)).toEqual({
      id: creation.messageId,
      role: "user",
      text: creation.text,
      attachments: [],
      runId: null,
      streaming: false,
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "mobile",
      visibility: "local",
      sourceThreadId: creation.threadId,
      createdAt: creation.createdAt,
      updatedAt: creation.createdAt,
    });
  });

  // Draft attachment ids are local; the feed resolves attachment rows against
  // the server and would spin forever on them.
  it("uses an empty server-attachment list rather than passing local draft ids", () => {
    expect(pendingThreadCreationMessage(creation).attachments).toEqual([]);
  });
});
