import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveAttention } from "./attention.ts";

const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 6, 12, minute));
const NOW = at(30);

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: at(0),
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: RunId.make(`${id}-run`),
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: at(10),
    latestUserMessageAt: null,
    createdAt: at(0),
    updatedAt: at(10),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  };
};

const pending = (kind: "user_input" | "command", blocking?: boolean) => ({
  id: RuntimeRequestId.make(`request-${kind}`),
  kind,
  createdAt: at(20),
  ...(blocking === undefined ? {} : { blocking }),
});

it("lists only threads that need the user, at most once each", () => {
  const items = deriveAttention({
    environmentId: EnvironmentId.make("fleet:box"),
    environmentLabel: "box",
    now: NOW,
    exclude: new Set([ThreadId.make("coordinator")]),
    threads: [
      shell("asks", {
        status: "waiting",
        pendingRuntimeRequest: pending("user_input"),
        latestVisibleMessage: {
          id: MessageId.make("m"),
          role: "assistant",
          text: "Which branch?",
          updatedAt: at(20),
        },
      }),
      shell("approves", { status: "waiting", pendingRuntimeRequest: pending("command") }),
      shell("asks-async", {
        status: "running",
        pendingRuntimeRequest: pending("user_input", false),
      }),
      shell("failed", { status: "failed", lastError: "provider exited" }),
      shell("failed-seen", { status: "failed", lastVisitedAt: at(15) }),
      shell("finished"),
      shell("finished-seen", { lastVisitedAt: at(15) }),
      shell("never-opened", { lastVisitedAt: null }),
      shell("snoozed", { snoozedUntil: at(45) }),
      shell("snooze-over", { snoozedUntil: at(25) }),
      shell("settled", { settledOverride: "settled" }),
      shell("archived", { archivedAt: at(12) }),
      shell("coordinator"),
      shell("subagent", {
        lineage: {
          rootThreadId: ThreadId.make("finished"),
          parentThreadId: ThreadId.make("finished"),
          relationshipToParent: "subagent",
        },
      }),
    ],
  });

  expect(items.map((item) => [item.thread?.threadId, item.kind])).toEqual([
    ["asks", "question"],
    ["approves", "approval"],
    ["failed", "failed"],
    ["finished", "unread"],
    ["never-opened", "unread"],
    ["snooze-over", "unread"],
  ]);
  expect(items[0]).toMatchObject({ detail: "Which branch?", environmentLabel: "box" });
  expect(items[2]?.detail).toBe("provider exited");
});
