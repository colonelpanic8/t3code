import { useCallback, useEffect, useRef, type RefObject } from "react";
import { clampThreadFindIndex, findThreadTextOccurrences } from "./threadFind";

export const THREAD_FIND_HIGHLIGHT_NAME = "t3-thread-find";
export const THREAD_FIND_ACTIVE_HIGHLIGHT_NAME = "t3-thread-find-active";

/**
 * `data-thread-find-text` marks an element as rendering text that
 * `searchableThreadEntryText` indexes. Only text inside these regions is
 * painted; row chrome (timestamps, buttons, fold labels, work-log output)
 * stays unpainted so it can neither light up for text the counter never
 * counted nor shift the active-occurrence index within a row.
 */
const THREAD_FIND_TEXT_SELECTOR = "[data-thread-find-text]";
const THREAD_FIND_IGNORE_SELECTOR = "[data-thread-find-ignore]";

export interface ThreadFindRangeGroup<T = Range> {
  rowId: string;
  ranges: T[];
}

/**
 * Splits collected ranges into the single active one and the rest.
 *
 * Only the active *occurrence* may carry the active style — highlighting the
 * whole row would light up every match inside a message at once. The row is
 * authoritative and the occurrence index is best-effort (inline markup can
 * split an occurrence across text nodes), so the index is clamped into the row
 * rather than dropped.
 */
export function partitionThreadFindRanges<T>(
  groups: ReadonlyArray<ThreadFindRangeGroup<T>>,
  activeRowId: string | null,
  activeOccurrence: number,
): { active: T | null; inactive: T[] } {
  const inactive: T[] = [];
  let active: T | null = null;

  for (const group of groups) {
    if (active === null && group.rowId === activeRowId && group.ranges.length > 0) {
      const index = clampThreadFindIndex(activeOccurrence, group.ranges.length);
      for (let position = 0; position < group.ranges.length; position += 1) {
        const range = group.ranges[position]!;
        if (position === index) {
          active = range;
        } else {
          inactive.push(range);
        }
      }
      continue;
    }
    inactive.push(...group.ranges);
  }

  return { active, inactive };
}

interface HighlightConstructor {
  new (...ranges: Range[]): object;
}

interface HighlightRegistryLike {
  set(name: string, value: object): void;
  delete(name: string): void;
}

/**
 * The CSS Custom Highlight API paints ranges without touching the DOM, so
 * markdown output, syntax-highlighted code, copy behavior and the source
 * offsets other features derive from message text all stay untouched. Browsers
 * without it simply render no highlights; counting and navigation still work.
 */
function resolveHighlightApi(): {
  registry: HighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  const cssGlobal = globalThis.CSS as unknown as { highlights?: HighlightRegistryLike } | undefined;
  const registry = cssGlobal?.highlights;
  const Highlight = (globalThis as { Highlight?: HighlightConstructor }).Highlight;
  if (!registry || !Highlight) {
    return null;
  }
  return { registry, Highlight };
}

/**
 * Collects a range per visible occurrence, grouped by timeline row, in document
 * order. Only text inside `data-thread-find-text` regions participates, so
 * the painted set mirrors the searchable model rather than everything a row
 * happens to render. Occurrences split across text nodes by inline markup
 * (`**bo**ld`) are not matched — the model-level index owns the count, so a row
 * simply paints fewer highlights than it reports.
 */
export function collectThreadFindRanges(
  container: HTMLElement,
  query: string,
): ThreadFindRangeGroup[] {
  if (query.length === 0) {
    return [];
  }

  const ownerDocument = container.ownerDocument;
  const groups: ThreadFindRangeGroup[] = [];
  const groupsByRowId = new Map<string, ThreadFindRangeGroup>();

  for (const scope of container.querySelectorAll(THREAD_FIND_TEXT_SELECTOR)) {
    if (scope.parentElement?.closest(THREAD_FIND_TEXT_SELECTOR)) {
      continue; // Nested region — its text is already walked by the ancestor.
    }
    const rowId = scope.closest("[data-timeline-row-id]")?.getAttribute("data-timeline-row-id");
    if (!rowId) {
      continue;
    }

    const walker = ownerDocument.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.parentElement?.closest(THREAD_FIND_IGNORE_SELECTOR)) {
        node = walker.nextNode();
        continue;
      }
      const text = node.nodeValue ?? "";
      const offsets = text.length > 0 ? findThreadTextOccurrences(text, query) : [];
      if (offsets.length > 0) {
        let group = groupsByRowId.get(rowId);
        if (!group) {
          group = { rowId, ranges: [] };
          groupsByRowId.set(rowId, group);
          groups.push(group);
        }
        for (const offset of offsets) {
          const range = ownerDocument.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + query.length);
          group.ranges.push(range);
        }
      }
      node = walker.nextNode();
    }
  }

  return groups;
}

export interface ThreadFindHighlightsInput {
  container: HTMLElement | null;
  /** Normalized query; empty disables painting entirely. */
  query: string;
  /** Row id owning the active match, or null when there is no active match. */
  activeRowId: string | null;
  /** Index of the active occurrence within its row. */
  activeOccurrence: number;
}

/**
 * Paints find highlights over whatever the virtualized list currently has
 * mounted, repainting as rows mount, unmount or stream in.
 */
export function useThreadFindHighlights(input: ThreadFindHighlightsInput): {
  repaint: () => void;
  activeRangeRef: RefObject<Range | null>;
} {
  const { container, query, activeRowId, activeOccurrence } = input;
  const activeRangeRef = useRef<Range | null>(null);

  const repaint = useCallback(() => {
    const api = resolveHighlightApi();
    if (!api) {
      return;
    }
    if (!container || query.length === 0) {
      activeRangeRef.current = null;
      api.registry.delete(THREAD_FIND_HIGHLIGHT_NAME);
      api.registry.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
      return;
    }

    const { active, inactive } = partitionThreadFindRanges(
      collectThreadFindRanges(container, query),
      activeRowId,
      activeOccurrence,
    );

    activeRangeRef.current = active;
    api.registry.set(THREAD_FIND_HIGHLIGHT_NAME, new api.Highlight(...inactive));
    api.registry.set(
      THREAD_FIND_ACTIVE_HIGHLIGHT_NAME,
      new api.Highlight(...(active ? [active] : [])),
    );
  }, [activeOccurrence, activeRowId, container, query]);

  useEffect(() => {
    repaint();
  }, [repaint]);

  useEffect(() => {
    if (!container || query.length === 0) {
      return;
    }
    let frame: number | null = null;
    const schedule = () => {
      if (frame !== null) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = null;
        repaint();
      });
    };
    const observer = new MutationObserver(schedule);
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
    };
  }, [container, query, repaint]);

  useEffect(() => {
    return () => {
      const api = resolveHighlightApi();
      api?.registry.delete(THREAD_FIND_HIGHLIGHT_NAME);
      api?.registry.delete(THREAD_FIND_ACTIVE_HIGHLIGHT_NAME);
    };
  }, []);

  return { repaint, activeRangeRef };
}
