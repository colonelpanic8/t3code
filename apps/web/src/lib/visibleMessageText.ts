import {
  deriveDisplayedUserMessageState,
  type ParsedTerminalContextEntry,
} from "./terminalContext";
import { extractTrailingElementContexts, type ParsedElementContextEntry } from "./elementContext";
import {
  extractTrailingPreviewAnnotation,
  type ParsedPreviewAnnotation,
} from "./previewAnnotation";

export interface DisplayedUserMessageContent {
  /** The prompt text the timeline actually renders, with every trailing context block removed. */
  visibleText: string;
  /** The unmodified prompt, including context blocks — what "copy message" yields. */
  copyText: string;
  terminalContexts: ParsedTerminalContextEntry[];
  previewAnnotations: ParsedPreviewAnnotation[];
  elementContexts: ParsedElementContextEntry[];
}

/**
 * Peels the send-time context blocks off a user prompt in the same order the
 * timeline row does. Anything that reads "what does this message show?" — the
 * row itself, in-thread find — must go through here so the rendered text and
 * the searched text cannot drift apart.
 */
export function deriveDisplayedUserMessageContent(text: string): DisplayedUserMessageContent {
  const displayed = deriveDisplayedUserMessageState(text);
  const previewAnnotations: ParsedPreviewAnnotation[] = [];
  let visibleText = displayed.visibleText;
  while (true) {
    const extracted = extractTrailingPreviewAnnotation(visibleText);
    if (!extracted.annotation) break;
    previewAnnotations.unshift(extracted.annotation);
    visibleText = extracted.promptText;
  }
  const elementContextState = extractTrailingElementContexts(visibleText);

  return {
    visibleText: elementContextState.promptText,
    copyText: displayed.copyText,
    terminalContexts: displayed.contexts,
    previewAnnotations,
    elementContexts: [...displayed.elementContexts, ...elementContextState.contexts],
  };
}
