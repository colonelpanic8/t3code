import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatDayShort,
  formatHourShort,
  formatMonthShort,
  formatRelativeHourShort,
} from "@t3tools/shared/usageFormat";
import type { UsageEntry } from "@t3tools/shared/usageMerge";
import {
  USAGE_DIMENSIONS,
  buildStackedColumns,
  usageRowKey,
  type UsageDimension,
  type UsagePivotMetric,
  type UsagePivotRow,
  type UsageStack,
  type UsageTimeGrouping,
} from "@t3tools/shared/usagePivot";

import type { UsageChartDimension } from "./usagePagePreferences";
import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageLabelContext {
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly grouping: UsageTimeGrouping;
  readonly timeZone: string;
  readonly hour12: boolean;
}

export const DIMENSION_NAMES: { readonly [Dimension in UsageDimension]: string } = {
  environment: "Environment",
  provider: "Provider",
  model: "Model",
  period: "Period",
};

export const GROUPING_NAMES: { readonly [Grouping in UsageTimeGrouping]: string } = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
};

export const GROUPING_ADJECTIVES: { readonly [Grouping in UsageTimeGrouping]: string } = {
  hour: "Hourly",
  day: "Daily",
  week: "Weekly",
  month: "Monthly",
};

/** A compact period name for axis ticks. */
export function formatPeriodShort(
  period: string,
  grouping: UsageTimeGrouping,
  timeZone: string,
  hour12 = true,
): string {
  if (grouping === "hour") return formatHourShort(period, timeZone, hour12);
  return grouping === "month" ? formatMonthShort(period) : formatDayShort(period);
}

/** A period name that stands on its own, as in a table row or hover readout. */
export function formatPeriod(
  period: string,
  grouping: UsageTimeGrouping,
  timeZone: string,
  referenceTime?: string,
  hour12 = true,
): string {
  if (grouping === "hour" && referenceTime !== undefined) {
    return formatRelativeHourShort(period, referenceTime, timeZone, hour12);
  }
  return grouping === "week"
    ? `Week of ${formatDayShort(period)}`
    : formatPeriodShort(period, grouping, timeZone, hour12);
}

const DIMENSION_LABEL: {
  readonly [Dimension in UsageDimension]: (
    row: UsagePivotRow,
    context: UsageLabelContext,
  ) => string | undefined;
} = {
  environment: (row, context) =>
    row.environmentId === undefined
      ? undefined
      : (context.environmentLabels.get(row.environmentId) ?? row.environmentId),
  provider: (row) =>
    row.provider === undefined ? undefined : PROVIDER_PRESENTATION[row.provider].label,
  model: (row) => row.model,
  period: (row, context) =>
    row.period === undefined
      ? undefined
      : formatPeriod(row.period, context.grouping, context.timeZone, undefined, context.hour12),
};

/** The row's values for the given dimensions, joined in the fixed dimension order. */
export function usageRowLabel(
  row: UsagePivotRow,
  dimensions: readonly UsageDimension[],
  context: UsageLabelContext,
): string {
  return USAGE_DIMENSIONS.filter((dimension) => dimensions.includes(dimension))
    .flatMap((dimension) => DIMENSION_LABEL[dimension](row, context) ?? [])
    .join(" · ");
}

/**
 * Chart series names. With models split but providers not, a model name that
 * several providers serve is named with its provider so the two read apart.
 */
export function usageSeriesLabels(
  series: readonly { readonly row: UsagePivotRow | null }[],
  dimensions: readonly UsageDimension[],
  context: UsageLabelContext,
): readonly string[] {
  const labels = series.map(({ row }) =>
    row === null
      ? "Other"
      : dimensions.length === 0
        ? "Total"
        : usageRowLabel(row, dimensions, context),
  );
  if (!dimensions.includes("model") || dimensions.includes("provider")) return labels;
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return series.map(({ row }, index) => {
    const label = labels[index] ?? "";
    return row !== null && (counts.get(label) ?? 0) > 1
      ? usageRowLabel(row, [...dimensions, "provider"], context)
      : label;
  });
}

/** Hues spaced for separation, at a lightness that reads on both themes. */
const SERIES_PALETTE = [255, 40, 150, 310, 85, 200, 0, 120, 280, 60].map(
  (hue) => `oklch(0.68 0.13 ${hue})`,
);
const OTHER_SERIES_COLOR = "color-mix(in oklab, var(--foreground) 40%, var(--background))";
const TOTAL_SERIES_COLOR = "var(--contrast-foreground)";

export interface UsageChartSeries {
  readonly dimensions: readonly UsageChartDimension[];
  readonly stack: UsageStack;
  /** Every kept series, "Other", and each series folded into it. */
  readonly colors: ReadonlyMap<string, string>;
}

/**
 * Provider series keep their provider colors. Other series take palette slots
 * in key order, so a series keeps its color while the ranking moves.
 */
function keptSeriesColors(
  rows: readonly UsagePivotRow[],
  dimensions: readonly UsageChartDimension[],
): readonly (readonly [string, string])[] {
  if (dimensions.length === 1 && dimensions[0] === "provider") {
    return rows.flatMap((row) =>
      row.provider === undefined ? [] : [[row.key, PROVIDER_PRESENTATION[row.provider].color]],
    );
  }
  if (dimensions.length === 0) return rows.map((row) => [row.key, TOTAL_SERIES_COLOR]);
  return rows
    .map((row) => row.key)
    .toSorted()
    .map((key, index) => [key, SERIES_PALETTE[index % SERIES_PALETTE.length] ?? ""]);
}

export function buildUsageChartSeries(
  entries: readonly UsageEntry[],
  dimensions: readonly UsageChartDimension[],
  grouping: UsageTimeGrouping,
  periods: readonly string[],
  metric: UsagePivotMetric,
): UsageChartSeries {
  const stack = buildStackedColumns(entries, dimensions, grouping, periods, metric);
  const kept = stack.series.flatMap((series) => (series.row === null ? [] : [series.row]));
  const other = stack.series.filter((series) => series.row === null).map((series) => series.key);
  const colors = new Map([
    ...keptSeriesColors(kept, dimensions),
    ...[...other, ...stack.folded].map((key) => [key, OTHER_SERIES_COLOR] as const),
  ]);
  return { dimensions, stack, colors };
}

const ROW_VALUE: {
  readonly [Dimension in UsageChartDimension]: (row: UsagePivotRow) => string | undefined;
} = {
  environment: (row) => row.environmentId,
  provider: (row) => row.provider,
  model: (row) => row.model,
};

/**
 * The color of the chart band a row falls in, if the row carries every value
 * the chart splits by. A single total band marks nothing.
 */
export function usageRowSeriesColor(
  series: UsageChartSeries,
  row: UsagePivotRow,
): string | undefined {
  const { dimensions } = series;
  if (dimensions.length === 0) return undefined;
  if (!dimensions.every((dimension) => ROW_VALUE[dimension](row) !== undefined)) return undefined;
  return series.colors.get(usageRowKey(row, dimensions));
}
