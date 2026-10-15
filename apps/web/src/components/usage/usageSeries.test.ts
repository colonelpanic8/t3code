import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { buildStackedColumns } from "@t3tools/shared/usagePivot";
import { describe, expect, it } from "vite-plus/test";

import { usageSeriesLabels } from "./usageSeries";

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
};
const periods = ["2026-08-07"];

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
