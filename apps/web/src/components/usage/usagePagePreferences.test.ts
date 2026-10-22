import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readUsagePagePreferences, saveUsagePagePreferences } from "./usagePagePreferences";
const key = "t3code:usage-page-preferences:v1";
let values: Map<string, string>;
let storage: Pick<Storage, "getItem" | "setItem">;
beforeEach(() => {
  values = new Map();
  storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
  vi.stubGlobal("window", {
    localStorage: storage,
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("Usage page preferences", () => {
  it("round-trips hidden providers and reads older saves without them", () => {
    saveUsagePagePreferences({
      metric: "cost",
      windowDays: 7,
      hiddenProviders: ["codex"],
    });
    expect(readUsagePagePreferences().hiddenProviders).toEqual(["codex"]);
    values.set(key, '{"metric":"tokens","windowDays":30}');
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      windowDays: 30,
    });
  });
  it("round-trips breakdown view settings", () => {
    const preferences = {
      metric: "cost",
      windowDays: 90,
      chartDimensions: ["environment", "model"],
      tableDimensions: ["provider", "period"],
      sort: [
        {
          field: "period",
          direction: "descending",
        },
        {
          field: "label",
          direction: "ascending",
        },
      ],
      timeGrouping: "week",
    } as const;
    saveUsagePagePreferences(preferences);
    expect(readUsagePagePreferences()).toEqual(preferences);
  });
  it("clears a saved sort so the metric's default applies again", () => {
    saveUsagePagePreferences({
      metric: "tokens",
      windowDays: 7,
      sort: [
        {
          field: "label",
          direction: "ascending",
        },
      ],
    });
    saveUsagePagePreferences({
      ...readUsagePagePreferences(),
      sort: undefined,
    });
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      windowDays: 7,
    });
  });
  it("drops only the view settings it cannot use and de-duplicates the rest", () => {
    values.set(
      key,
      JSON.stringify({
        metric: "tokens",
        windowDays: 7,
        hiddenProviders: ["pi"],
        chartDimensions: ["provider", "machine"],
        tableDimensions: ["model", "period", "model"],
        sort: [
          {
            field: "totalTokens",
            direction: "ascending",
          },
          {
            field: "totalTokens",
            direction: "descending",
          },
          {
            field: "costUsd",
            direction: "descending",
          },
        ],
        timeGrouping: "hour",
      }),
    );
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      windowDays: 7,
      hiddenProviders: ["pi"],
      tableDimensions: ["model", "period"],
      sort: [
        {
          field: "totalTokens",
          direction: "ascending",
        },
        {
          field: "costUsd",
          direction: "descending",
        },
      ],
    });
  });
  it.each([
    [
      {
        sort: [],
      },
    ],
    [
      {
        sort: [
          {
            field: "costUsd",
            direction: "sideways",
          },
        ],
      },
    ],
    [
      {
        sort: [
          {
            field: "sessions",
            direction: "ascending",
          },
        ],
      },
    ],
    [
      {
        timeGrouping: "year",
      },
    ],
  ])("ignores an unusable view setting: %j", (setting) => {
    values.set(
      key,
      JSON.stringify({
        metric: "cost",
        windowDays: 30,
        ...setting,
      }),
    );
    expect(readUsagePagePreferences()).toEqual({
      metric: "cost",
      windowDays: 30,
    });
  });
  it.each([
    "not-json",
    '{"metric":"unknown","windowDays":7}',
    '{"metric":"cost","windowDays":365}',
  ])("replaces invalid preferences on the next save: %s", (value) => {
    values.set(key, value);
    expect(readUsagePagePreferences()).toEqual({
      metric: "limits",
      windowDays: 30,
    });
    saveUsagePagePreferences({
      metric: "tokens",
      windowDays: 7,
    });
    expect(readUsagePagePreferences()).toEqual({
      metric: "tokens",
      windowDays: 7,
    });
  });
});
