import { View } from "react-native";

import type { UsageChartSeries } from "@t3tools/client-runtime/usage-view";

export interface UsageDailyChartProps {
  readonly series: UsageChartSeries;
  readonly height: number;
}

export function UsageDailyChart({ series, height }: UsageDailyChartProps) {
  const { stack, colors } = series;
  const max = stack.peak;

  return (
    <View style={{ height }} className="flex-row items-end gap-px">
      {/* Use column-reverse: series values are bottom-first and Hermes lacks toReversed. */}
      {stack.columns.map((column) => (
        <View
          key={column.period}
          style={{ height: max === 0 ? 0 : (column.total / max) * height }}
          className="flex-1 flex-col-reverse overflow-hidden rounded-t-sm"
        >
          {column.values.map((value, index) => {
            const key = stack.series[index]?.key ?? String(index);
            return value > 0 ? (
              <View
                key={key}
                style={{
                  height: (value / max) * height,
                  backgroundColor: colors.get(key),
                }}
              />
            ) : null;
          })}
        </View>
      ))}
    </View>
  );
}
