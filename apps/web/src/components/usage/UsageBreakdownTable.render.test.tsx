import type { EnvironmentId, UsageDay } from "@t3tools/contracts";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { act } from "react";
import { create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../chat/ProviderInstanceIcon", () => ({ ProviderInstanceIcon: () => null }));
vi.mock("../ui/popover", () => ({ Popover: "div", PopoverPopup: "div", PopoverTrigger: "div" }));
vi.mock("../ui/select", () => ({
  Select: "div",
  SelectItem: "div",
  SelectPopup: "div",
  SelectTrigger: "div",
  SelectValue: "div",
}));
vi.mock("../ui/toggle-group", () => ({ Toggle: "button", ToggleGroup: "div" }));

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

function bodyRows(root: ReactTestInstance) {
  return root.findAll((node) => node.type === "tr" && node.parent?.type === "tbody");
}

function showAllButton(root: ReactTestInstance) {
  return root.findAll(
    (node) => node.type === "button" && node.children.join("").startsWith("Show all"),
  );
}

describe("UsageBreakdownTable", () => {
  it("renders the first 200 rows until asked for all of them", () => {
    let renderer: ReturnType<typeof create> | undefined;
    act(() => {
      renderer = create(
        <UsageBreakdownTable
          entries={entries}
          view={{
            tableDimensions: ["period"],
            sort: [{ field: "period", direction: "ascending" }],
          }}
          chartSeries={buildUsageChartSeries(entries, [], "day", [], "cost")}
          onViewChange={() => {}}
          grouping="day"
          metric="cost"
          environmentLabels={new Map()}
          timeZone="UTC"
          loadingProviders={new Set()}
          onOpenModel={() => {}}
        />,
      );
    });
    const root = renderer!.root;

    expect(bodyRows(root)).toHaveLength(200);
    const [button] = showAllButton(root);
    expect(button?.children.join("")).toBe("Show all 250 rows");

    act(() => button?.props.onClick());

    expect(bodyRows(root)).toHaveLength(250);
    expect(showAllButton(root)).toHaveLength(0);
  });
});
