import {
  SelectableMarkdownText as T3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode"> & {
  /** Withhold highlighting while the markdown is still streaming in. */
  readonly deferHighlight?: boolean;
};

export type {
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  deferHighlight = false,
  ...props
}: MobileSelectableMarkdownTextProps) {
  return (
    <T3SelectableMarkdownText
      {...props}
      highlightCode={deferHighlight ? null : highlightCodeSnippet}
    />
  );
}
