import type { EnvironmentId, UsageDay } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import { layoutBreakdownTable, withTableDimensions, withTableSort } from "./UsageBreakdownTable";

function entry(environment: string, day: string, model: string, costUsd: number): UsageEntry {
  return {
    environmentId: environment as EnvironmentId,
    bucket: {
      day: day as UsageDay,
      provider: "codex",
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
        group.heading,
        group.costUsd,
        group.rows.map((row) => row.label),
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
    expect(table.groups.flatMap((group) => group.rows.map((row) => row.label))).toEqual([
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
      table.groups.map((group) => [group.heading, group.rows.map((row) => row.label)]),
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
    expect(table.groups.flatMap((group) => group.rows.map((row) => row.label))).toEqual([
      "Aug 7",
      "Aug 8",
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
