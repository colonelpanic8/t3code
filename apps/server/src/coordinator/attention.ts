import {
  type CoordinatorInboxItem,
  type EnvironmentId,
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DETAIL_MAX_CHARS = 280;

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DETAIL_MAX_CHARS ? `${flat.slice(0, DETAIL_MAX_CHARS - 1)}…` : flat;
};

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

const isAfter = (a: DateTime.Utc, b: DateTime.Utc | null | undefined) =>
  b == null || DateTime.isGreaterThan(a, b);

/**
 * What needs the user in one environment's unsettled threads: a pending
 * question or approval, a failed latest run, or a finished run the user has
 * not opened since. Each thread gives at most one item, the most pressing.
 */
export const deriveAttention = (input: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly now: DateTime.Utc;
  /** Coordinator threads report to the user directly, not through an inbox. */
  readonly exclude: ReadonlySet<ThreadId>;
}): ReadonlyArray<CoordinatorInboxItem> => {
  const items: Array<CoordinatorInboxItem> = [];
  for (const thread of input.threads) {
    if (
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      !isListedThreadLineage(thread.lineage) ||
      input.exclude.has(thread.id) ||
      (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, input.now))
    ) {
      continue;
    }
    const base = {
      title: thread.title,
      thread: { environmentId: input.environmentId, threadId: thread.id },
      environmentLabel: input.environmentLabel,
    };
    const request = thread.pendingRuntimeRequest;
    if (request !== null && request.blocking !== false) {
      const kind = request.kind === "user_input" ? "question" : "approval";
      items.push({
        ...base,
        id: `${kind}:${input.environmentId}:${thread.id}:${request.id}`,
        kind,
        detail:
          thread.latestVisibleMessage?.role === "assistant"
            ? clip(thread.latestVisibleMessage.text)
            : null,
        since: iso(request.createdAt),
      });
      continue;
    }
    const completedAt = thread.latestRunCompletedAt ?? null;
    if (thread.status === "failed") {
      const at = completedAt ?? thread.updatedAt;
      if (!isAfter(at, thread.lastVisitedAt)) continue;
      items.push({
        ...base,
        id: `failed:${input.environmentId}:${thread.id}:${thread.latestRunId ?? ""}`,
        kind: "failed",
        detail: thread.lastError ? clip(thread.lastError) : null,
        since: iso(at),
      });
      continue;
    }
    if (thread.status === "completed" && completedAt !== null) {
      if (!isAfter(completedAt, thread.lastVisitedAt)) continue;
      items.push({
        ...base,
        id: `unread:${input.environmentId}:${thread.id}:${thread.latestRunId ?? ""}`,
        kind: "unread",
        detail:
          thread.latestVisibleMessage?.role === "assistant"
            ? clip(thread.latestVisibleMessage.text)
            : null,
        since: iso(completedAt),
      });
    }
  }
  return items;
};

const KIND_RANK: Record<CoordinatorInboxItem["kind"], number> = {
  question: 0,
  approval: 0,
  note: 1,
  failed: 2,
  unread: 3,
};

/** Needs-you kinds first, then newest first within a kind. */
export const sortInboxItems = (items: ReadonlyArray<CoordinatorInboxItem>) =>
  [...items].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || (a.since < b.since ? 1 : -1));
