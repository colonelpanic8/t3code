/**
 * Platform-neutral Usage screen view logic: saved chart and breakdown
 * settings, series names and colors, and the breakdown list layout. Clients
 * supply their own colors and provider names.
 *
 * @module usageView
 */
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { formatDayShort, formatHourShort, formatMonthShort } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type UsageEntry } from "@t3tools/shared/usageMerge";
import {
  USAGE_DIMENSIONS,
  USAGE_SORT_FIELDS,
  buildStackedColumns,
  groupUsageRows,
  pivotUsage,
  sortUsageRows,
  usageRowKey,
  type UsageDayGrouping,
  type UsageDimension,
  type UsagePivotMetric,
  type UsagePivotRow,
  type UsageSortCriterion,
  type UsageSortField,
  type UsageStack,
  type UsageTimeGrouping,
  type UsageTotals,
} from "@t3tools/shared/usagePivot";

export type UsageChartDimension = Exclude<UsageDimension, "period">;
export const USAGE_CHART_DIMENSIONS = [
  "host",
  "environment",
  "provider",
  "account",
  "model",
] as const satisfies readonly UsageChartDimension[];
export const USAGE_DAY_GROUPINGS = [
  "day",
  "week",
  "month",
] as const satisfies readonly UsageDayGrouping[];

export interface UsageViewPreferences {
  readonly chartDimensions?: readonly UsageChartDimension[];
  readonly tableDimensions?: readonly UsageDimension[];
  /** Absent until the user picks a sort: the default follows the metric. */
  readonly sort?: readonly UsageSortCriterion[] | undefined;
  readonly timeGrouping?: UsageDayGrouping;
}

export const DEFAULT_USAGE_VIEW = {
  chartDimensions: ["provider"],
  tableDimensions: ["model"],
  timeGrouping: "day",
} as const satisfies Required<
  Pick<UsageViewPreferences, "chartDimensions" | "tableDimensions" | "timeGrouping">
>;

function isOneOf<const T extends string>(options: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (options as readonly string[]).includes(value);
}

function parseDimensions<const T extends string>(
  options: readonly T[],
  values: unknown,
): readonly T[] | undefined {
  if (!Array.isArray(values) || !values.every((value) => isOneOf(options, value))) {
    return undefined;
  }
  return [...new Set(values as T[])];
}

function parseSort(values: unknown): readonly UsageSortCriterion[] | undefined {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const criteria: UsageSortCriterion[] = [];
  for (const value of values as unknown[]) {
    if (typeof value !== "object" || value === null) return undefined;
    const { field, direction } = value as { field?: unknown; direction?: unknown };
    if (!isOneOf(USAGE_SORT_FIELDS, field) || !isOneOf(["ascending", "descending"], direction)) {
      return undefined;
    }
    if (!criteria.some((criterion) => criterion.field === field)) {
      criteria.push({ field, direction });
    }
  }
  return criteria;
}

/**
 * Decodes a saved view field by field, so a value this build does not know
 * drops only that setting.
 */
export function parseUsageViewPreferences(stored: unknown): UsageViewPreferences {
  if (typeof stored !== "object" || stored === null) return {};
  const fields = stored as Record<string, unknown>;
  const chartDimensions = parseDimensions(USAGE_CHART_DIMENSIONS, fields.chartDimensions);
  const tableDimensions = parseDimensions(USAGE_DIMENSIONS, fields.tableDimensions);
  const sort = parseSort(fields.sort);
  const timeGrouping = isOneOf(USAGE_DAY_GROUPINGS, fields.timeGrouping)
    ? fields.timeGrouping
    : undefined;
  return {
    ...(chartDimensions === undefined ? {} : { chartDimensions }),
    ...(tableDimensions === undefined ? {} : { tableDimensions }),
    ...(sort === undefined ? {} : { sort }),
    ...(timeGrouping === undefined ? {} : { timeGrouping }),
  };
}

export interface UsageTableView {
  readonly tableDimensions: readonly UsageDimension[];
  readonly sort: readonly UsageSortCriterion[];
}

export type UsageTableViewPatch = Pick<UsageViewPreferences, "tableDimensions" | "sort">;

const DEFAULT_SORT: { readonly [Metric in UsagePivotMetric]: readonly UsageSortCriterion[] } = {
  cost: [{ field: "costUsd", direction: "descending" }],
  tokens: [{ field: "totalTokens", direction: "descending" }],
};

const DEFAULT_DIRECTION: { readonly [Field in UsageSortField]: UsageSortCriterion["direction"] } = {
  costUsd: "descending",
  totalTokens: "descending",
  label: "ascending",
  period: "descending",
};

/** The saved view, sorted by the page's metric until the user picks a sort. */
export function usageTableView(
  saved: UsageViewPreferences,
  metric: UsagePivotMetric,
): UsageTableView {
  return withTableSort({
    tableDimensions: saved.tableDimensions ?? DEFAULT_USAGE_VIEW.tableDimensions,
    sort: saved.sort ?? DEFAULT_SORT[metric],
  });
}

/** Sorting by period needs periods to sort, so it brings the dimension along. */
function withTableSort({ tableDimensions, sort }: UsageTableView): UsageTableView {
  const needsPeriod = sort.some((criterion) => criterion.field === "period");
  return {
    sort,
    tableDimensions:
      needsPeriod && !tableDimensions.includes("period")
        ? [...tableDimensions, "period"]
        : tableDimensions,
  };
}

/**
 * Dropping the period dimension drops the period sort with it, back to the
 * default sort if nothing else is left.
 */
export function withTableDimensions(
  view: UsageTableView,
  tableDimensions: readonly UsageDimension[],
): UsageTableViewPatch {
  const sort = view.sort.filter((criterion) => criterion.field !== "period");
  if (tableDimensions.includes("period") || sort.length === view.sort.length) {
    return { tableDimensions };
  }
  return { tableDimensions, sort: sort.length > 0 ? sort : undefined };
}

/** Sorts by `field` alone; picking the field already sorted by reverses it. */
export function withSortField(view: UsageTableView, field: UsageSortField): UsageTableViewPatch {
  const primary = view.sort[0];
  const direction =
    primary?.field === field
      ? primary.direction === "ascending"
        ? "descending"
        : "ascending"
      : DEFAULT_DIRECTION[field];
  const next = withTableSort({ ...view, sort: [{ field, direction }] });
  return next.tableDimensions === view.tableDimensions ? { sort: next.sort } : next;
}

export const USAGE_DIMENSION_NAMES: { readonly [Dimension in UsageDimension]: string } = {
  host: "Host",
  account: "Account",
  environment: "Environment",
  provider: "Provider",
  model: "Model",
  period: "Period",
};

export const USAGE_GROUPING_NAMES: { readonly [Grouping in UsageTimeGrouping]: string } = {
  hour: "Hour",
  day: "Day",
  week: "Week",
  month: "Month",
};

export function usageSortFieldName(field: UsageSortField, grouping: UsageTimeGrouping): string {
  if (field === "period") return USAGE_GROUPING_NAMES[grouping];
  return { costUsd: "Cost", totalTokens: "Tokens", label: "Name" }[field];
}

export interface UsageLabelContext {
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly providerLabels: { readonly [Provider in UsageProviderKind]: string };
  readonly grouping: UsageTimeGrouping;
  readonly timeZone: string;
  readonly hour12: boolean;
}

/** A compact period name for axis ticks. */
export function formatUsagePeriodShort(
  period: string,
  grouping: UsageTimeGrouping,
  timeZone: string,
  hour12: boolean,
): string {
  if (grouping === "hour") return formatHourShort(period, timeZone, hour12);
  return grouping === "month" ? formatMonthShort(period) : formatDayShort(period);
}

const DIMENSION_LABEL: {
  readonly [Dimension in UsageDimension]: (
    row: UsagePivotRow,
    context: UsageLabelContext,
  ) => string | undefined;
} = {
  host: (row) => row.host,
  account: (row) => row.accountLabel,
  environment: (row, context) =>
    row.environmentId === undefined
      ? undefined
      : (context.environmentLabels.get(row.environmentId) ?? row.environmentId),
  provider: (row, context) =>
    row.provider === undefined ? undefined : context.providerLabels[row.provider],
  model: (row) => row.model,
  period: (row, { grouping, timeZone, hour12 }) =>
    row.period === undefined
      ? undefined
      : grouping === "week"
        ? `Week of ${formatDayShort(row.period)}`
        : formatUsagePeriodShort(row.period, grouping, timeZone, hour12),
};

/** The row's values for the given dimensions, joined in the fixed dimension order. */
function usageRowLabel(
  row: UsagePivotRow,
  dimensions: readonly UsageDimension[],
  context: UsageLabelContext,
): string {
  return USAGE_DIMENSIONS.filter((dimension) => dimensions.includes(dimension))
    .flatMap((dimension) => DIMENSION_LABEL[dimension](row, context) ?? [])
    .join(" · ");
}

/**
 * Chart series names. With models or accounts split but providers not, a name
 * several providers share is named with its provider so the two read apart.
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
  if (
    (!dimensions.includes("model") && !dimensions.includes("account")) ||
    dimensions.includes("provider")
  )
    return labels;
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return series.map(({ row }, index) => {
    const label = labels[index] ?? "";
    return row !== null && (counts.get(label) ?? 0) > 1
      ? usageRowLabel(row, [...dimensions, "provider"], context)
      : label;
  });
}

export interface UsageSeriesPalette {
  /** Slots for series that are not providers, assigned in series key order. */
  readonly series: readonly string[];
  readonly other: string;
  readonly total: string;
  readonly providers: { readonly [Provider in UsageProviderKind]: string };
}

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
  palette: UsageSeriesPalette,
): readonly (readonly [string, string])[] {
  if (dimensions.length === 1 && dimensions[0] === "provider") {
    return rows.flatMap((row) =>
      row.provider === undefined ? [] : [[row.key, palette.providers[row.provider]]],
    );
  }
  if (dimensions.length === 0) return rows.map((row) => [row.key, palette.total]);
  // Hermes lacks toSorted.
  return rows
    .map((row) => row.key)
    .sort()
    .map((key, index) => [key, palette.series[index % palette.series.length] ?? palette.other]);
}

export function buildUsageChartSeries(
  entries: readonly UsageEntry[],
  dimensions: readonly UsageChartDimension[],
  grouping: UsageTimeGrouping,
  periods: readonly string[],
  metric: UsagePivotMetric,
  palette: UsageSeriesPalette,
): UsageChartSeries {
  const stack = buildStackedColumns(entries, dimensions, grouping, periods, metric);
  const kept = stack.series.flatMap((series) => (series.row === null ? [] : [series.row]));
  const other = stack.series.filter((series) => series.row === null).map((series) => series.key);
  const colors = new Map([
    ...keptSeriesColors(kept, dimensions, palette),
    ...[...other, ...stack.folded].map((key) => [key, palette.other] as const),
  ]);
  return { dimensions, stack, colors };
}

/** The chart without some providers' usage. Series keep their colors from the full chart. */
export function withoutChartProviders(
  full: UsageChartSeries,
  entries: readonly UsageEntry[],
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  grouping: UsageTimeGrouping,
  periods: readonly string[],
  metric: UsagePivotMetric,
  palette: UsageSeriesPalette,
): UsageChartSeries {
  if (hiddenProviders.size === 0) return full;
  const shown = buildUsageChartSeries(
    entries.filter((entry) => !hiddenProviders.has(entry.bucket.provider)),
    full.dimensions,
    grouping,
    periods,
    metric,
    palette,
  );
  const folded = new Set([...shown.stack.folded, ...full.stack.folded]);
  const colors = new Map(
    [...shown.colors].map(([key, color]) => [
      key,
      folded.has(key) ? color : (full.colors.get(key) ?? color),
    ]),
  );
  return { ...shown, colors };
}

const ROW_VALUE: {
  readonly [Dimension in UsageChartDimension]: (row: UsagePivotRow) => string | undefined;
} = {
  host: (row) => row.host,
  account: (row) => row.accountId,
  environment: (row) => row.environmentId,
  provider: (row) => row.provider,
  model: (row) => row.model,
};

/**
 * The color of the chart band a row falls in, if the row carries every value
 * the chart splits by. A single total band marks nothing.
 */
function usageRowSeriesColor(series: UsageChartSeries, row: UsagePivotRow): string | undefined {
  const { dimensions } = series;
  if (dimensions.length === 0) return undefined;
  if (!dimensions.every((dimension) => ROW_VALUE[dimension](row) !== undefined)) return undefined;
  return series.colors.get(usageRowKey(row, dimensions));
}

/** Unknown cost has no cost share; unpriced usage still has a token share. */
export function usageShare(totals: UsageTotals, metric: UsagePivotMetric): number | null {
  if (metric === "tokens") return totals.tokenShare;
  return isModelCostUnknown(totals) ? null : totals.costShare;
}

/** How a row or heading is named: its text and the marks that tie it to the chart. */
export interface UsageBreakdownName {
  readonly text: string;
  readonly color: string | undefined;
  readonly provider: UsageProviderKind | undefined;
}

/**
 * Sorted rows, grouped under headings when the primary sort is by name or
 * period and some rows share it. A heading's value is not repeated in its rows.
 */
export function layoutUsageBreakdown(
  entries: readonly UsageEntry[],
  { tableDimensions: dimensions, sort }: UsageTableView,
  context: UsageLabelContext,
  chartSeries: UsageChartSeries,
) {
  const seriesDimensions = dimensions.filter((dimension) => dimension !== "period");
  // Periods have their own sort field, so names sort without them.
  const sorted = sortUsageRows(pivotUsage(entries, dimensions, context.grouping), sort, (row) =>
    usageRowLabel(row, seriesDimensions, context),
  );
  const primary = sort[0]?.field ?? "costUsd";
  const groupDimensions: readonly UsageDimension[] =
    primary === "period" ? ["period"] : primary === "label" ? seriesDimensions : [];
  const groups = groupUsageRows(sorted, groupDimensions);
  const grouped = groupDimensions.length > 0 && groups.length < sorted.length;
  const headingDimensions = grouped ? groupDimensions : [];
  const rowDimensions = dimensions.filter((dimension) => !headingDimensions.includes(dimension));
  const name = (
    row: UsagePivotRow,
    nameDimensions: readonly UsageDimension[],
  ): UsageBreakdownName => {
    const namesSeries = nameDimensions.some((dimension) => dimension !== "period");
    return {
      text: dimensions.length === 0 ? "Total" : usageRowLabel(row, nameDimensions, context),
      color: namesSeries ? usageRowSeriesColor(chartSeries, row) : undefined,
      provider: nameDimensions.includes("model") ? row.provider : undefined,
    };
  };
  return {
    grouped,
    rowCount: sorted.length,
    groups: groups.map((group) => ({
      ...group,
      heading: name(group.rows[0], headingDimensions),
      rows: group.rows.map((row) => ({ row, name: name(row, rowDimensions) })),
    })),
  };
}

/** The first `limit` rows, keeping each group's heading and full totals. */
export function firstUsageRows<Group extends { readonly rows: readonly unknown[] }>(
  groups: readonly Group[],
  limit: number,
): readonly Group[] {
  const visible: Group[] = [];
  let remaining = limit;
  for (const group of groups) {
    if (remaining <= 0) break;
    visible.push(
      group.rows.length <= remaining ? group : { ...group, rows: group.rows.slice(0, remaining) },
    );
    remaining -= group.rows.length;
  }
  return visible;
}
