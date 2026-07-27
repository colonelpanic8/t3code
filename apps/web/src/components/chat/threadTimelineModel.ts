import type { MessageId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import type { ChatMessage, TurnDiffSummary } from "../../types";

/**
 * Pure derivation steps that turn thread detail state into the inputs of
 * MessagesTimeline. Extracted from ChatView so the pipeline can run outside
 * the full app shell (perf harnesses, tests) and so its per-update cost is
 * visible in one place: every function here re-runs on every thread state
 * publication, including once per replayed streaming delta event.
 */

/** Swaps message attachment previews to resolved asset URLs when available. */
export function deriveDisplayServerMessages(
  serverMessages: ReadonlyArray<ChatMessage> | undefined,
  attachmentPreviewUrlById: ReadonlyMap<string, string>,
): ReadonlyArray<ChatMessage> {
  if (!serverMessages) return [];
  return serverMessages.map((message) => {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }
    return {
      ...message,
      attachments: message.attachments.map((attachment) => {
        const previewUrl = attachmentPreviewUrlById.get(attachment.id);
        return previewUrl ? { ...attachment, previewUrl } : attachment;
      }),
    };
  });
}

/**
 * Overlays local attachment preview handoffs onto server messages and appends
 * optimistic user messages the server has not echoed back yet.
 */
export function deriveTimelineMessages({
  displayServerMessages,
  attachmentPreviewHandoffByMessageId,
  optimisticUserMessages,
}: {
  displayServerMessages: ReadonlyArray<ChatMessage>;
  attachmentPreviewHandoffByMessageId: Record<string, string[]>;
  optimisticUserMessages: ReadonlyArray<ChatMessage>;
}): ReadonlyArray<ChatMessage> {
  const messages = displayServerMessages;
  const serverMessagesWithPreviewHandoff =
    Object.keys(attachmentPreviewHandoffByMessageId).length === 0
      ? messages
      : // Spread only fires for the few messages that actually changed;
        // unchanged ones early-return their original reference.
        // In-place mutation would break React's immutable state contract.
        messages.map((message) => {
          if (message.role !== "user" || !message.attachments || message.attachments.length === 0) {
            return message;
          }
          const handoffPreviewUrls = attachmentPreviewHandoffByMessageId[message.id];
          if (!handoffPreviewUrls || handoffPreviewUrls.length === 0) {
            return message;
          }

          let changed = false;
          let imageIndex = 0;
          const attachments = message.attachments.map((attachment) => {
            if (attachment.type !== "image") {
              return attachment;
            }
            const handoffPreviewUrl = handoffPreviewUrls[imageIndex];
            imageIndex += 1;
            if (!handoffPreviewUrl || attachment.previewUrl === handoffPreviewUrl) {
              return attachment;
            }
            changed = true;
            return {
              ...attachment,
              previewUrl: handoffPreviewUrl,
            };
          });

          return changed ? { ...message, attachments } : message;
        });

  if (optimisticUserMessages.length === 0) {
    return serverMessagesWithPreviewHandoff;
  }
  const serverIds = new Set(serverMessagesWithPreviewHandoff.map((message) => message.id));
  const pendingMessages = optimisticUserMessages.filter((message) => !serverIds.has(message.id));
  if (pendingMessages.length === 0) {
    return serverMessagesWithPreviewHandoff;
  }
  return [...serverMessagesWithPreviewHandoff, ...pendingMessages];
}

export function deriveTurnDiffSummaryByAssistantMessageId(
  turnDiffSummaries: ReadonlyArray<TurnDiffSummary>,
): Map<MessageId, TurnDiffSummary> {
  const byMessageId = new Map<MessageId, TurnDiffSummary>();
  for (const summary of turnDiffSummaries) {
    if (!summary.assistantMessageId) continue;
    byMessageId.set(summary.assistantMessageId, summary);
  }
  return byMessageId;
}

/**
 * For each user message, the checkpoint turn count of the first following
 * assistant message that has a turn diff summary.
 */
export function deriveRevertTurnCountByUserMessageId({
  timelineEntries,
  turnDiffSummaryByAssistantMessageId,
  inferredCheckpointTurnCountByTurnId,
}: {
  timelineEntries: ReadonlyArray<TimelineEntry>;
  turnDiffSummaryByAssistantMessageId: ReadonlyMap<MessageId, TurnDiffSummary>;
  inferredCheckpointTurnCountByTurnId: Record<TurnId, number>;
}): Map<MessageId, number> {
  const byUserMessageId = new Map<MessageId, number>();
  for (let index = 0; index < timelineEntries.length; index += 1) {
    const entry = timelineEntries[index];
    if (!entry || entry.kind !== "message" || entry.message.role !== "user") {
      continue;
    }

    for (let nextIndex = index + 1; nextIndex < timelineEntries.length; nextIndex += 1) {
      const nextEntry = timelineEntries[nextIndex];
      if (!nextEntry || nextEntry.kind !== "message") {
        continue;
      }
      if (nextEntry.message.role === "user") {
        break;
      }
      const summary = turnDiffSummaryByAssistantMessageId.get(nextEntry.message.id);
      if (!summary) {
        continue;
      }
      const turnCount =
        summary.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[summary.turnId];
      if (typeof turnCount !== "number") {
        break;
      }
      byUserMessageId.set(entry.message.id, Math.max(0, turnCount - 1));
      break;
    }
  }

  return byUserMessageId;
}
