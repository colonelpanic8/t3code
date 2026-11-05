import type { UsageProviderKind } from "@t3tools/contracts";
import {
  USAGE_DIMENSION_NAMES,
  USAGE_GROUPING_NAMES,
  firstUsageRows,
  layoutUsageBreakdown,
  usageShare,
  usageSortFieldName,
  withSortField,
  withTableDimensions,
  type UsageBreakdownName,
  type UsageChartSeries,
  type UsageLabelContext,
  type UsageTableView,
  type UsageTableViewPatch,
} from "@t3tools/client-runtime/usage-view";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { isModelCostUnknown, type UsageEntry } from "@t3tools/shared/usageMerge";
import {
  USAGE_DIMENSIONS,
  USAGE_SORT_FIELDS,
  type UsageDimension,
  type UsagePivotMetric,
  type UsageTotals,
} from "@t3tools/shared/usagePivot";
import { useState } from "react";
import { View } from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { cn } from "../../lib/cn";
import { SettingsSection } from "../settings/components/SettingsSection";
import { ListFilterMenu } from "../workspace/ListFilterMenu";

// A phone renders every row; past this the list waits for "Show all".
const MAX_VISIBLE_ROWS = 25;

function dimensionName(dimension: UsageDimension, context: UsageLabelContext): string {
  return dimension === "period"
    ? USAGE_GROUPING_NAMES[context.grouping]
    : USAGE_DIMENSION_NAMES[dimension];
}

export function UsageBreakdownSection(props: {
  readonly entries: readonly UsageEntry[];
  readonly view: UsageTableView;
  readonly chartSeries: UsageChartSeries;
  readonly context: UsageLabelContext;
  readonly metric: UsagePivotMetric;
  /** Shows cost, share, and tokens as columns instead of one summary line. */
  readonly wide: boolean;
  readonly onViewChange: (patch: UsageTableViewPatch) => void;
}) {
  const { view, context, metric } = props;
  const [showAllRows, setShowAllRows] = useState(false);
  if (props.entries.length === 0) return null;

  const table = layoutUsageBreakdown(props.entries, view, context, props.chartSeries);
  const truncated = !showAllRows && table.rowCount > MAX_VISIBLE_ROWS;
  const groups = truncated ? firstUsageRows(table.groups, MAX_VISIBLE_ROWS) : table.groups;
  const dimensions = USAGE_DIMENSIONS.filter((dimension) =>
    view.tableDimensions.includes(dimension),
  );
  const primary = view.sort[0];
  const sortLabel =
    primary === undefined
      ? "Sort"
      : `${usageSortFieldName(primary.field, context.grouping)} ${primary.direction === "ascending" ? "↑" : "↓"}`;

  const controls = (
    <View className="flex-row gap-2">
      <ListFilterMenu
        label={
          dimensions.length === 0
            ? "Total"
            : dimensions.map((dimension) => dimensionName(dimension, context)).join(" · ")
        }
        accessibilityLabel="Break down by"
        actions={USAGE_DIMENSIONS.map((dimension) => ({
          id: dimension,
          title: dimensionName(dimension, context),
          state: dimensions.includes(dimension) ? ("on" as const) : ("off" as const),
        }))}
        onSelect={(id) => {
          const dimension = USAGE_DIMENSIONS.find((option) => option === id);
          if (dimension === undefined) return;
          props.onViewChange(
            withTableDimensions(
              view,
              USAGE_DIMENSIONS.filter((option) =>
                option === dimension ? !dimensions.includes(option) : dimensions.includes(option),
              ),
            ),
          );
        }}
      />
      <ListFilterMenu
        label={sortLabel}
        accessibilityLabel="Sort breakdown"
        actions={USAGE_SORT_FIELDS.map((field) => ({
          id: field,
          title: usageSortFieldName(field, context.grouping),
          ...(primary?.field === field
            ? {
                state: "on" as const,
                subtitle: primary.direction === "ascending" ? "Ascending" : "Descending",
              }
            : { state: "off" as const }),
        }))}
        onSelect={(id) => {
          const field = USAGE_SORT_FIELDS.find((option) => option === id);
          if (field !== undefined) props.onViewChange(withSortField(view, field));
        }}
      />
    </View>
  );

  return (
    <View className="gap-2">
      <SettingsSection title="Breakdown" trailing={controls}>
        {props.wide ? (
          <View className="flex-row items-center gap-4 border-b border-border-subtle px-4 py-2">
            <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
              {dimensions.length === 0
                ? "Total"
                : dimensions.map((dimension) => dimensionName(dimension, context)).join(" · ")}
            </Text>
            <Text className="w-24 text-right text-xs text-foreground-tertiary">Cost</Text>
            <Text className="w-16 text-right text-xs text-foreground-tertiary">Share</Text>
            <Text className="w-20 text-right text-xs text-foreground-tertiary">Tokens</Text>
          </View>
        ) : null}
        {groups.map((group, groupIndex) => (
          <View key={group.key}>
            {table.grouped ? (
              <BreakdownRow
                name={group.heading}
                totals={group}
                metric={metric}
                wide={props.wide}
                heading
                bordered={groupIndex > 0}
              />
            ) : null}
            {group.rows.map(({ row, name }, rowIndex) => (
              <BreakdownRow
                key={row.key}
                name={name}
                totals={row}
                metric={metric}
                wide={props.wide}
                indented={table.grouped}
                bordered={table.grouped || groupIndex > 0 || rowIndex > 0}
              />
            ))}
          </View>
        ))}
      </SettingsSection>
      {truncated ? (
        <View className="items-start">
          <Button
            tone="text"
            label={`Show all ${formatCount(table.rowCount)} rows`}
            onPress={() => setShowAllRows(true)}
          />
        </View>
      ) : null}
    </View>
  );
}

function providerIconKind(provider: UsageProviderKind): string {
  return provider === "claude" ? "claudeAgent" : provider;
}

function BreakdownRow(props: {
  readonly name: UsageBreakdownName;
  readonly totals: UsageTotals;
  readonly metric: UsagePivotMetric;
  readonly wide: boolean;
  readonly heading?: boolean;
  readonly indented?: boolean;
  readonly bordered: boolean;
}) {
  const { name, totals, metric } = props;
  const share = usageShare(totals, metric);
  const unpriced = isModelCostUnknown(totals);
  const cost = unpriced ? "Unpriced" : formatUsd(totals.costUsd);
  const tokens = formatTokens(totals.totalTokens);
  const nameView = (
    <View className="min-w-0 flex-1 flex-row items-center gap-2">
      {name.color === undefined ? null : (
        <View className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: name.color }} />
      )}
      {name.provider === undefined ? null : (
        <ProviderIcon provider={providerIconKind(name.provider)} size={14} />
      )}
      <Text
        className={cn("shrink text-base text-foreground", props.heading && "font-t3-medium")}
        numberOfLines={props.wide ? 1 : 2}
      >
        {name.text}
      </Text>
    </View>
  );

  if (props.wide) {
    return (
      <View
        className={cn(
          "flex-row items-center gap-4 px-4",
          props.heading ? "pt-4 pb-2" : "py-2.5",
          props.indented && "pl-7",
          props.bordered && "border-t border-border-subtle",
        )}
      >
        {nameView}
        <Text
          className={cn(
            "w-24 text-right text-base tabular-nums",
            unpriced ? "text-foreground-muted" : "text-foreground",
            props.heading && "font-t3-medium",
          )}
        >
          {cost}
        </Text>
        <Text className="w-16 text-right text-base tabular-nums text-foreground-muted">
          {share === null ? "" : formatPercent(share)}
        </Text>
        <Text className="w-20 text-right text-base tabular-nums text-foreground-muted">
          {tokens}
        </Text>
      </View>
    );
  }

  return (
    <View
      className={cn(
        "flex-row items-center gap-3 px-4",
        props.heading ? "pt-4 pb-2" : "py-3",
        props.indented && "pl-7",
        props.bordered && "border-t border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        {nameView}
        {props.heading ? null : (
          <Text className="text-sm text-foreground-muted">
            {metric === "tokens"
              ? `${formatPercent(totals.tokenShare)} of tokens · ${unpriced ? "no known rates" : formatUsd(totals.costUsd)}`
              : unpriced
                ? `no known rates · ${tokens} tokens`
                : `${formatPercent(share ?? 0)} of cost · ${tokens} tokens`}
          </Text>
        )}
      </View>
      <Text
        className={cn("text-base tabular-nums text-foreground", props.heading && "font-t3-medium")}
      >
        {metric === "tokens" ? tokens : cost}
      </Text>
    </View>
  );
}
