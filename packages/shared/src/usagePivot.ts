// @effect-diagnostics globalDate:off -- Week starts are UTC calendar arithmetic on `YYYY-MM-DD` days, not instants.
/**
 * Pivots merged usage entries by any combination of environment, provider,
 * model, and period, for the Usage page's breakdown table and stacked chart.
 *
 * @module usagePivot
 */
import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";

import { bucketTokens, type UsageEntry } from "./usageMerge.ts";

/** Fixed order: row keys and joined labels always list dimensions this way. */
export const USAGE_DIMENSIONS = [
  "host",
  "environment",
  "provider",
  "account",
  "model",
  "period",
] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export type UsageTimeGrouping = "hour" | "day" | "week" | "month";
export type UsageDayGrouping = Exclude<UsageTimeGrouping, "hour">;

export type UsagePivotMetric = "cost" | "tokens";

export interface UsageTotals {
  readonly costUsd: number;
  readonly totalTokens: number;
  readonly records: number;
  readonly unpricedRecords: number;
  readonly costShare: number;
  readonly tokenShare: number;
}

/**
 * One combination of the selected dimensions. Only selected dimensions are
 * set, except that a model row also carries its provider: the same model name
 * under two providers is two models.
 */
export interface UsagePivotRow extends UsageTotals {
  readonly key: string;
  /** The key without the period: rows of one series across periods share it. */
  readonly seriesKey: string;
  readonly environmentId?: EnvironmentId;
  readonly host?: string;
  readonly accountId?: string;
  readonly accountLabel?: string;
  readonly provider?: UsageProviderKind;
  readonly model?: string;
  readonly period?: string;
}

interface UsageCoordinates {
  readonly environmentId: EnvironmentId;
  readonly host: string;
  readonly accountId: string;
  readonly accountLabel: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly period: string;
}

type RowFields = Pick<
  UsagePivotRow,
  "environmentId" | "host" | "accountId" | "accountLabel" | "provider" | "model" | "period"
>;

const DIMENSIONS: {
  readonly [Dimension in UsageDimension]: {
    readonly identity: (fields: RowFields) => string;
    readonly fields: (coordinates: UsageCoordinates) => RowFields;
  };
} = {
  host: {
    identity: (c) => c.host ?? "",
    fields: (c) => ({ host: c.host }),
  },
  account: {
    identity: (c) => c.accountId ?? "",
    fields: (c) => ({ accountId: c.accountId, accountLabel: c.accountLabel, provider: c.provider }),
  },
  environment: {
    identity: (c) => c.environmentId ?? "",
    fields: (c) => ({ environmentId: c.environmentId }),
  },
  provider: {
    identity: (c) => c.provider ?? "",
    fields: (c) => ({ provider: c.provider }),
  },
  model: {
    identity: (c) => `${c.provider ?? ""} ${c.model ?? ""}`,
    fields: (c) => ({ provider: c.provider, model: c.model }),
  },
  period: {
    identity: (c) => c.period ?? "",
    fields: (c) => ({ period: c.period }),
  },
};

/** The first day of the week (Monday) or month containing a `YYYY-MM-DD` day. */
export function periodOfDay(day: string, grouping: UsageDayGrouping): string {
  if (grouping === "day") return day;
  if (grouping === "month") return `${day.slice(0, 7)}-01`;
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * Chart columns, oldest first: hour starts pass through, days collapse into
 * the periods that contain them.
 */
export function enumeratePeriods(
  daysOrHours: readonly string[],
  grouping: UsageTimeGrouping,
): readonly string[] {
  if (grouping === "hour") return daysOrHours;
  const periods: string[] = [];
  for (const day of daysOrHours) {
    const period = periodOfDay(day, grouping);
    if (periods.at(-1) !== period) periods.push(period);
  }
  return periods;
}

function coordinatesOf(entry: UsageEntry, grouping: UsageTimeGrouping): UsageCoordinates {
  const { bucket } = entry;
  return {
    environmentId: entry.environmentId,
    host: entry.host ?? "Unknown host",
    accountId: entry.accountId ?? JSON.stringify([entry.host, bucket.provider, "unknown"]),
    accountLabel:
      entry.accountLabel ??
      (entry.host === undefined ? "Unknown account" : `Unknown account (${entry.host})`),
    provider: bucket.provider,
    model: bucket.model,
    period:
      grouping === "hour" ? (bucket.hourStart ?? bucket.day) : periodOfDay(bucket.day, grouping),
  };
}

function orderedDimensions(selected: readonly UsageDimension[]): readonly UsageDimension[] {
  return USAGE_DIMENSIONS.filter((dimension) => selected.includes(dimension));
}

function rowKey(fields: RowFields, dimensions: readonly UsageDimension[]): string {
  return JSON.stringify(dimensions.map((dimension) => DIMENSIONS[dimension].identity(fields)));
}

/**
 * The key a row would have with fewer dimensions, such as the chart series a
 * period row belongs to. `dimensions` must be a subset of the row's own.
 */
export function usageRowKey(row: UsagePivotRow, dimensions: readonly UsageDimension[]): string {
  return rowKey(row, orderedDimensions(dimensions));
}

/** Rows in first-seen order. Shares are of everything in `entries`. */
export function pivotUsage(
  entries: readonly UsageEntry[],
  dimensions: readonly UsageDimension[],
  grouping: UsageTimeGrouping,
): UsagePivotRow[] {
  const ordered = orderedDimensions(dimensions);
  const rows = new Map<
    string,
    RowFields & { costUsd: number; totalTokens: number; records: number; unpricedRecords: number }
  >();
  let costUsd = 0;
  let totalTokens = 0;
  for (const entry of entries) {
    const coordinates = coordinatesOf(entry, grouping);
    const key = rowKey(coordinates, ordered);
    let row = rows.get(key);
    if (row === undefined) {
      row = { costUsd: 0, totalTokens: 0, records: 0, unpricedRecords: 0 };
      for (const dimension of ordered)
        Object.assign(row, DIMENSIONS[dimension].fields(coordinates));
      rows.set(key, row);
    }
    const tokens = bucketTokens(entry.bucket);
    row.costUsd += entry.bucket.costUsd;
    row.totalTokens += tokens;
    row.records += entry.bucket.records;
    row.unpricedRecords += entry.bucket.unpricedRecords;
    costUsd += entry.bucket.costUsd;
    totalTokens += tokens;
  }
  const seriesDimensions = ordered.filter((dimension) => dimension !== "period");
  return Array.from(rows, ([key, row]) => ({
    key,
    seriesKey: rowKey(row, seriesDimensions),
    ...row,
    costShare: costUsd === 0 ? 0 : row.costUsd / costUsd,
    tokenShare: totalTokens === 0 ? 0 : row.totalTokens / totalTokens,
  }));
}

export const USAGE_SORT_FIELDS = ["costUsd", "totalTokens", "label", "period"] as const;
export type UsageSortField = (typeof USAGE_SORT_FIELDS)[number];
export type UsageSortDirection = "ascending" | "descending";

export interface UsageSortCriterion {
  readonly field: UsageSortField;
  readonly direction: UsageSortDirection;
}

/** Labels come from the client, which alone knows environment names. */
export type UsageRowLabel = (row: UsagePivotRow) => string;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Sorts by each criterion in turn, then by row key so the order is total.
 * Rows that share a label stay apart by series, so a series' rows stay
 * together even when two series are named alike.
 */
export function sortUsageRows(
  rows: readonly UsagePivotRow[],
  criteria: readonly UsageSortCriterion[],
  labelOf: UsageRowLabel,
): UsagePivotRow[] {
  const labels = criteria.some((criterion) => criterion.field === "label")
    ? new Map(rows.map((row) => [row, labelOf(row)]))
    : undefined;
  const compare = (field: UsageSortField, left: UsagePivotRow, right: UsagePivotRow) => {
    switch (field) {
      case "costUsd":
        return left.costUsd - right.costUsd;
      case "totalTokens":
        return left.totalTokens - right.totalTokens;
      case "period":
        return compareStrings(left.period ?? "", right.period ?? "");
      case "label":
        return (
          (labels?.get(left) ?? "").localeCompare(labels?.get(right) ?? "") ||
          compareStrings(left.seriesKey, right.seriesKey)
        );
    }
  };
  return [...rows].sort((left, right) => {
    for (const { field, direction } of criteria) {
      const comparison = compare(field, left, right);
      if (comparison !== 0) return direction === "ascending" ? comparison : -comparison;
    }
    return left.key.localeCompare(right.key);
  });
}

export interface UsageRowGroup extends UsageTotals {
  readonly key: string;
  readonly rows: readonly [UsagePivotRow, ...UsagePivotRow[]];
}

/**
 * Consecutive runs of sorted rows that share their values for `dimensions`,
 * compared by identity, never by display name.
 */
export function groupUsageRows(
  sortedRows: readonly UsagePivotRow[],
  dimensions: readonly UsageDimension[],
): UsageRowGroup[] {
  const ordered = orderedDimensions(dimensions);
  const groups: { identity: string; rows: [UsagePivotRow, ...UsagePivotRow[]] }[] = [];
  for (const row of sortedRows) {
    const value = rowKey(row, ordered);
    const previous = groups.at(-1);
    if (previous !== undefined && previous.identity === value) previous.rows.push(row);
    else groups.push({ identity: value, rows: [row] });
  }
  return groups.map(({ rows }) => ({
    key: rows[0].key,
    rows,
    costUsd: sum(rows, (row) => row.costUsd),
    totalTokens: sum(rows, (row) => row.totalTokens),
    records: sum(rows, (row) => row.records),
    unpricedRecords: sum(rows, (row) => row.unpricedRecords),
    costShare: sum(rows, (row) => row.costShare),
    tokenShare: sum(rows, (row) => row.tokenShare),
  }));
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function usageMetricValue(
  totals: Pick<UsageTotals, "costUsd" | "totalTokens">,
  metric: UsagePivotMetric,
): number {
  return metric === "cost" ? totals.costUsd : totals.totalTokens;
}

/** Past this many series, the smallest fold into one "Other" band. */
export const MAX_CHART_SERIES = 10;
const OTHER_SERIES_KEY = "other";

export interface UsageStackedSeries {
  readonly key: string;
  /** The series' totals and dimension values, or `null` for "Other". */
  readonly row: UsagePivotRow | null;
  readonly total: number;
}

export interface UsageStackedColumn {
  readonly period: string;
  /** One value per series, bottom of the stack first. */
  readonly values: readonly number[];
  readonly total: number;
}

export interface UsageStack {
  readonly series: readonly UsageStackedSeries[];
  readonly columns: readonly UsageStackedColumn[];
  /** The tallest column: the stack reaches the combined total. */
  readonly peak: number;
  /** Keys of the series folded into "Other". */
  readonly folded: readonly string[];
}

/**
 * Stacked chart data, one zero-filled column per period. Series run largest
 * first, so the biggest band sits on the baseline. Series with nothing to show
 * for the metric are left out.
 */
export function buildStackedColumns(
  entries: readonly UsageEntry[],
  seriesDimensions: readonly UsageDimension[],
  grouping: UsageTimeGrouping,
  periods: readonly string[],
  metric: UsagePivotMetric,
  limit: number = MAX_CHART_SERIES,
): UsageStack {
  const dimensions = orderedDimensions(seriesDimensions).filter((d) => d !== "period");
  const ranked = pivotUsage(entries, dimensions, grouping)
    .map((row) => ({ key: row.key, row, total: usageMetricValue(row, metric) }))
    .filter((series) => series.total > 0)
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
  const kept: UsageStackedSeries[] = ranked.length > limit ? ranked.slice(0, limit - 1) : ranked;
  const folded = ranked.slice(kept.length);
  const series =
    folded.length === 0
      ? kept
      : [...kept, { key: OTHER_SERIES_KEY, row: null, total: sum(folded, (entry) => entry.total) }];

  const seriesIndex = new Map(kept.map((entry, index) => [entry.key, index]));
  for (const entry of folded) seriesIndex.set(entry.key, kept.length);
  const columnIndex = new Map(periods.map((period, index) => [period, index]));
  const values = periods.map(() => series.map(() => 0));
  for (const entry of entries) {
    const coordinates = coordinatesOf(entry, grouping);
    const column = values[columnIndex.get(coordinates.period) ?? -1];
    const index = seriesIndex.get(rowKey(coordinates, dimensions));
    if (column === undefined || index === undefined) continue;
    column[index] =
      (column[index] ?? 0) +
      (metric === "cost" ? entry.bucket.costUsd : bucketTokens(entry.bucket));
  }
  const columns = periods.map((period, index) => {
    const column = values[index] ?? [];
    return { period, values: column, total: sum(column, (value) => value) };
  });
  return {
    series,
    columns,
    peak: columns.reduce((peak, column) => Math.max(peak, column.total), 0),
    folded: folded.map((entry) => entry.key),
  };
}
