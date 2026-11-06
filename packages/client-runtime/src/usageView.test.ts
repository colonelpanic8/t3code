import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageChartSeries,
  layoutUsageBreakdown,
  parseUsageViewPreferences,
  usageSeriesLabels,
  usageTableView,
  withSortField,
  withTableDimensions,
  withoutChartProviders,
  type UsageSeriesPalette,
} from "./usageView.ts";

function entry(
  provider: UsageProviderKind,
  model: string,
  costUsd: number,
  day = "2026-08-07",
): UsageEntry {
  return {
    environmentId: "mac" as EnvironmentId,
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
      unpricedRecords: 0,
      sessions: 1,
    },
  };
}

const providerLabels = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse Code",
};
const palette: UsageSeriesPalette = {
  series: ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"],
  other: "other",
  total: "total",
  providers: {
    claude: "claude-color",
    codex: "codex-color",
    grok: "grok-color",
    cursor: "cursor-color",
    opencode: "opencode-color",
    antigravity: "antigravity-color",
    pi: "pi-color",
    muse: "muse-color",
  },
};
const context = {
  environmentLabels: new Map([["mac" as EnvironmentId, "MacBook"]]),
  providerLabels,
  grouping: "day" as const,
  timeZone: "UTC",
  hour12: true,
};
const periods = ["2026-08-07", "2026-08-08"];

describe("parseUsageViewPreferences", () => {
  it("keeps a valid saved view", () => {
    const view = {
      chartDimensions: ["host", "account", "model"],
      tableDimensions: ["provider", "period"],
      sort: [
        { field: "period", direction: "descending" },
        { field: "label", direction: "ascending" },
      ],
      timeGrouping: "week",
    };
    expect(parseUsageViewPreferences(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });

  it("drops only the settings it cannot use and de-duplicates the rest", () => {
    expect(
      parseUsageViewPreferences({
        chartDimensions: ["provider", "machine"],
        tableDimensions: ["model", "period", "model"],
        sort: [
          { field: "totalTokens", direction: "ascending" },
          { field: "totalTokens", direction: "descending" },
          { field: "costUsd", direction: "descending" },
        ],
        timeGrouping: "hour",
      }),
    ).toEqual({
      tableDimensions: ["model", "period"],
      sort: [
        { field: "totalTokens", direction: "ascending" },
        { field: "costUsd", direction: "descending" },
      ],
    });
  });

  it.each([
    [null],
    ["provider"],
    [{ sort: [] }],
    [{ sort: [{ field: "costUsd", direction: "sideways" }] }],
    [{ sort: ["costUsd"] }],
    [{ chartDimensions: "provider" }],
  ])("ignores an unusable saved view: %j", (stored) => {
    expect(parseUsageViewPreferences(stored)).toEqual({});
  });
});

describe("table view", () => {
  const view = usageTableView({ tableDimensions: ["model"] }, "tokens");

  it("sorts by the metric until a sort is picked, and reverses a re-picked field", () => {
    expect(view.sort).toEqual([{ field: "totalTokens", direction: "descending" }]);
    expect(withSortField(view, "totalTokens")).toEqual({
      sort: [{ field: "totalTokens", direction: "ascending" }],
    });
    expect(withSortField(view, "label")).toEqual({
      sort: [{ field: "label", direction: "ascending" }],
    });
  });

  it("brings the period along with a period sort and drops the sort with the period", () => {
    const byPeriod = withSortField(view, "period");
    expect(byPeriod).toEqual({
      tableDimensions: ["model", "period"],
      sort: [{ field: "period", direction: "descending" }],
    });
    const periodView = usageTableView(byPeriod, "tokens");
    expect(withTableDimensions(periodView, ["model"])).toEqual({
      tableDimensions: ["model"],
      sort: undefined,
    });
  });
});

describe("buildUsageChartSeries", () => {
  it("keeps provider colors when split by provider alone", () => {
    const entries = [entry("claude", "opus", 3), entry("codex", "gpt", 2)];
    const series = buildUsageChartSeries(entries, ["provider"], "day", periods, "cost", palette);

    expect(series.stack.series.map((entry) => series.colors.get(entry.key))).toEqual([
      "claude-color",
      "codex-color",
    ]);
    expect(
      buildUsageChartSeries(entries, [], "day", periods, "cost", palette).colors.get("[]"),
    ).toBe("total");
  });

  it("assigns palette slots in key order, not rank, and folds the rest into Other", () => {
    const entries = Array.from({ length: 11 }, (_, index) =>
      entry("claude", `m${String(index).padStart(2, "0")}`, 11 - index),
    );
    const series = buildUsageChartSeries(entries, ["model"], "day", periods, "cost", palette);
    const colorOf = (model: string) =>
      series.colors.get(series.stack.series.find((entry) => entry.row?.model === model)!.key);

    expect(series.stack.series).toHaveLength(10);
    expect(colorOf("m00")).toBe("s0");
    expect(colorOf("m08")).toBe("s8");
    expect(series.colors.get("other")).toBe("other");
    expect(series.stack.folded.map((key) => series.colors.get(key))).toEqual(["other", "other"]);

    const reranked = buildUsageChartSeries(
      [entry("claude", "m00", 1), entry("claude", "m08", 5)],
      ["model"],
      "day",
      periods,
      "cost",
      palette,
    );
    expect(reranked.stack.series.map((entry) => reranked.colors.get(entry.key))).toEqual([
      "s1",
      "s0",
    ]);
  });
});

describe("withoutChartProviders", () => {
  it("drops a hidden provider's usage from every split while the rest keep their colors", () => {
    const entries = [
      entry("claude", "opus", 3),
      entry("codex", "gpt", 2),
      entry("cursor", "zeta", 1, "2026-08-08"),
    ];
    const full = buildUsageChartSeries(entries, ["model"], "day", periods, "cost", palette);
    const shown = withoutChartProviders(
      full,
      entries,
      new Set(["codex"]),
      "day",
      periods,
      "cost",
      palette,
    );
    const colorsOf = (series: typeof full) =>
      series.stack.series.map((entry) => [entry.row?.model, series.colors.get(entry.key)]);

    expect(colorsOf(shown)).toEqual(colorsOf(full).filter(([model]) => model !== "gpt"));
    expect(shown.stack.columns.map((column) => column.total)).toEqual([3, 1]);
    expect(withoutChartProviders(full, entries, new Set(), "day", periods, "cost", palette)).toBe(
      full,
    );
  });
});

it("names a model several providers serve with its provider", () => {
  const entries = [entry("opencode", "gpt-a", 3), entry("codex", "gpt-a", 2)];
  const series = buildUsageChartSeries(entries, ["model"], "day", periods, "cost", palette);

  expect(usageSeriesLabels(series.stack.series, ["model"], context)).toEqual([
    "OpenCode · gpt-a",
    "Codex · gpt-a",
  ]);
});

it("groups breakdown rows under periods and marks them with their chart band", () => {
  const entries = [
    entry("claude", "opus", 3),
    entry("codex", "gpt", 1),
    entry("claude", "opus", 2, "2026-08-08"),
  ];
  const chart = buildUsageChartSeries(entries, ["provider"], "day", periods, "cost", palette);
  const table = layoutUsageBreakdown(
    entries,
    usageTableView(
      {
        tableDimensions: ["model", "period"],
        sort: [
          { field: "period", direction: "descending" },
          { field: "costUsd", direction: "descending" },
        ],
      },
      "cost",
    ),
    context,
    chart,
  );

  expect(table.grouped).toBe(true);
  expect(
    table.groups.map((group) => [
      group.heading.text,
      group.costUsd,
      group.rows.map(({ name }) => [name.text, name.color, name.provider]),
    ]),
  ).toEqual([
    ["Aug 8", 2, [["opus", "claude-color", "claude"]]],
    [
      "Aug 7",
      4,
      [
        ["opus", "claude-color", "claude"],
        ["gpt", "codex-color", "codex"],
      ],
    ],
  ]);
});
