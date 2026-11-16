import type { EnvironmentId, UsageDay } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { UsageBreakdownTable } from "./UsageBreakdownTable";
import { buildUsageChartSeries } from "./usageSeries";

const DAY_MS = 86_400_000;
const entries: UsageEntry[] = Array.from({ length: 250 }, (_, index) => ({
  environmentId: "mac" as EnvironmentId,
  bucket: {
    day: new Date(Date.UTC(2026, 0, 1) + index * DAY_MS).toISOString().slice(0, 10) as UsageDay,
    provider: "codex",
    model: "gpt",
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd: 1,
    cacheSavingsUsd: 0,
    costSource: "modelPriced",
    records: 1,
    unpricedRecords: 0,
    sessions: 1,
  },
}));

describe("UsageBreakdownTable", () => {
  const table = (rows: readonly UsageEntry[]) => (
    <UsageBreakdownTable
      entries={rows}
      view={{
        tableDimensions: ["period"],
        sort: [{ field: "period", direction: "ascending" }],
      }}
      chartSeries={buildUsageChartSeries(rows, [], "day", [], "cost")}
      onViewChange={() => {}}
      grouping="day"
      metric="cost"
      environmentLabels={new Map()}
      timeZone="UTC"
      hour12={true}
      loadingProviders={new Set()}
      onOpenModel={() => {}}
    />
  );

  it("renders the first 200 rows until asked for all of them", async () => {
    await using screen = await render(table(entries));
    const bodyRows = () => screen.container.querySelectorAll("tbody > tr");
    const showAllButton = () =>
      [...screen.container.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Show all"),
      );

    expect(bodyRows()).toHaveLength(200);
    const button = showAllButton();
    expect(button?.textContent).toBe("Show all 250 rows");

    await userEvent.click(button!);

    expect(bodyRows()).toHaveLength(250);
    expect(showAllButton()).toBeUndefined();
  });

  it("renders a short table whole, without the control", async () => {
    await using screen = await render(table(entries.slice(0, 3)));

    expect(screen.container.querySelectorAll("tbody > tr")).toHaveLength(3);
    await expect.element(screen.getByRole("button", { name: /Show all/ })).not.toBeInTheDocument();
  });
});
