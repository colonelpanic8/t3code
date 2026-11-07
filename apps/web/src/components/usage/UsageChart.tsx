import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { useLayoutEffect, useRef, useState } from "react";

import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import type { UsageStackedColumn, UsageTimeGrouping } from "@t3tools/shared/usagePivot";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import {
  DIMENSION_NAMES,
  GROUPING_ADJECTIVES,
  formatPeriod,
  formatPeriodShort,
  usageSeriesLabels,
  type UsageChartSeries,
} from "./usageSeries";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();
const NO_ENVIRONMENT_LABELS: ReadonlyMap<EnvironmentId, string> = new Map();

export type UsageChartMetric = "tokens" | "cost";

interface UsageChartProps {
  readonly series: UsageChartSeries;
  readonly grouping: UsageTimeGrouping;
  readonly metric: UsageChartMetric;
  readonly environmentLabels?: ReadonlyMap<EnvironmentId, string>;
  /** Providers whose figures are still coming in: their series are muted. */
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly referenceTime: string | undefined;
  readonly timeZone: string;
  readonly hour12: boolean;
}

export function niceScale(peak: number, count: number): { max: number; ticks: readonly number[] } {
  if (peak <= 0) return { max: 0, ticks: [0] };

  const rawStep = peak / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = (normalized > 5 ? 10 : normalized > 2 ? 5 : normalized > 1 ? 2 : 1) * magnitude;

  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= max + step * 1e-6; value += step) ticks.push(value);
  return { max, ticks };
}

const PLACEHOLDER_TICKS = Array.from({ length: TICK_COUNT + 1 }, (_, index) => index);

export function chartScale(peak: number, awaitingData: boolean) {
  return peak === 0 && awaitingData
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

function valueToY(value: number, max: number) {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

export function stackBoundaries(
  columns: readonly UsageStackedColumn[],
  seriesCount: number,
  max: number,
): readonly (readonly number[])[] {
  const running = columns.map(() => 0);
  const boundaries = [columns.map(() => valueToY(0, max))];
  for (let series = 0; series < seriesCount; series += 1) {
    boundaries.push(
      columns.map((column, index) => {
        running[index] = (running[index] ?? 0) + (column.values[series] ?? 0);
        return valueToY(running[index] ?? 0, max);
      }),
    );
  }
  return boundaries;
}

const BAR_GAP_FRACTION = 0.2;

function barSlot(index: number, count: number) {
  const step = VIEW_WIDTH / Math.max(1, count);
  return { x: index * step, step, bar: step * (1 - BAR_GAP_FRACTION) };
}

interface ChartSeriesEntry {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly loading: boolean;
}

function UsageChartTooltip({
  tooltipRef,
  label,
  column,
  series,
  partial,
  format,
}: {
  readonly tooltipRef: React.Ref<HTMLDivElement>;
  readonly label: string;
  readonly column: UsageStackedColumn | undefined;
  readonly series: readonly ChartSeriesEntry[];
  readonly partial: boolean;
  readonly format: (value: number) => string;
}) {
  return (
    <div
      ref={tooltipRef}
      className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
      style={{
        left: "var(--usage-tooltip-left, 0px)",
        top: "var(--usage-tooltip-top, 0px)",
      }}
    >
      <div className="mb-1 text-muted-foreground">{label}</div>
      {/* Top of the stack first, matching the bands' visual order. */}
      {series.toReversed().flatMap((entry, reversedIndex) => {
        const value = column?.values[series.length - 1 - reversedIndex] ?? 0;
        if (value <= 0) return [];
        return [
          <div key={entry.key} className="flex items-center justify-between gap-3">
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate">{entry.label}</span>
            </span>
            <span
              className={cn(
                "tabular-nums",
                entry.loading ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {format(value)}
            </span>
          </div>,
        ];
      })}
      <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
        <span className="text-muted-foreground">Total</span>
        <span className={cn("tabular-nums", partial ? "text-muted-foreground" : "text-foreground")}>
          {format(column?.total ?? 0)}
        </span>
      </div>
    </div>
  );
}

function UsageChartPlot({
  periods,
  columns,
  series,
  partial,
  format,
  formatTooltipPeriod,
  ariaLabel,
  children,
}: {
  readonly periods: readonly string[];
  readonly columns: readonly UsageStackedColumn[];
  readonly series: readonly ChartSeriesEntry[];
  readonly partial: boolean;
  readonly format: (value: number) => string;
  readonly formatTooltipPeriod: (period: string) => string;
  readonly ariaLabel: string;
  readonly children: React.ReactNode;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const positionTooltip = () => {
    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    const hoverPosition = hoverPositionRef.current;
    if (plot === null || tooltip === null || hoverPosition === null) return;

    const gap = 12;
    const tooltipWidth = tooltip.offsetWidth;
    const tooltipHeight = tooltip.offsetHeight;
    const plotWidth = plot.clientWidth;
    const plotHeight = plot.clientHeight;
    const preferredLeft =
      hoverPosition.x + gap + tooltipWidth <= plotWidth
        ? hoverPosition.x + gap
        : hoverPosition.x - gap - tooltipWidth;
    const preferredTop =
      hoverPosition.y + gap + tooltipHeight <= plotHeight
        ? hoverPosition.y + gap
        : hoverPosition.y - gap - tooltipHeight;
    const left = Math.min(Math.max(0, preferredLeft), Math.max(0, plotWidth - tooltipWidth));
    const top = Math.min(Math.max(0, preferredTop), Math.max(0, plotHeight - tooltipHeight));
    plot.style.setProperty("--usage-tooltip-left", `${left}px`);
    plot.style.setProperty("--usage-tooltip-top", `${top}px`);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- positions the hover tooltip through plot CSS variables before paint and on ResizeObserver
  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const plot = plotRef.current;
    if (plot === null || periods.length === 0) return;
    const bounds = plot.getBoundingClientRect();
    if (bounds.width === 0) return;
    const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
    const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
    const fraction = localX / bounds.width;
    const index = Math.floor(fraction * periods.length);
    hoverPositionRef.current = { x: localX, y: localY };
    positionTooltip();
    setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
  };

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoverSlot = hoverIndex === null ? null : barSlot(hoverIndex, periods.length);

  return (
    <div
      ref={plotRef}
      className="relative h-56 flex-1"
      onMouseMove={handleMove}
      onMouseLeave={() => {
        hoverPositionRef.current = null;
        setHoverIndex(null);
      }}
    >
      <svg
        className="h-full w-full"
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={ariaLabel}
      >
        {hoverSlot === null ? null : (
          <rect
            x={hoverSlot.x}
            y={PLOT_TOP}
            width={hoverSlot.step}
            height={VIEW_HEIGHT - PLOT_TOP}
            fill="currentColor"
            className="text-muted-foreground/15"
          />
        )}
        {children}
      </svg>

      {hoverIndex === null || hoveredPeriod === undefined ? null : (
        <UsageChartTooltip
          tooltipRef={tooltipRef}
          label={formatTooltipPeriod(hoveredPeriod)}
          column={columns[hoverIndex]}
          series={series}
          partial={partial}
          format={format}
        />
      )}
    </div>
  );
}

export function UsageChart({
  series: chartSeries,
  grouping,
  metric,
  environmentLabels = NO_ENVIRONMENT_LABELS,
  loadingProviders = NONE_LOADING,
  referenceTime,
  timeZone,
  hour12,
}: UsageChartProps) {
  const { stack, colors, dimensions } = chartSeries;
  const scale = chartScale(stack.peak, loadingProviders.size > 0);
  const labels = usageSeriesLabels(stack.series, dimensions, {
    environmentLabels,
    grouping,
    timeZone,
    hour12,
  });
  const series = stack.series.map((entry, index) => ({
    key: entry.key,
    label: labels[index] ?? "",
    color: colors.get(entry.key) ?? "",
    loading:
      entry.row?.provider === undefined
        ? loadingProviders.size > 0
        : loadingProviders.has(entry.row.provider),
  }));
  const columns = stack.columns;
  const boundaries = stackBoundaries(columns, series.length, scale.max);
  const bars = series.map((entry, index) => ({
    ...entry,
    segments: columns.flatMap((column, columnIndex) => {
      if ((column.values[index] ?? 0) <= 0) return [];
      const top = boundaries[index + 1]?.[columnIndex] ?? VIEW_HEIGHT;
      const bottom = boundaries[index]?.[columnIndex] ?? VIEW_HEIGHT;
      const slot = barSlot(columnIndex, columns.length);
      return [
        {
          period: column.period,
          x: slot.x + (slot.step - slot.bar) / 2,
          width: slot.bar,
          y: top,
          height: bottom - top,
        },
      ];
    }),
  }));
  const periods = columns.map((column) => column.period);

  const toY = (value: number) => valueToY(value, scale.max);
  const seriesClassName = (loading: boolean) =>
    cn("transition-opacity", loading && "opacity-40 delay-150");
  const format = metric === "tokens" ? formatTokens : formatUsd;
  const formatTooltipPeriod = (period: string) =>
    formatPeriod(period, grouping, timeZone, referenceTime, hour12);
  const partial = loadingProviders.size > 0;
  const showLegend =
    series.length > 1 && !(dimensions.length === 1 && dimensions[0] === "provider");
  const axisPeriods = [
    { position: "start", period: periods[0] },
    { position: "middle", period: periods[Math.floor(periods.length / 2)] },
    { position: "end", period: periods.at(-1) },
  ];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-2">
        <div className="relative h-56 w-14 shrink-0">
          {scale.labeled
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : format(tick)}
                </span>
              ))
            : null}
        </div>

        <UsageChartPlot
          periods={periods}
          columns={columns}
          series={series}
          partial={partial}
          format={format}
          formatTooltipPeriod={formatTooltipPeriod}
          ariaLabel={`${GROUPING_ADJECTIVES[grouping]} ${metric === "tokens" ? "processed tokens" : "cost"}${
            dimensions.length === 0
              ? ""
              : ` by ${dimensions.map((dimension) => DIMENSION_NAMES[dimension].toLowerCase()).join(" and ")}`
          }`}
        >
          {scale.ticks.map((tick) => {
            const y = toY(tick);
            return (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {bars.map(({ key, loading, color, segments }) => (
            <g key={key} className={seriesClassName(loading)} fill={color}>
              {segments.map((segment) => (
                <rect
                  key={segment.period}
                  x={segment.x}
                  y={segment.y}
                  width={segment.width}
                  height={segment.height}
                />
              ))}
            </g>
          ))}
        </UsageChartPlot>
      </div>

      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        {axisPeriods.map(({ position, period }) => (
          <span key={position}>
            {period === undefined ? "" : formatPeriodShort(period, grouping, timeZone, hour12)}
          </span>
        ))}
      </div>

      {showLegend ? (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 pt-1 pl-16 text-xs text-muted-foreground">
          {series.map((entry) => (
            <li key={entry.key} className="flex min-w-0 max-w-full items-center gap-1.5">
              <span
                aria-hidden
                className={cn("size-2 shrink-0 rounded-full", seriesClassName(entry.loading))}
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate">{entry.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
