import { Chart, Host, type ChartDataPoint } from "@expo/ui/swift-ui";
import { frame } from "@expo/ui/swift-ui/modifiers";

import type { UsageChartSeries } from "@t3tools/client-runtime/usage-view";

export interface UsageDailyChartProps {
  readonly series: UsageChartSeries;
  readonly height: number;
}

export function UsageDailyChart({ series, height }: UsageDailyChartProps) {
  const { stack, colors } = series;

  // Bars at one x stack in data order, so the first series sits on the baseline.
  const data: ChartDataPoint[] = stack.columns.flatMap((column) =>
    column.values.map((value, index) => {
      const color = colors.get(stack.series[index]?.key ?? "");
      return { x: column.period, y: value, ...(color === undefined ? {} : { color }) };
    }),
  );

  return (
    <Host style={{ height, width: "100%" }}>
      <Chart
        type="bar"
        data={data}
        animate
        showGrid={false}
        barStyle={{ cornerRadius: 2 }}
        modifiers={[frame({ height })]}
      />
    </Host>
  );
}
