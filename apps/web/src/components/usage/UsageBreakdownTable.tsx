import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type UsageEntry } from "@t3tools/shared/usageMerge";
import {
  USAGE_DIMENSIONS,
  USAGE_SORT_FIELDS,
  groupUsageRows,
  pivotUsage,
  sortUsageRows,
  type UsageDimension,
  type UsagePivotMetric,
  type UsagePivotRow,
  type UsageSortCriterion,
  type UsageSortField,
  type UsageTimeGrouping,
  type UsageTotals,
} from "@t3tools/shared/usagePivot";
import {
  ArrowDownIcon,
  ArrowUpDownIcon,
  ArrowUpIcon,
  ChevronUpIcon,
  PlusIcon,
  XIcon,
} from "lucide-react";
import { memo, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ProviderMark } from "./ProviderMark";
import { modelShare } from "./usageBreakdown";
import { DEFAULT_USAGE_VIEW, type UsagePagePreferences } from "./usagePagePreferences";
import {
  DIMENSION_NAMES,
  GROUPING_NAMES,
  usageRowLabel,
  usageRowSeriesColor,
  type UsageChartSeries,
  type UsageLabelContext,
} from "./usageSeries";

export interface UsageTableView {
  readonly tableDimensions: readonly UsageDimension[];
  readonly sort: readonly UsageSortCriterion[];
}

/** What the table saves: a sort only once the user has picked one. */
export type UsageTableViewPatch = Pick<UsagePagePreferences, "tableDimensions" | "sort">;

const DEFAULT_SORT: { readonly [Metric in UsagePivotMetric]: readonly UsageSortCriterion[] } = {
  cost: [{ field: "costUsd", direction: "descending" }],
  tokens: [{ field: "totalTokens", direction: "descending" }],
};

/** The saved view, sorted by the page's metric until the user picks a sort. */
export function usageTableView(
  saved: { readonly [Field in keyof UsageTableView]: UsageTableView[Field] | undefined },
  metric: UsagePivotMetric,
): UsageTableView {
  return withTableSort({
    tableDimensions: saved.tableDimensions ?? DEFAULT_USAGE_VIEW.tableDimensions,
    sort: saved.sort ?? DEFAULT_SORT[metric],
  });
}

/** Sorting by period needs periods to sort, so it brings the dimension along. */
export function withTableSort({ tableDimensions, sort }: UsageTableView): UsageTableView {
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
  tableDimensions: UsageTableView["tableDimensions"],
): UsageTableViewPatch {
  const sort = view.sort.filter((criterion) => criterion.field !== "period");
  if (tableDimensions.includes("period") || sort.length === view.sort.length) {
    return { tableDimensions };
  }
  return { tableDimensions, sort: sort.length > 0 ? sort : undefined };
}

const MAX_VISIBLE_ROWS = 200;

const DEFAULT_DIRECTION: { readonly [Field in UsageSortField]: UsageSortCriterion["direction"] } = {
  costUsd: "descending",
  totalTokens: "descending",
  label: "ascending",
  period: "descending",
};

function sortFieldName(field: UsageSortField, grouping: UsageTimeGrouping): string {
  if (field === "period") return GROUPING_NAMES[grouping];
  return { costUsd: "Cost", totalTokens: "Tokens", label: "Name" }[field];
}

/** How a row or heading is named: its text and the marks that tie it to the chart. */
export interface BreakdownName {
  readonly text: string;
  readonly color: string | undefined;
  readonly provider: UsageProviderKind | undefined;
}

/**
 * Sorted rows, grouped under headings when the primary sort is by name or
 * period and some rows share it. A heading's value is not repeated in its rows.
 */
export function layoutBreakdownTable(
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
  const name = (row: UsagePivotRow, nameDimensions: readonly UsageDimension[]): BreakdownName => {
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

interface UsageBreakdownTableProps {
  readonly entries: readonly UsageEntry[];
  readonly view: UsageTableView;
  readonly chartSeries: UsageChartSeries;
  readonly onViewChange: (patch: UsageTableViewPatch) => void;
  readonly grouping: UsageTimeGrouping;
  readonly metric: "cost" | "tokens";
  readonly environmentLabels: ReadonlyMap<EnvironmentId, string>;
  readonly timeZone: string;
  /** Providers whose figures are still coming in. */
  readonly loadingProviders: ReadonlySet<UsageProviderKind>;
  readonly onOpenModel: (row: UsagePivotRow & { readonly model: string }) => void;
}

/** The first `limit` rows, keeping each group's heading and full totals. */
function firstRows<Group extends { readonly rows: readonly unknown[] }>(
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

export const UsageBreakdownTable = memo(function UsageBreakdownTable({
  entries,
  view,
  chartSeries,
  onViewChange,
  grouping,
  metric,
  environmentLabels,
  timeZone,
  loadingProviders,
  onOpenModel,
}: UsageBreakdownTableProps) {
  const { tableDimensions: dimensions, sort } = view;
  const table = useMemo(
    () =>
      layoutBreakdownTable(entries, view, { environmentLabels, grouping, timeZone }, chartSeries),
    [chartSeries, entries, environmentLabels, grouping, timeZone, view],
  );
  const [showAllRows, setShowAllRows] = useState(false);
  const groups = useMemo(
    () => (showAllRows ? table.groups : firstRows(table.groups, MAX_VISIBLE_ROWS)),
    [showAllRows, table.groups],
  );
  const isRowLoading = (row: UsagePivotRow) =>
    row.provider === undefined ? loadingProviders.size > 0 : loadingProviders.has(row.provider);

  const shareOf = (totals: UsageTotals) => modelShare(totals, metric);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">Breakdown</h2>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label="Break down by"
            variant="segmented"
            multiple
            value={[...dimensions]}
            onValueChange={(next) =>
              onViewChange(
                withTableDimensions(
                  view,
                  USAGE_DIMENSIONS.filter((dimension) => next.includes(dimension)),
                ),
              )
            }
          >
            {USAGE_DIMENSIONS.map((dimension) => (
              <Toggle key={dimension} value={dimension}>
                {dimension === "period" ? GROUPING_NAMES[grouping] : DIMENSION_NAMES[dimension]}
              </Toggle>
            ))}
          </ToggleGroup>
          <UsageSortEditor
            sort={sort}
            grouping={grouping}
            onChange={(next) => onViewChange(withTableSort({ ...view, sort: next }))}
          />
        </div>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-right text-xs text-muted-foreground">
            <th className="w-full py-2 text-left font-normal">
              {dimensions.length === 0
                ? "Total"
                : USAGE_DIMENSIONS.filter((dimension) => dimensions.includes(dimension))
                    .map((dimension) =>
                      dimension === "period"
                        ? GROUPING_NAMES[grouping]
                        : DIMENSION_NAMES[dimension],
                    )
                    .join(" · ")}
            </th>
            <th className="py-2 pl-6 font-normal">Cost</th>
            <th className="hidden py-2 pl-6 font-normal sm:table-cell">Share</th>
            <th className="py-2 pl-6 font-normal">Tokens</th>
          </tr>
        </thead>
        {groups.length === 0 ? (
          <tbody>
            <tr>
              <td colSpan={4} className="py-6 text-center text-muted-foreground">
                No activity in this window.
              </td>
            </tr>
          </tbody>
        ) : (
          groups.map((group) => (
            <tbody key={group.key}>
              {table.grouped ? (
                <tr className="border-b border-border/50 text-right whitespace-nowrap text-foreground tabular-nums">
                  <th scope="rowgroup" className="pt-4 pb-2 text-left font-medium">
                    <BreakdownNameView name={group.heading} />
                  </th>
                  <UsageFigureCells
                    totals={group}
                    share={shareOf(group)}
                    loading={group.rows.some(({ row }) => isRowLoading(row))}
                    className="pt-4 pb-2 font-medium"
                  />
                </tr>
              ) : null}
              {group.rows.map(({ row, name }) => {
                const model = row.model;
                return (
                  <tr
                    key={row.key}
                    className={cn(
                      "relative border-b border-border/50 text-right whitespace-nowrap text-muted-foreground tabular-nums transition-colors",
                      model !== undefined && "hover:bg-muted/50 has-focus-visible:bg-muted/50",
                    )}
                  >
                    <td
                      className={cn("py-2.5 text-left whitespace-normal", table.grouped && "pl-3")}
                    >
                      {model === undefined ? (
                        <BreakdownNameView name={name} />
                      ) : (
                        // The button's overlay makes the whole row open the model.
                        // Focus shows as the row's hover fill, not a ring.
                        <button
                          type="button"
                          onClick={() => onOpenModel({ ...row, model })}
                          className="text-left outline-none after:absolute after:inset-0"
                        >
                          <BreakdownNameView name={name} />
                        </button>
                      )}
                    </td>
                    <UsageFigureCells
                      totals={row}
                      share={shareOf(row)}
                      loading={isRowLoading(row)}
                      className="py-2.5"
                    />
                  </tr>
                );
              })}
            </tbody>
          ))
        )}
      </table>
      {groups === table.groups ? null : (
        <div>
          <Button size="xs" variant="ghost-muted" onClick={() => setShowAllRows(true)}>
            Show all {formatCount(table.rowCount)} rows
          </Button>
        </div>
      )}
    </section>
  );
});

function BreakdownNameView({ name }: { readonly name: BreakdownName }) {
  return (
    <span className="flex min-w-0 items-center gap-2 text-foreground">
      {name.color === undefined ? null : (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: name.color }}
        />
      )}
      {name.provider === undefined ? null : (
        <ProviderMark provider={name.provider} className="size-3.5" />
      )}
      <span className="min-w-0">{name.text}</span>
    </span>
  );
}

/** Cost, share, and tokens. An unpriced cost is unknown, never a real $0. */
function UsageFigureCells({
  totals,
  share,
  loading,
  className,
}: {
  readonly totals: UsageTotals;
  readonly share: number | null;
  readonly loading: boolean;
  readonly className: string;
}) {
  const figures = cn(className, "pl-6 transition-opacity", loading && "opacity-40 delay-150");
  return (
    <>
      <td className={cn(figures, "text-foreground")}>
        {isModelCostUnknown(totals) ? (
          <span className="text-muted-foreground">Unpriced</span>
        ) : (
          formatUsd(totals.costUsd)
        )}
      </td>
      <td className={cn(figures, "hidden sm:table-cell")}>
        {share === null ? "" : formatPercent(share)}
      </td>
      <td className={figures}>{formatTokens(totals.totalTokens)}</td>
    </>
  );
}

function UsageSortEditor({
  sort,
  grouping,
  onChange,
}: {
  readonly sort: readonly UsageSortCriterion[];
  readonly grouping: UsageTimeGrouping;
  readonly onChange: (sort: readonly UsageSortCriterion[]) => void;
}) {
  const replace = (index: number, criterion: UsageSortCriterion) =>
    onChange(sort.map((entry, position) => (position === index ? criterion : entry)));
  const unused = USAGE_SORT_FIELDS.find((field) => !sort.some((entry) => entry.field === field));
  const primary = sort[0];

  return (
    <Popover>
      <PopoverTrigger render={<Button size="xs" variant="ghost-muted" />}>
        <ArrowUpDownIcon aria-hidden />
        {primary === undefined
          ? "Sort"
          : `${sortFieldName(primary.field, grouping)}${sort.length > 1 ? ` +${sort.length - 1}` : ""}`}
      </PopoverTrigger>
      <PopoverPopup align="end">
        <div className="flex flex-col gap-2 text-xs">
          {sort.map((criterion, index) => (
            <div key={criterion.field} className="flex items-center gap-1">
              <span className="w-14 shrink-0 text-muted-foreground">
                {index === 0 ? "Sort by" : "Then by"}
              </span>
              <Select
                value={criterion.field}
                onValueChange={(value) => {
                  const field = USAGE_SORT_FIELDS.find((option) => option === value);
                  if (field) replace(index, { field, direction: DEFAULT_DIRECTION[field] });
                }}
              >
                <SelectTrigger aria-label={`Sort field ${index + 1}`} size="xs" className="w-28">
                  <SelectValue>{sortFieldName(criterion.field, grouping)}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {USAGE_SORT_FIELDS.map((field) => (
                    <SelectItem
                      key={field}
                      value={field}
                      disabled={
                        field !== criterion.field && sort.some((entry) => entry.field === field)
                      }
                    >
                      {sortFieldName(field, grouping)}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={criterion.direction === "ascending" ? "Ascending" : "Descending"}
                title={criterion.direction === "ascending" ? "Ascending" : "Descending"}
                onClick={() =>
                  replace(index, {
                    ...criterion,
                    direction: criterion.direction === "ascending" ? "descending" : "ascending",
                  })
                }
              >
                {criterion.direction === "ascending" ? (
                  <ArrowUpIcon aria-hidden />
                ) : (
                  <ArrowDownIcon aria-hidden />
                )}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Move up"
                title="Move up"
                disabled={index === 0}
                onClick={() =>
                  onChange([
                    ...sort.slice(0, index - 1),
                    criterion,
                    ...sort.slice(index - 1, index),
                    ...sort.slice(index + 1),
                  ])
                }
              >
                <ChevronUpIcon aria-hidden />
              </Button>
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Remove"
                title="Remove"
                disabled={sort.length === 1}
                onClick={() => onChange(sort.filter((_, position) => position !== index))}
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            size="xs"
            variant="ghost-muted"
            className="self-start"
            disabled={unused === undefined}
            onClick={() => {
              if (unused)
                onChange([...sort, { field: unused, direction: DEFAULT_DIRECTION[unused] }]);
            }}
          >
            <PlusIcon aria-hidden />
            Add
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
