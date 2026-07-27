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
 * Offsets of every non-overlapping occurrence, case-insensitively. Advancing by
 * the needle length (not by one) keeps the count in step with what a
 * left-to-right highlighter can actually paint: "aa" occurs once in "aaa".
 */
export function findThreadTextOccurrences(haystack: string, needle: string): number[] {
  if (needle.length === 0 || haystack.length === 0) {
    return [];
  }
  const lowerHaystack = haystack.toLowerCase();
  const lowerNeedle = needle.toLowerCase();
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
