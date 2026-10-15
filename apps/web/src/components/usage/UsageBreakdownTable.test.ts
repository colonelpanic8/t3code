import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { layoutBreakdownTable, withTableDimensions, withTableSort } from "./UsageBreakdownTable";

function entry(
  environment: string,
  day: string,
  model: string,
  costUsd: number,
  provider: UsageProviderKind = "codex",
): UsageEntry {
  return {
    environmentId: environment as EnvironmentId,
    bucket: {
      day: day as UsageDay,
      provider,
      model,
      totals: {
        uncachedInputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records: 1,
      unpricedRecords: costUsd === 0 ? 1 : 0,
      sessions: 1,
    },
  };
}

const context = {
  environmentLabels: new Map([["mac" as EnvironmentId, "MacBook"]]),
  grouping: "day" as const,
  timeZone: "UTC",
};

describe("layoutBreakdownTable", () => {
  const entries = [
    entry("mac", "2026-08-07", "gpt-a", 3),
    entry("mac", "2026-08-07", "gpt-b", 1),
    entry("mac", "2026-08-08", "gpt-a", 2),
  ];

  it("heads each period group with its total and names rows without repeating the period", () => {
    const table = layoutBreakdownTable(
      entries,
      {
        tableDimensions: ["environment", "model", "period"],
        sort: [
          { field: "period", direction: "descending" },
          { field: "costUsd", direction: "descending" },
        ],
      },
      context,
    );

    expect(table.grouped).toBe(true);
    expect(
      table.groups.map((group) => [
        group.heading.text,
        group.costUsd,
        group.rows.map((row) => row.name.text),
      ]),
    ).toEqual([
      ["Aug 8", 2, ["MacBook · gpt-a"]],
      ["Aug 7", 4, ["MacBook · gpt-a", "MacBook · gpt-b"]],
    ]);
  });

  it("lists rows flat with full names when sorted by a figure", () => {
    const table = layoutBreakdownTable(
      entries,
      {
        tableDimensions: ["model", "period"],
        sort: [{ field: "costUsd", direction: "ascending" }],
      },
      context,
    );

    expect(table.grouped).toBe(false);
    expect(table.groups.flatMap((group) => group.rows.map((row) => row.name.text))).toEqual([
      "gpt-b · Aug 7",
      "gpt-a · Aug 8",
      "gpt-a · Aug 7",
    ]);
  });

  it("heads each model with its periods when sorted by name", () => {
    const table = layoutBreakdownTable(
      entries,
      {
        tableDimensions: ["model", "period"],
        sort: [
          { field: "label", direction: "ascending" },
          { field: "period", direction: "ascending" },
        ],
      },
      context,
    );

    expect(
      table.groups.map((group) => [group.heading.text, group.rows.map((row) => row.name.text)]),
    ).toEqual([
      ["gpt-a", ["Aug 7", "Aug 8"]],
      ["gpt-b", ["Aug 7"]],
    ]);
  });

  it("stays flat when sorting by name leaves nothing to head groups with", () => {
    const table = layoutBreakdownTable(
      entries,
      { tableDimensions: ["period"], sort: [{ field: "label", direction: "ascending" }] },
      context,
    );

    expect(table.grouped).toBe(false);
    expect(table.groups.flatMap((group) => group.rows.map((row) => row.name.text))).toEqual([
      "Aug 7",
      "Aug 8",
    ]);
  });
});

describe("layoutBreakdownTable with one model name under two providers", () => {
  const entries = [
    entry("mac", "2026-08-07", "gpt-a", 3),
    entry("mac", "2026-08-08", "gpt-a", 1),
    entry("mac", "2026-08-07", "gpt-a", 2, "opencode"),
    entry("mac", "2026-08-08", "gpt-a", 4, "opencode"),
  ];

  it("lists each provider's model as its own row, marked with its provider", () => {
    const table = layoutBreakdownTable(
      entries,
      { tableDimensions: ["model"], sort: [{ field: "label", direction: "ascending" }] },
      context,
    );

    expect(table.grouped).toBe(false);
    expect(
      table.groups.flatMap((group) =>
        group.rows.map(({ row, name }) => [name.text, name.provider, row.costUsd]),
      ),
    ).toEqual([
      ["gpt-a", "codex", 4],
      ["gpt-a", "opencode", 6],
    ]);
  });

  it("heads each provider's model with its own periods when sorted by name", () => {
    const table = layoutBreakdownTable(
      entries,
      {
        tableDimensions: ["model", "period"],
        sort: [
          { field: "label", direction: "ascending" },
          { field: "period", direction: "ascending" },
        ],
      },
      context,
    );

    expect(
      table.groups.map((group) => [
        group.heading.text,
        group.heading.provider,
        group.costUsd,
        group.rows.map(({ name }) => [name.text, name.provider]),
      ]),
    ).toEqual([
      [
        "gpt-a",
        "codex",
        4,
        [
          ["Aug 7", undefined],
          ["Aug 8", undefined],
        ],
      ],
      [
        "gpt-a",
        "opencode",
        6,
        [
          ["Aug 7", undefined],
          ["Aug 8", undefined],
        ],
      ],
    ]);
  });
});

describe("table view transitions", () => {
  it("adds the period dimension when sorting by period", () => {
    expect(
      withTableSort({ tableDimensions: ["model"], sort: [] }, [
        { field: "period", direction: "descending" },
      ]),
    ).toEqual({
      tableDimensions: ["model", "period"],
      sort: [{ field: "period", direction: "descending" }],
    });
  });

  it("drops the period sort with the period dimension, falling back to cost", () => {
    expect(
      withTableDimensions(
        {
          tableDimensions: ["model", "period"],
          sort: [{ field: "period", direction: "descending" }],
        },
        ["model"],
      ),
    ).toEqual({
      tableDimensions: ["model"],
      sort: [{ field: "costUsd", direction: "descending" }],
    });
  });
});
