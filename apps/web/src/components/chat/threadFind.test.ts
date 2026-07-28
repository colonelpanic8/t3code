import { describe, expect, it } from "vite-plus/test";
import { type TurnId } from "@t3tools/contracts";
import { type TimelineEntry } from "../../session-logic";
import {
  buildThreadFindMatches,
  clampThreadFindIndex,
  findThreadTextOccurrences,
  formatThreadFindCount,
  isThreadFindActiveForThread,
  searchableThreadEntryText,
  stepThreadFindIndex,
} from "./threadFind";

function userEntry(id: string, text: string, turnId: string | null = null): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00.000Z",
    message: {
      id,
      role: "user",
      text,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      streaming: false,
      turnId: turnId as TurnId | null,
    },
  } as unknown as TimelineEntry;
}

function assistantEntry(id: string, text: string, turnId: string | null = null): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:01.000Z",
    message: {
      id,
      role: "assistant",
      text,
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
      streaming: false,
      turnId: turnId as TurnId | null,
    },
  } as unknown as TimelineEntry;
}

function workEntry(id: string, message: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: "2026-01-01T00:00:02.000Z",
    entry: { id, message, createdAt: "2026-01-01T00:00:02.000Z" },
  } as unknown as TimelineEntry;
}

function proposedPlanEntry(id: string, planMarkdown: string): TimelineEntry {
  return {
    id,
    kind: "proposed-plan",
    createdAt: "2026-01-01T00:00:03.000Z",
    proposedPlan: {
      id,
      turnId: null,
      planMarkdown,
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:03.000Z",
    },
  } as unknown as TimelineEntry;
}

describe("findThreadTextOccurrences", () => {
  it("matches case-insensitively", () => {
    expect(findThreadTextOccurrences("Deploy the Deployment", "deploy")).toEqual([0, 11]);
  });

  it("counts overlapping candidates only once, matching what a highlighter can paint", () => {
    expect(findThreadTextOccurrences("aaa", "aa")).toEqual([0]);
    expect(findThreadTextOccurrences("aaaa", "aa")).toEqual([0, 2]);
  });

  it("returns nothing for empty inputs", () => {
    expect(findThreadTextOccurrences("", "a")).toEqual([]);
    expect(findThreadTextOccurrences("a", "")).toEqual([]);
  });

  it("keeps offsets valid when lowercasing would change the string's length", () => {
    // "İ".toLowerCase() is "i" + a combining dot — one code unit longer. Naive
    // lowercased offsets would report "x" at 2 and push Range.setEnd past the
    // end of the original text node.
    expect(findThreadTextOccurrences("İx", "x")).toEqual([1]);
    expect(findThreadTextOccurrences("İİİ needle", "needle")).toEqual([4]);
    // The exotic character itself simply does not case-fold.
    expect(findThreadTextOccurrences("İ", "İ")).toEqual([0]);
  });

  it("still case-folds surrogate-pair characters", () => {
    // Deseret capital 𐐀 lowercases to 𐐨 — same UTF-16 length, so it folds.
    expect(findThreadTextOccurrences("𐐀x", "𐐨")).toEqual([0]);
  });
});

describe("searchableThreadEntryText", () => {
  it("searches the user text the timeline actually shows, not the appended contexts", () => {
    const prompt = [
      "check the build",
      "",
      "<terminal_context>",
      "- pnpm build:",
      "  secret sentinel output",
      "</terminal_context>",
    ].join("\n");

    const searchable = searchableThreadEntryText(userEntry("m1", prompt));

    expect(searchable).toBe("check the build");
    expect(searchable).not.toContain("sentinel");
  });

  it("skips work-log entries", () => {
    expect(searchableThreadEntryText(workEntry("w1", "ran the sentinel command"))).toBeNull();
  });

  it("covers proposed plans", () => {
    expect(
      searchableThreadEntryText(proposedPlanEntry("p1", "## Plan\n\n## Summary\n\nship it")),
    ).toBe("ship it");
  });
});

describe("buildThreadFindMatches", () => {
  const entries: TimelineEntry[] = [
    userEntry("m1", "deploy the service", "turn-1"),
    assistantEntry("m2", "Deploying now. Deploy finished.", "turn-1"),
    workEntry("w1", "deploy ran"),
    proposedPlanEntry("p1", "deploy plan"),
  ];

  it("emits one match per occurrence, in timeline order, carrying the owning turn", () => {
    expect(buildThreadFindMatches(entries, "deploy")).toEqual([
      { entryId: "m1", turnId: "turn-1", occurrence: 0, offset: 0 },
      { entryId: "m2", turnId: "turn-1", occurrence: 0, offset: 0 },
      { entryId: "m2", turnId: "turn-1", occurrence: 1, offset: 15 },
      { entryId: "p1", turnId: null, occurrence: 0, offset: 0 },
    ]);
  });

  it("tracks a match's text offset as streaming edits reassign its ordinal", () => {
    expect(buildThreadFindMatches([assistantEntry("m1", "one x then x")], "x")).toEqual([
      { entryId: "m1", turnId: null, occurrence: 0, offset: 4 },
      { entryId: "m1", turnId: null, occurrence: 1, offset: 11 },
    ]);
    expect(buildThreadFindMatches([assistantEntry("m1", "one then x")], "x")).toEqual([
      { entryId: "m1", turnId: null, occurrence: 0, offset: 9 },
    ]);
  });

  it("does not count proposed-plan text that the card strips before rendering", () => {
    const plan = proposedPlanEntry(
      "p1",
      "# Hidden title sentinel\n\n## Summary\n\nVisible body sentinel",
    );

    expect(buildThreadFindMatches([plan], "hidden")).toEqual([]);
    expect(buildThreadFindMatches([plan], "summary")).toEqual([]);
    expect(buildThreadFindMatches([plan], "sentinel")).toEqual([
      { entryId: "p1", turnId: null, occurrence: 0, offset: 13 },
    ]);
  });

  it("ignores blank and whitespace-only queries", () => {
    expect(buildThreadFindMatches(entries, "")).toEqual([]);
    expect(buildThreadFindMatches(entries, "   ")).toEqual([]);
  });

  it("trims the query rather than searching for the untrimmed string", () => {
    expect(buildThreadFindMatches(entries, "  deploy  ")).toHaveLength(4);
  });
});

describe("isThreadFindActiveForThread", () => {
  it("rejects open state that belongs to the previously active thread", () => {
    expect(
      isThreadFindActiveForThread(
        { open: true, threadKey: "environment:thread-a" },
        "environment:thread-b",
      ),
    ).toBe(false);
  });

  it("accepts open state only for its owning active thread", () => {
    expect(
      isThreadFindActiveForThread(
        { open: true, threadKey: "environment:thread-a" },
        "environment:thread-a",
      ),
    ).toBe(true);
    expect(
      isThreadFindActiveForThread(
        { open: false, threadKey: "environment:thread-a" },
        "environment:thread-a",
      ),
    ).toBe(false);
  });
});

describe("clampThreadFindIndex", () => {
  it("keeps the index inside a shrinking match list", () => {
    expect(clampThreadFindIndex(4, 2)).toBe(1);
    expect(clampThreadFindIndex(4, 0)).toBe(0);
    expect(clampThreadFindIndex(-1, 3)).toBe(0);
  });
});

describe("stepThreadFindIndex", () => {
  it("wraps in both directions", () => {
    expect(stepThreadFindIndex(2, 3, 1)).toBe(0);
    expect(stepThreadFindIndex(0, 3, -1)).toBe(2);
  });

  it("stays at zero without matches", () => {
    expect(stepThreadFindIndex(0, 0, 1)).toBe(0);
  });
});

describe("formatThreadFindCount", () => {
  it("never reports a position past the end", () => {
    expect(formatThreadFindCount(4, 2)).toBe("2/2");
    expect(formatThreadFindCount(0, 0)).toBe("0/0");
    expect(formatThreadFindCount(1, 3)).toBe("2/3");
  });
});
