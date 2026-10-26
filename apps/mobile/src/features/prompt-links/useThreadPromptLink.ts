import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseThreadLinkPrompt } from "@t3tools/shared/promptLinks";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { isLaunchedFromHistory } from "../../native/android-intents";
import { mobilePreferencesAtom } from "../../state/preferences";
import { applyLinkedPromptToThreadDraft, sendLinkedPromptToThread } from "./prompt-link-actions";
import {
  clearedPromptLinkParams,
  linkedThreadPromptDelivery,
  promptLinkNotice,
  promptLinkRequestsSend,
  promptLinkSearchFromParams,
} from "./prompt-link-model";

const THREAD_LINK_KEYS = ["prompt", "send"];

export function useThreadPromptLink(
  params: Readonly<Record<string, unknown>> | undefined,
  target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null,
  threadDraftKey: string | null,
) {
  const navigation = useNavigation();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const sendEnabled = AsyncResult.isSuccess(preferences)
    ? preferences.value.linkPromptSendEnabled === true
    : null;
  const search = promptLinkSearchFromParams(params, THREAD_LINK_KEYS);
  const handledSearchRef = useRef<string | null>(null);
  useEffect(() => {
    if (search === null) {
      handledSearchRef.current = null;
      return;
    }
    if (
      target === null ||
      threadDraftKey === null ||
      sendEnabled === null ||
      handledSearchRef.current === search
    ) {
      return;
    }
    handledSearchRef.current = search;
    navigation.setParams(clearedPromptLinkParams(THREAD_LINK_KEYS));
    const parsed = parseThreadLinkPrompt(search);
    if (!parsed.ok) {
      Dialog.alert("Could not open link", parsed.error);
      return;
    }
    if (parsed.value === null) return;
    const sendRequested = promptLinkRequestsSend(search);
    const delivery = linkedThreadPromptDelivery({
      sendRequested,
      sendEnabled,
      launchedFromHistory: sendRequested && isLaunchedFromHistory(),
      hiddenCharacters: parsed.value.hiddenCharacters,
    });
    if (delivery.kind === "send") {
      void sendLinkedPromptToThread(target, parsed.value);
      return;
    }
    void applyLinkedPromptToThreadDraft(
      threadDraftKey,
      parsed.value,
      promptLinkNotice({
        hiddenCharacters: parsed.value.hiddenCharacters,
        sendBlocked: delivery.sendBlocked,
      }),
    );
  }, [navigation, search, sendEnabled, target, threadDraftKey]);
}
