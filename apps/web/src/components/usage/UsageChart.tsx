import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { UsageEntry } from "@t3tools/shared/usageMerge";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import {
  buildStackedColumns,
  type UsageStackedColumn,
  type UsageTimeGrouping,
} from "@t3tools/shared/usagePivot";
import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import type { UsageChartDimension } from "./usagePagePreferences";
import {
  DIMENSION_NAMES,
  GROUPING_ADJECTIVES,
  OTHER_SERIES_COLOR,
  formatPeriod,
  formatPeriodShort,
  usageSeriesColors,
  usageSeriesLabels,
} from "./usageSeries";

const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 260;
const TICK_COUNT = 4;
const PLOT_TOP = 8;
const NONE_LOADING: ReadonlySet<UsageProviderKind> = new Set();
const NO_ENVIRONMENT_LABELS: ReadonlyMap<EnvironmentId, string> = new Map();

export type UsageChartMetric = "tokens" | "cost";

interface UsageChartProps {
  readonly entries: readonly UsageEntry[];
  /** Series are every combination of these. None draws a single total. */
  readonly dimensions: readonly UsageChartDimension[];
  readonly grouping: UsageTimeGrouping;
  /** One per column, oldest first. */
  readonly periods: readonly string[];
  readonly metric: UsageChartMetric;
  readonly environmentLabels?: ReadonlyMap<EnvironmentId, string>;
  /** Providers whose figures are still coming in: their series are muted. */
  readonly loadingProviders?: ReadonlySet<UsageProviderKind>;
  readonly referenceTime: string | undefined;
  readonly timeZone: string;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

/** Shape-preserving cubic tangents that cannot overshoot spiky usage data. */
function monotoneTangents(points: readonly Point[]): readonly number[] {
  const count = points.length;
  if (count < 2) return [0];

  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const dx = (points[index + 1]?.x ?? 0) - (points[index]?.x ?? 0);
    const dy = (points[index + 1]?.y ?? 0) - (points[index]?.y ?? 0);
    slopes.push(dx === 0 ? 0 : dy / dx);
  }

  const tangents: number[] = Array.from({ length: count }, () => 0);
  tangents[0] = slopes[0] ?? 0;
  tangents[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const previous = slopes[index - 1] ?? 0;
    const next = slopes[index] ?? 0;
    tangents[index] = previous * next <= 0 ? 0 : (previous + next) / 2;
  }

  for (let index = 0; index < count - 1; index += 1) {
    const slope = slopes[index] ?? 0;
    if (slope === 0) {
      tangents[index] = 0;
      tangents[index + 1] = 0;
      continue;
    }
    const a = (tangents[index] ?? 0) / slope;
    const b = (tangents[index + 1] ?? 0) / slope;
    const magnitude = a * a + b * b;
    if (magnitude > 9) {
      const scale = 3 / Math.sqrt(magnitude);
      tangents[index] = scale * a * slope;
      tangents[index + 1] = scale * b * slope;
    }
  }

  return tangents;
}

function curvePath(points: readonly Point[]): string {
  const first = points[0];
  if (first === undefined || points.length < 2) return "";
  const tangents = monotoneTangents(points);
  let path = `M${first.x.toFixed(2)},${first.y.toFixed(2)}`;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index];
    const to = points[index + 1];
    if (from === undefined || to === undefined) continue;
    const dx = to.x - from.x;
    const c1 = { x: from.x + dx / 3, y: from.y + ((tangents[index] ?? 0) * dx) / 3 };
    const c2 = { x: to.x - dx / 3, y: to.y - ((tangents[index + 1] ?? 0) * dx) / 3 };
    path += ` C${c1.x.toFixed(2)},${c1.y.toFixed(2)} ${c2.x.toFixed(2)},${c2.y.toFixed(2)} ${to.x.toFixed(2)},${to.y.toFixed(2)}`;
  }
  return path;
}

/** The region between two boundaries, tracing the bottom one backwards. */
function bandAreaPath(top: readonly Point[], bottom: readonly Point[]): string {
  const forward = curvePath(top);
  const back = curvePath(bottom.toReversed());
  if (forward === "" || back === "") return "";
  return `${forward} L${back.slice(1)} Z`;
}

/**
 * Builds a scale whose maximum is a readable 1/2/5 x 10^n step at or above the
 * peak.
 *
 * Rounding the maximum *up* is the point: stopping at the last step below the
 * peak leaves the tallest day drawn past the top of the plot, where it is
 * clipped.
 */
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

/**
 * Scales to the tallest stack. With nothing to show yet while providers load,
 * unlabeled placeholder gridlines hold their usual spacing so nothing shifts
 * on arrival.
 */
export function chartScale(peak: number, awaitingData: boolean) {
  return peak === 0 && awaitingData
    ? { max: TICK_COUNT, ticks: PLACEHOLDER_TICKS, labeled: false }
    : { ...niceScale(peak, TICK_COUNT), labeled: true };
}

// Leave room above the top gridline so the constant-width stroke is not
// clipped when a series reaches the peak.
function valueToY(value: number, max: number) {
  return max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / max) * (VIEW_HEIGHT - PLOT_TOP);
}

/**
 * One boundary per stack level, as y per column: level 0 is the baseline and
 * level i + 1 the top of series i. Neighbouring bands share one boundary, so
 * they cannot drift apart where the curves smooth.
 */
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

/** A lone column spans the plot as a flat band rather than vanishing. */
function columnXs(count: number): readonly number[] {
  if (count === 1) return [0, VIEW_WIDTH];
  const stepX = count < 2 ? 0 : VIEW_WIDTH / (count - 1);
  return Array.from({ length: count }, (_, index) => index * stepX);
}

function toPoints(ys: readonly number[], xs: readonly number[]): readonly Point[] {
  return xs.map((x, index) => ({ x, y: ys[Math.min(index, ys.length - 1)] ?? VIEW_HEIGHT }));
}

export function UsageChart({
  entries,
  dimensions,
  grouping,
  periods,
  metric,
  environmentLabels = NO_ENVIRONMENT_LABELS,
  loadingProviders = NONE_LOADING,
  referenceTime,
  timeZone,
}: UsageChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const hoverPositionRef = useRef<{ x: number; y: number } | null>(null);

  const chart = useMemo(() => {
    const stack = buildStackedColumns(
      entries,
      dimensions,
      grouping,
      periods,
      metric === "tokens" ? "tokens" : "cost",
    );
    const scale = chartScale(stack.peak, loadingProviders.size > 0);
    const colors = usageSeriesColors(
      stack.series.flatMap((series) => (series.row === null ? [] : [series.row])),
      dimensions,
    );
    const labels = usageSeriesLabels(stack.series, dimensions, {
      environmentLabels,
      grouping,
      timeZone,
    });
    const series = stack.series.map((entry, index) => ({
      key: entry.key,
      label: labels[index] ?? "",
      color: colors.get(entry.key) ?? OTHER_SERIES_COLOR,
      loading:
        entry.row?.provider === undefined
          ? loadingProviders.size > 0
          : loadingProviders.has(entry.row.provider),
    }));
    const xs = columnXs(stack.columns.length);
    const boundaries = stackBoundaries(stack.columns, series.length, scale.max).map((ys) =>
      toPoints(ys, xs),
    );
    const bands = series.map((entry, index) => {
      const top = boundaries[index + 1] ?? [];
      return { ...entry, line: curvePath(top), area: bandAreaPath(top, boundaries[index] ?? []) };
    });
    return { columns: stack.columns, scale, series, bands };
  }, [
    dimensions,
    entries,
    environmentLabels,
    grouping,
    loadingProviders,
    metric,
    periods,
    timeZone,
  ]);
  const { columns, scale, series, bands } = chart;
  const toY = (value: number) => valueToY(value, scale.max);
  // The delay keeps a quick answer from flashing, as with the page's figures.
  const seriesClassName = (loading: boolean) =>
    cn("transition-opacity", loading && "opacity-40 delay-150");

  const format = metric === "tokens" ? formatTokens : formatUsd;

  const positionTooltip = useCallback(() => {
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
  }, []);

  useLayoutEffect(() => {
    if (hoverIndex === null) return;
    positionTooltip();

    const plot = plotRef.current;
    const tooltip = tooltipRef.current;
    if (plot === null || tooltip === null) return;

    return observeResize([plot, tooltip], positionTooltip);
  }, [hoverIndex, positionTooltip]);

  const handleMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const plot = plotRef.current;
      if (plot === null || periods.length === 0) return;
      const bounds = plot.getBoundingClientRect();
      if (bounds.width === 0) return;
      const localX = Math.min(bounds.width, Math.max(0, event.clientX - bounds.left));
      const localY = Math.min(bounds.height, Math.max(0, event.clientY - bounds.top));
      const fraction = localX / bounds.width;
      const index = Math.round(fraction * (periods.length - 1));
      hoverPositionRef.current = { x: localX, y: localY };
      positionTooltip();
      setHoverIndex(Math.min(periods.length - 1, Math.max(0, index)));
    },
    [periods.length, positionTooltip],
  );

  const hoveredPeriod = hoverIndex === null ? undefined : periods[hoverIndex];
  const hoveredColumn = hoverIndex === null ? undefined : columns[hoverIndex];
  const hoverX =
    hoverIndex === null
      ? 0
      : periods.length === 1
        ? VIEW_WIDTH / 2
        : (hoverIndex * VIEW_WIDTH) / Math.max(1, periods.length - 1);
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
        {/* Axis labels sit outside the plot so they stay aligned to gridlines. */}
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
            aria-label={`${GROUPING_ADJECTIVES[grouping]} ${metric === "tokens" ? "processed tokens" : "cost"}${
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

            {/* Fills first, then every stroke, so no band covers another's edge. */}
            {bands.map(({ key, loading, area, color }) => (
              <path
                key={key}
                d={area}
                className={seriesClassName(loading)}
                fill={color}
                fillOpacity={0.24}
              />
            ))}
            {bands.map(({ key, loading, line, color }) => (
              <path
                key={key}
                d={line}
                className={seriesClassName(loading)}
                fill="none"
                stroke={color}
                strokeWidth={1.5}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {hoverIndex === null ? null : (
              <line
                x1={hoverX}
                x2={hoverX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>

          {hoveredPeriod === undefined ? null : (
            <div
              ref={tooltipRef}
              className="surface-glass pointer-events-none absolute z-10 min-w-36 max-w-full rounded-xl border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: "var(--usage-tooltip-left, 0px)",
                top: "var(--usage-tooltip-top, 0px)",
              }}
            >
              <div className="mb-1 text-muted-foreground">
                {formatPeriod(hoveredPeriod, grouping, timeZone, referenceTime)}
              </div>
              {/* Top of the stack first, matching the bands' visual order. */}
              {series.toReversed().flatMap((entry, reversedIndex) => {
                const value = hoveredColumn?.values[series.length - 1 - reversedIndex] ?? 0;
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
                <span
                  className={cn(
                    "tabular-nums",
                    partial ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {format(hoveredColumn?.total ?? 0)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex justify-between pl-16 text-3xs text-muted-foreground uppercase">
        {axisPeriods.map(({ position, period }) => (
          <span key={position}>
            {period === undefined ? "" : formatPeriodShort(period, grouping, timeZone)}
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
