import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { deriveThreadTitleSeed } from "@t3tools/client-runtime/operations";

import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(composerDraftsAtom);
  return useMemo(
    () => {
      const tasks = buildPendingNewTasks({
        queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
        drafts,
      });
      return tasks.map((task) =>
        task.kind === "pending"
          ? {
              ...task,
              title: deriveThreadTitleSeed({
                text: task.message.text,
                attachments: task.message.attachments,
              }),
            }
          : task,
      );
    },
    [queuedMessagesByThreadKey, drafts],
  );
}
