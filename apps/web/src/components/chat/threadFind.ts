import { type TurnId } from "@t3tools/contracts";
import { type TimelineEntry } from "../../session-logic";
import { deriveDisplayedUserMessageContent } from "~/lib/visibleMessageText";

/**
 * One occurrence of the find query inside one timeline entry.
 *
 * Matches are modeled against timeline *entries* rather than rendered DOM
 * nodes: entries exist even while their row is folded away or unmounted by the
 * virtualized list, so counts stay stable and every match stays reachable.
 */
export interface ThreadFindMatch {
  /** Timeline entry id — also the id of the row that renders it. */
  entryId: string;
  /** Turn that owns the entry, used to unfold a collapsed turn when navigating. */
  turnId: TurnId | null;
  /** 0-based index of this occurrence within its own entry. */
  occurrence: number;
}

export function normalizeThreadFindQuery(query: string): string {
  return query.trim();
}

/**
 * Lowercases for matching without ever changing UTF-16 length: a code point
 * whose lowercase form is longer (e.g. "İ" → "i" + combining dot) is kept
 * as-is. Offsets into the folded string are therefore always valid in the
 * original — the exotic character merely doesn't case-fold, instead of every
 * offset after it drifting and Range.setEnd throwing past the node's length.
 */
function foldThreadFindCase(text: string): string {
  const lowered = text.toLowerCase();
  // Per-code-point lowercase mappings never shrink, so equal length means
  // every mapping was 1:1 and the fast path is exact.
  if (lowered.length === text.length) {
    return lowered;
  }
  let folded = "";
  for (const char of text) {
    const loweredChar = char.toLowerCase();
    folded += loweredChar.length === char.length ? loweredChar : char;
  }
  return folded;
}

/**
 * Offsets of every non-overlapping occurrence, case-insensitively. Advancing by
 * the needle length (not by one) keeps the count in step with what a
 * left-to-right highlighter can actually paint: "aa" occurs once in "aaa".
 */
export function findThreadTextOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0 || haystack.length === 0) {
    return [];
  }
  const lowerHaystack = foldThreadFindCase(haystack);
  const lowerNeedle = foldThreadFindCase(needle);
  const offsets: number[] = [];
  let cursor = 0;
  while (cursor <= lowerHaystack.length - lowerNeedle.length) {
    const found = lowerHaystack.indexOf(lowerNeedle, cursor);
    if (found === -1) {
      break;
    }
    offsets.push(found);
    cursor = found + lowerNeedle.length;
  }
  return offsets;
}

/**
 * The text a timeline entry puts on screen, or `null` for entries find does not
 * cover. Work-log rows (tool calls, commands, reasoning) are deliberately out of
 * scope — find targets the conversation itself.
 *
 * Assistant messages and plans are searched as markdown *source*, so syntax
 * that the renderer hides (link URLs, emphasis markers) is matched too. That is
 * intentional: extracting renderer-exact plain text would mean duplicating the
 * markdown pipeline here and drifting from it. Such a match still navigates to
 * the right message; it just may not paint.
 */
export function searchableThreadEntryText(entry: TimelineEntry): string | null {
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.planMarkdown;
  }
  if (entry.kind !== "message") {
    return null;
  }
  if (entry.message.role === "user") {
    return deriveDisplayedUserMessageContent(entry.message.text).visibleText;
  }
  return entry.message.text;
}

function threadEntryTurnId(entry: TimelineEntry): TurnId | null {
  if (entry.kind === "message") {
    return entry.message.turnId ?? null;
  }
  if (entry.kind === "proposed-plan") {
    return entry.proposedPlan.turnId ?? null;
  }
  return null;
}

export function buildThreadFindMatches(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): ThreadFindMatch[] {
  const normalized = normalizeThreadFindQuery(query);
  if (normalized.length === 0) {
    return [];
  }

  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    const text = searchableThreadEntryText(entry);
    if (text === null) {
      continue;
    }
    const occurrences = findThreadTextOccurrences(text, normalized);
    for (let occurrence = 0; occurrence < occurrences.length; occurrence += 1) {
      matches.push({ entryId: entry.id, turnId: threadEntryTurnId(entry), occurrence });
    }
  }
  return matches;
}

/**
 * Keeps the active position inside the match list as the thread changes under
 * it — a streaming edit that drops matches must not leave "5 / 2" on screen.
 */
export function clampThreadFindIndex(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  if (!Number.isFinite(index) || index < 0) {
    return 0;
  }
  return Math.min(Math.trunc(index), total - 1);
}

export function stepThreadFindIndex(index: number, total: number, delta: number): number {
  if (total <= 0) {
    return 0;
  }
  const clamped = clampThreadFindIndex(index, total);
  return (((clamped + delta) % total) + total) % total;
}

export function formatThreadFindCount(index: number, total: number): string {
  if (total <= 0) {
    return "0/0";
  }
  return `${clampThreadFindIndex(index, total) + 1}/${total}`;
}
