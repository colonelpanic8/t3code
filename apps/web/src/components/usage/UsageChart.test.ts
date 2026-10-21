import { describe, expect, it } from "vite-plus/test";
import { chartScale, niceScale, stackBoundaries } from "./UsageChart";
import { providersWithUsage } from "./usageProviders";
describe("chartScale", () => {
  it("holds unlabeled placeholder gridlines while loading providers have nothing to show", () => {
    const scale = chartScale(0, true);
    expect(scale.labeled).toBe(false);
    expect(scale.ticks).toEqual([0, 1, 2, 3, 4]);
  });
  it("scales to the tallest stack, loading or not", () => {
    expect(chartScale(40, true)).toMatchObject({
      max: 40,
      labeled: true,
    });
    expect(chartScale(0, false)).toEqual({
      max: 0,
      ticks: [0],
      labeled: true,
    });
  });
});
describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });
  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });
  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));
    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });
  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });
  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({
      max: 0,
      ticks: [0],
    });
  });
});
describe("stackBoundaries", () => {
  it("stacks each series on the ones below it", () => {
    // Regression guard: overlapping series each measured from zero, so a small
    // series drawn behind a large one disappeared.
    const columns = [
      {
        period: "2026-08-01",
        values: [1, 1],
        total: 2,
      },
      {
        period: "2026-08-02",
        values: [0, 2],
        total: 2,
      },
    ];
    expect(stackBoundaries(columns, 2, 4)).toEqual([
      [260, 260],
      [197, 260],
      [134, 134],
    ]);
  });
});
describe("providersWithUsage", () => {
  it("omits providers with no cost or tokens", () => {
    expect(
      providersWithUsage([
        {
          provider: "codex",
          costUsd: 0,
          totalTokens: 0,
        },
        {
          provider: "claude",
          costUsd: 0,
          totalTokens: 200,
        },
      ]),
    ).toEqual(["claude"]);
  });
});
