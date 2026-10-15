import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatDayShort,
  formatHourShort,
  formatMonthShort,
  formatRelativeHourShort,
} from "@t3tools/shared/usageFormat";
import {
  USAGE_DIMENSIONS,
  type UsageDimension,
  type UsagePivotRow,
  type UsageTimeGrouping,
} from "@t3tools/shared/usagePivot";

import { PROVIDER_PRESENTATION } from "./usageProviders";

export interface UsageLabelContext {
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly grouping: UsageTimeGrouping;
  readonly timeZone: string;
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
): string {
  if (grouping === "hour") return formatHourShort(period, timeZone);
  return grouping === "month" ? formatMonthShort(period) : formatDayShort(period);
}

/** A period name that stands on its own, as in a table row or hover readout. */
export function formatPeriod(
  period: string,
  grouping: UsageTimeGrouping,
  timeZone: string,
  referenceTime?: string,
): string {
  if (grouping === "hour" && referenceTime !== undefined) {
    return formatRelativeHourShort(period, referenceTime, timeZone);
  }
  return grouping === "week"
    ? `Week of ${formatDayShort(period)}`
    : formatPeriodShort(period, grouping, timeZone);
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
      : formatPeriod(row.period, context.grouping, context.timeZone),
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
export const OTHER_SERIES_COLOR = "color-mix(in oklab, var(--foreground) 40%, var(--background))";
const TOTAL_SERIES_COLOR = "var(--contrast-foreground)";

/**
 * Provider series keep their provider colors. Other series take palette slots
 * in key order, so a series keeps its color while the ranking moves.
 */
export function usageSeriesColors(
  rows: readonly Pick<UsagePivotRow, "key" | "provider">[],
  dimensions: readonly UsageDimension[],
): ReadonlyMap<string, string> {
  if (dimensions.length === 1 && dimensions[0] === "provider") {
    return new Map(
      rows.flatMap((row) =>
        row.provider === undefined ? [] : [[row.key, PROVIDER_PRESENTATION[row.provider].color]],
      ),
    );
  }
  if (dimensions.length === 0) return new Map(rows.map((row) => [row.key, TOTAL_SERIES_COLOR]));
  const keys = [...new Set(rows.map((row) => row.key))].sort();
  return new Map(
    keys.map((key, index) => [key, SERIES_PALETTE[index % SERIES_PALETTE.length] ?? ""]),
  );
}
