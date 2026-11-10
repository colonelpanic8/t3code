import * as Dialog from "../../components/ui/Dialog";
import { CommandId, MessageId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { buildNewThreadLink, type LinkedPrompt } from "@t3tools/shared/promptLinks";

import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { uuidv4 } from "../../lib/uuid";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import {
  getComposerDraftSnapshot,
  setComposerDraftText,
  waitForComposerDraftsLoaded,
} from "../../state/use-composer-drafts";
import { linkedThreadDraftAction } from "./prompt-link-model";

export function showPromptLinkNotice(notice: string): void {
  Dialog.alert("Prompt from a link", notice);
}

export async function applyLinkedPromptToThreadDraft(
  draftKey: string,
  prompt: LinkedPrompt,
  notice: string,
): Promise<void> {
  try {
    await waitForComposerDraftsLoaded();
  } catch {
    Dialog.alert("Could not open link", "Drafts could not be loaded, so the prompt was not added.");
    return;
  }
  const action = linkedThreadDraftAction(getComposerDraftSnapshot(draftKey).text, prompt.text);
  if (action !== "ask") {
    if (action === "fill") setComposerDraftText(draftKey, prompt.text);
    showPromptLinkNotice(notice);
    return;
  }
  Dialog.alert("Linked prompt ready. Replace draft?", notice, [
    { text: "Keep mine", style: "cancel" },
    { text: "Replace", onPress: () => setComposerDraftText(draftKey, prompt.text) },
  ]);
}

export async function sendLinkedPromptToThread(
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
  prompt: LinkedPrompt,
): Promise<void> {
  try {
    await enqueueThreadOutboxMessage({
      environmentId: target.environmentId,
      threadId: target.threadId,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text: prompt.text,
      attachments: [],
      dispatchMode: "queue",
      createdAt: new Date().toISOString(),
    });
  } catch {
    Dialog.alert("Could not send link prompt", "The prompt could not be queued. Try again.");
  }
}

export async function copyPromptLink(prompt: string): Promise<void> {
  if (!(await tryCopyTextWithHaptic(buildNewThreadLink({ prompt }), { target: "prompt link" }))) {
    Dialog.alert("Could not copy", "Try again.");
  }
}
