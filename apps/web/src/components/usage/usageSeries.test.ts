import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { buildStackedColumns, pivotUsage } from "@t3tools/shared/usagePivot";
import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageChartSeries,
  formatPeriod,
  formatPeriodShort,
  usageRowSeriesColor,
  usageSeriesLabels,
} from "./usageSeries";

function entry(provider: UsageProviderKind, model: string, costUsd: number): UsageEntry {
  return {
    environmentId: "mac" as EnvironmentId,
    bucket: {
      day: "2026-08-07" as UsageDay,
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

const context = {
  environmentLabels: new Map([["mac" as EnvironmentId, "MacBook"]]),
  grouping: "day" as const,
  timeZone: "UTC",
  hour12: true,
};
const periods = ["2026-08-07"];

it.each([
  [false, "14:00"],
  [true, "2 PM"],
] as const)(
  "uses the selected clock for hourly axis and tooltip labels (%s)",
  (hour12, expected) => {
    const instant = "2026-08-11T14:00:00.000Z";
    expect(formatPeriodShort(instant, "hour", "UTC", hour12)).toBe(expected);
    expect(formatPeriod(instant, "hour", "UTC", instant, hour12)).toBe(`${expected} today`);
  },
);

describe("usageSeriesLabels", () => {
  const entries = [
    entry("opencode", "gpt-a", 3),
    entry("codex", "gpt-a", 2),
    entry("claude", "opus", 1),
  ];

  it("names a model several providers serve with its provider", () => {
    const stack = buildStackedColumns(entries, ["environment", "model"], "day", periods, "cost");

    expect(usageSeriesLabels(stack.series, ["environment", "model"], context)).toEqual([
      "MacBook · OpenCode · gpt-a",
      "MacBook · Codex · gpt-a",
      "MacBook · opus",
    ]);
  });

  it("leaves model names alone when providers are split anyway", () => {
    const stack = buildStackedColumns(entries, ["provider", "model"], "day", periods, "cost");

    expect(usageSeriesLabels(stack.series, ["provider", "model"], context)).toEqual([
      "OpenCode · gpt-a",
      "Codex · gpt-a",
      "Claude Code · opus",
    ]);
  });
});

describe("usageRowSeriesColor", () => {
  const other = "color-mix(in oklab, var(--foreground) 40%, var(--background))";

  it("colors a row like the chart band it falls in", () => {
    const entries = [entry("claude", "opus", 3), entry("codex", "gpt", 2)];
    const series = buildUsageChartSeries(entries, ["provider"], "day", periods, "cost");
    const colorsBy = (dimensions: Parameters<typeof pivotUsage>[1]) =>
      pivotUsage(entries, dimensions, "day").map((row) => [
        row.model ?? row.environmentId,
        usageRowSeriesColor(series, row),
      ]);

    expect(colorsBy(["model"])).toEqual([
      ["opus", "#d97757"],
      ["gpt", "var(--contrast-foreground)"],
    ]);
    expect(colorsBy(["environment"])).toEqual([["mac", undefined]]);
  });

  it("gives series folded into Other the Other color", () => {
    const entries = Array.from({ length: 11 }, (_, index) =>
      entry("claude", `m${String(index).padStart(2, "0")}`, 11 - index),
    );
    const series = buildUsageChartSeries(entries, ["model"], "day", periods, "cost");

    expect(
      pivotUsage(entries, ["model", "period"], "day").map((row) => [
        row.model,
        usageRowSeriesColor(series, row),
      ]),
    ).toEqual([
      ["m00", "oklch(0.68 0.13 255)"],
      ["m01", "oklch(0.68 0.13 40)"],
      ["m02", "oklch(0.68 0.13 150)"],
      ["m03", "oklch(0.68 0.13 310)"],
      ["m04", "oklch(0.68 0.13 85)"],
      ["m05", "oklch(0.68 0.13 200)"],
      ["m06", "oklch(0.68 0.13 0)"],
      ["m07", "oklch(0.68 0.13 120)"],
      ["m08", "oklch(0.68 0.13 280)"],
      ["m09", other],
      ["m10", other],
    ]);
  });

  it("marks nothing against a single total", () => {
    const entries = [entry("claude", "opus", 3)];
    const series = buildUsageChartSeries(entries, [], "day", periods, "cost");

    expect(
      pivotUsage(entries, ["model"], "day").map((row) => usageRowSeriesColor(series, row)),
    ).toEqual([undefined]);
    expect(series.colors.get("[]")).toBe("var(--contrast-foreground)");
  });
});

it("names host and account splits in the chart and matches their table colors", () => {
  const entries = [
    {
      ...entry("claude", "opus", 3),
      host: "laptop",
      accountId: "work",
      accountLabel: "Work (laptop)",
    },
  ];
  const series = buildUsageChartSeries(entries, ["host", "account"], "day", periods, "cost");
  expect(usageSeriesLabels(series.stack.series, ["host", "account"], context)).toEqual([
    "laptop · Work (laptop)",
  ]);
  const row = pivotUsage(entries, ["host", "account", "model"], "day")[0]!;
  expect(usageRowSeriesColor(series, row)).toBe(series.colors.get(series.stack.series[0]!.key));
});
