import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";
import {
  layoutBreakdownTable,
  usageTableView,
  withTableDimensions,
  withTableSort,
  type UsageTableView,
} from "./UsageBreakdownTable";
import type { UsageChartDimension } from "./usagePagePreferences";
import { buildUsageChartSeries } from "./usageSeries";
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
  hour12: true,
};
function layout(
  entries: readonly UsageEntry[],
  view: UsageTableView,
  chartDimensions: readonly UsageChartDimension[] = [],
) {
  const periods = ["2026-08-07", "2026-08-08"];
  return layoutBreakdownTable(
    entries,
    view,
    context,
    buildUsageChartSeries(entries, chartDimensions, "day", periods, "cost"),
  );
}
describe("layoutBreakdownTable", () => {
  const entries = [
    entry("mac", "2026-08-07", "gpt-a", 3),
    entry("mac", "2026-08-07", "gpt-b", 1),
    entry("mac", "2026-08-08", "gpt-a", 2),
  ];
  it("heads each period group with its total and names rows without repeating the period", () => {
    const table = layout(entries, {
      tableDimensions: ["environment", "model", "period"],
      sort: [
        {
          field: "period",
          direction: "descending",
        },
        {
          field: "costUsd",
          direction: "descending",
        },
      ],
    });
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
    const table = layout(entries, {
      tableDimensions: ["model", "period"],
      sort: [
        {
          field: "costUsd",
          direction: "ascending",
        },
      ],
    });
    expect(table.grouped).toBe(false);
    expect(table.groups.flatMap((group) => group.rows.map((row) => row.name.text))).toEqual([
      "gpt-b · Aug 7",
      "gpt-a · Aug 8",
      "gpt-a · Aug 7",
    ]);
  });
  it("heads each model with its periods when sorted by name", () => {
    const table = layout(entries, {
      tableDimensions: ["model", "period"],
      sort: [
        {
          field: "label",
          direction: "ascending",
        },
        {
          field: "period",
          direction: "ascending",
        },
      ],
    });
    expect(
      table.groups.map((group) => [group.heading.text, group.rows.map((row) => row.name.text)]),
    ).toEqual([
      ["gpt-a", ["Aug 7", "Aug 8"]],
      ["gpt-b", ["Aug 7"]],
    ]);
  });
  it("stays flat when sorting by name leaves nothing to head groups with", () => {
    const table = layout(entries, {
      tableDimensions: ["period"],
      sort: [
        {
          field: "label",
          direction: "ascending",
        },
      ],
    });
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
    const table = layout(
      entries,
      {
        tableDimensions: ["model"],
        sort: [
          {
            field: "label",
            direction: "ascending",
          },
        ],
      },
      ["model"],
    );
    expect(table.grouped).toBe(false);
    expect(
      table.groups.flatMap((group) =>
        group.rows.map(({ row, name }) => [name.text, name.provider, name.color, row.costUsd]),
      ),
    ).toEqual([
      ["gpt-a", "codex", "oklch(0.68 0.13 255)", 4],
      ["gpt-a", "opencode", "oklch(0.68 0.13 40)", 6],
    ]);
  });
  it("heads each provider's model with its own periods when sorted by name", () => {
    const table = layout(
      entries,
      {
        tableDimensions: ["model", "period"],
        sort: [
          {
            field: "label",
            direction: "ascending",
          },
          {
            field: "period",
            direction: "ascending",
          },
        ],
      },
      ["model"],
    );
    expect(
      table.groups.map((group) => [
        group.heading,
        group.costUsd,
        group.rows.map(({ name }) => name),
      ]),
    ).toEqual([
      [
        {
          text: "gpt-a",
          provider: "codex",
          color: "oklch(0.68 0.13 255)",
        },
        4,
        [
          {
            text: "Aug 7",
            provider: undefined,
            color: undefined,
          },
          {
            text: "Aug 8",
            provider: undefined,
            color: undefined,
          },
        ],
      ],
      [
        {
          text: "gpt-a",
          provider: "opencode",
          color: "oklch(0.68 0.13 40)",
        },
        6,
        [
          {
            text: "Aug 7",
            provider: undefined,
            color: undefined,
          },
          {
            text: "Aug 8",
            provider: undefined,
            color: undefined,
          },
        ],
      ],
    ]);
  });
});
describe("table view transitions", () => {
  it("adds the period dimension when sorting by period", () => {
    expect(
      withTableSort({
        tableDimensions: ["model"],
        sort: [
          {
            field: "period",
            direction: "descending",
          },
        ],
      }),
    ).toEqual({
      tableDimensions: ["model", "period"],
      sort: [
        {
          field: "period",
          direction: "descending",
        },
      ],
    });
  });
  it("drops the period sort with the period dimension, clearing a sort left empty", () => {
    expect(
      withTableDimensions(
        {
          tableDimensions: ["model", "period"],
          sort: [
            {
              field: "period",
              direction: "descending",
            },
          ],
        },
        ["model"],
      ),
    ).toEqual({
      tableDimensions: ["model"],
      sort: undefined,
    });
  });
  it("saves no sort when a dimension change leaves the sort alone", () => {
    expect(
      withTableDimensions(
        {
          tableDimensions: ["model"],
          sort: [
            {
              field: "totalTokens",
              direction: "descending",
            },
          ],
        },
        ["model", "period"],
      ),
    ).toEqual({
      tableDimensions: ["model", "period"],
    });
  });
});
describe("usageTableView", () => {
  it("sorts by the page's metric until a sort is saved", () => {
    const unsorted = {
      tableDimensions: undefined,
      sort: undefined,
    };
    expect(usageTableView(unsorted, "tokens")).toEqual({
      tableDimensions: ["model"],
      sort: [
        {
          field: "totalTokens",
          direction: "descending",
        },
      ],
    });
    expect(usageTableView(unsorted, "cost")).toEqual({
      tableDimensions: ["model"],
      sort: [
        {
          field: "costUsd",
          direction: "descending",
        },
      ],
    });
  });
  it("keeps a saved sort whatever the metric", () => {
    expect(
      usageTableView(
        {
          tableDimensions: ["provider"],
          sort: [
            {
              field: "period",
              direction: "ascending",
            },
          ],
        },
        "tokens",
      ),
    ).toEqual({
      tableDimensions: ["provider", "period"],
      sort: [
        {
          field: "period",
          direction: "ascending",
        },
      ],
    });
  });
});
