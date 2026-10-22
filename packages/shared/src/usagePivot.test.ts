import type { EnvironmentId, UsageDay, UsageProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { UsageEntry } from "./usageMerge.ts";
import {
  buildStackedColumns,
  enumeratePeriods,
  groupUsageRows,
  pivotUsage,
  sortUsageRows,
  usageRowKey,
  type UsagePivotRow,
} from "./usagePivot.ts";
function entry(
  environment: string,
  {
    day = "2026-08-07",
    hourStart,
    provider = "claude",
    model = "opus",
    costUsd = 1,
    tokens = 10,
    records = 1,
    unpricedRecords = 0,
  }: {
    day?: string;
    hourStart?: string;
    provider?: UsageProviderKind;
    model?: string;
    costUsd?: number;
    tokens?: number;
    records?: number;
    unpricedRecords?: number;
  } = {},
): UsageEntry {
  return {
    environmentId: environment as EnvironmentId,
    bucket: {
      day: day as UsageDay,
      ...(hourStart === undefined
        ? {}
        : {
            hourStart,
          }),
      provider,
      model,
      totals: {
        uncachedInputTokens: tokens,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd,
      cacheSavingsUsd: 0,
      costSource: "modelPriced",
      records,
      unpricedRecords,
      sessions: 1,
    },
  };
}
const label = (row: UsagePivotRow) =>
  [row.environmentId, row.provider, row.model].filter(Boolean).join(" ");
describe("pivotUsage", () => {
  it("splits by environment and model, keeping one model name under two providers apart", () => {
    const rows = pivotUsage(
      [
        entry("mac", {
          costUsd: 3,
          tokens: 30,
        }),
        entry("mac", {
          day: "2026-08-08",
          costUsd: 2,
          tokens: 20,
        }),
        entry("linux", {
          costUsd: 4,
          tokens: 40,
          unpricedRecords: 1,
        }),
        entry("mac", {
          provider: "codex",
          costUsd: 1,
          tokens: 10,
        }),
      ],
      ["model", "environment"],
      "day",
    );
    expect(rows).toEqual([
      {
        key: '["mac","claude opus"]',
        seriesKey: '["mac","claude opus"]',
        environmentId: "mac",
        provider: "claude",
        model: "opus",
        costUsd: 5,
        totalTokens: 50,
        records: 2,
        unpricedRecords: 0,
        costShare: 0.5,
        tokenShare: 0.5,
      },
      {
        key: '["linux","claude opus"]',
        seriesKey: '["linux","claude opus"]',
        environmentId: "linux",
        provider: "claude",
        model: "opus",
        costUsd: 4,
        totalTokens: 40,
        records: 1,
        unpricedRecords: 1,
        costShare: 0.4,
        tokenShare: 0.4,
      },
      {
        key: '["mac","codex opus"]',
        seriesKey: '["mac","codex opus"]',
        environmentId: "mac",
        provider: "codex",
        model: "opus",
        costUsd: 1,
        totalTokens: 10,
        records: 1,
        unpricedRecords: 0,
        costShare: 0.1,
        tokenShare: 0.1,
      },
    ]);
  });
  it("collapses everything into one total row without dimensions", () => {
    expect(
      pivotUsage(
        [
          entry("mac"),
          entry("linux", {
            provider: "codex",
          }),
        ],
        [],
        "day",
      ).map((row) => [row.key, row.costUsd, row.provider]),
    ).toEqual([["[]", 2, undefined]]);
  });
  it("groups days into Monday weeks and calendar months across a month boundary", () => {
    const entries = ["2026-07-30", "2026-08-02", "2026-08-03"].map((day) =>
      entry("mac", {
        day,
      }),
    );
    const periods = (grouping: "week" | "month") =>
      pivotUsage(entries, ["period"], grouping).map((row) => [row.period, row.costUsd]);
    expect(periods("week")).toEqual([
      ["2026-07-27", 2],
      ["2026-08-03", 1],
    ]);
    expect(periods("month")).toEqual([
      ["2026-07-01", 1],
      ["2026-08-01", 2],
    ]);
  });
  it("keys hourly periods by hour start", () => {
    const rows = pivotUsage(
      [
        entry("mac", {
          hourStart: "2026-08-07T09:00:00.000Z",
        }),
        entry("mac", {
          hourStart: "2026-08-07T10:00:00.000Z",
        }),
      ],
      ["period"],
      "hour",
    );
    expect(rows.map((row) => row.period)).toEqual([
      "2026-08-07T09:00:00.000Z",
      "2026-08-07T10:00:00.000Z",
    ]);
  });
});
describe("usageRowKey", () => {
  it("maps a finer row onto the key of the coarser row that contains it", () => {
    const entries = [
      entry("mac", {
        provider: "codex",
        model: "gpt",
      }),
    ];
    const [byModelAndPeriod] = pivotUsage(entries, ["model", "period"], "day");
    const [byModel] = pivotUsage(entries, ["model"], "day");
    expect(usageRowKey(byModelAndPeriod!, ["model"])).toBe(byModel!.key);
    expect(byModel!.key).toBe('["codex gpt"]');
  });
});
describe("enumeratePeriods", () => {
  const days = ["2026-07-30", "2026-07-31", "2026-08-01", "2026-08-02", "2026-08-03"];
  it("collapses days into the weeks and months that contain them", () => {
    expect(enumeratePeriods(days, "week")).toEqual(["2026-07-27", "2026-08-03"]);
    expect(enumeratePeriods(days, "month")).toEqual(["2026-07-01", "2026-08-01"]);
    expect(enumeratePeriods(days, "day")).toEqual(days);
  });
});
describe("sortUsageRows", () => {
  const rows = pivotUsage(
    [
      entry("b", {
        costUsd: 2,
        tokens: 5,
      }),
      entry("a", {
        costUsd: 2,
        tokens: 5,
      }),
      entry("c", {
        costUsd: 2,
        tokens: 9,
      }),
      entry("d", {
        costUsd: 7,
        tokens: 1,
      }),
    ],
    ["environment"],
    "day",
  );
  it("applies each criterion in turn and breaks remaining ties by key", () => {
    const sorted = sortUsageRows(
      rows,
      [
        {
          field: "costUsd",
          direction: "descending",
        },
        {
          field: "totalTokens",
          direction: "ascending",
        },
      ],
      label,
    );
    expect(sorted.map((row) => row.environmentId)).toEqual(["d", "a", "b", "c"]);
  });
  it("sorts labels in either direction", () => {
    expect(
      sortUsageRows(
        rows,
        [
          {
            field: "label",
            direction: "descending",
          },
        ],
        label,
      ).map((row) => row.environmentId),
    ).toEqual(["d", "c", "b", "a"]);
  });
});
describe("sorting and grouping two series named alike", () => {
  const rows = pivotUsage(
    [
      entry("mac", {
        provider: "opencode",
        model: "gpt",
        day: "2026-08-07",
      }),
      entry("mac", {
        provider: "codex",
        model: "gpt",
        day: "2026-08-08",
      }),
      entry("mac", {
        provider: "codex",
        model: "gpt",
        day: "2026-08-07",
      }),
      entry("mac", {
        provider: "opencode",
        model: "gpt",
        day: "2026-08-08",
      }),
    ],
    ["model", "period"],
    "day",
  );
  const sorted = sortUsageRows(
    rows,
    [
      {
        field: "label",
        direction: "ascending",
      },
      {
        field: "period",
        direction: "ascending",
      },
    ],
    (row) => row.model ?? "",
  );
  it("keeps each series' rows together under a shared label", () => {
    expect(sorted.map((row) => [row.provider, row.period])).toEqual([
      ["codex", "2026-08-07"],
      ["codex", "2026-08-08"],
      ["opencode", "2026-08-07"],
      ["opencode", "2026-08-08"],
    ]);
  });
  it("groups by identity, never merging the two series", () => {
    expect(
      groupUsageRows(sorted, ["model"]).map((group) => [group.key, group.rows.length]),
    ).toEqual([
      ['["codex gpt","2026-08-07"]', 2],
      ['["opencode gpt","2026-08-07"]', 2],
    ]);
  });
});
describe("groupUsageRows", () => {
  it("totals each consecutive run that shares the primary value", () => {
    const rows = sortUsageRows(
      pivotUsage(
        [
          entry("mac", {
            day: "2026-08-07",
            costUsd: 3,
            tokens: 30,
          }),
          entry("linux", {
            day: "2026-08-07",
            costUsd: 1,
            tokens: 10,
            unpricedRecords: 1,
          }),
          entry("mac", {
            day: "2026-08-08",
            costUsd: 6,
            tokens: 60,
          }),
        ],
        ["environment", "period"],
        "day",
      ),
      [
        {
          field: "period",
          direction: "descending",
        },
        {
          field: "costUsd",
          direction: "descending",
        },
      ],
      label,
    );
    expect(
      groupUsageRows(rows, ["period"]).map((group) => ({
        period: group.rows[0]?.period,
        environments: group.rows.map((row) => row.environmentId),
        costUsd: group.costUsd,
        totalTokens: group.totalTokens,
        records: group.records,
        unpricedRecords: group.unpricedRecords,
        costShare: group.costShare,
      })),
    ).toEqual([
      {
        period: "2026-08-08",
        environments: ["mac"],
        costUsd: 6,
        totalTokens: 60,
        records: 1,
        unpricedRecords: 0,
        costShare: 0.6,
      },
      {
        period: "2026-08-07",
        environments: ["mac", "linux"],
        costUsd: 4,
        totalTokens: 40,
        records: 2,
        unpricedRecords: 1,
        costShare: 0.4,
      },
    ]);
  });
});
describe("buildStackedColumns", () => {
  const periods = ["2026-08-07", "2026-08-08"];
  it("stacks series largest first, zero-fills periods, and peaks at the column sum", () => {
    const stack = buildStackedColumns(
      [
        entry("mac", {
          provider: "claude",
          costUsd: 3,
        }),
        entry("mac", {
          provider: "codex",
          costUsd: 5,
        }),
        entry("mac", {
          provider: "codex",
          day: "2026-08-08",
          costUsd: 1,
        }),
        entry("mac", {
          provider: "pi",
          costUsd: 0,
        }),
      ],
      ["provider"],
      "day",
      periods,
      "cost",
    );
    expect(stack.series.map((series) => [series.key, series.total])).toEqual([
      ['["codex"]', 6],
      ['["claude"]', 3],
    ]);
    expect(stack.columns).toEqual([
      {
        period: "2026-08-07",
        values: [5, 3],
        total: 8,
      },
      {
        period: "2026-08-08",
        values: [1, 0],
        total: 1,
      },
    ]);
    expect(stack.peak).toBe(8);
  });
  it("folds the smallest series into Other past the limit", () => {
    const stack = buildStackedColumns(
      ["a", "b", "c", "d"].map((model, index) =>
        entry("mac", {
          model,
          tokens: 40 - index * 10,
        }),
      ),
      ["model"],
      "day",
      periods,
      "tokens",
      3,
    );
    expect(stack.series.map((series) => [series.key, series.total, series.row?.model])).toEqual([
      ['["claude a"]', 40, "a"],
      ['["claude b"]', 30, "b"],
      ["other", 30, undefined],
    ]);
    expect(stack.columns[0]).toEqual({
      period: "2026-08-07",
      values: [40, 30, 30],
      total: 100,
    });
    expect(stack.folded).toEqual(['["claude c"]', '["claude d"]']);
  });
  it("draws one total series without dimensions", () => {
    const stack = buildStackedColumns(
      [
        entry("mac", {
          costUsd: 2,
        }),
        entry("linux", {
          day: "2026-08-08",
          costUsd: 3,
        }),
      ],
      [],
      "day",
      periods,
      "cost",
    );
    expect(stack.series.map((series) => series.key)).toEqual(["[]"]);
    expect(stack.columns.map((column) => column.values)).toEqual([[2], [3]]);
  });
});
