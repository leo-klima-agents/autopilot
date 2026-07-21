/** Equity vs the two benchmarks. Our line is phosphor, the market benchmark
 *  amber and dashed, the revenue (foresight) benchmark cyan and dashed;
 *  none confusable at a glance. Historical runs get real UTC dates on the
 *  axis; synthetic runs keep relative day labels. */
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DisplayResult } from "../lib/serialize.js";
import { timeAxisFor } from "../lib/timeAxis.js";
import { fmt } from "../lib/format.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD, Y_AXIS_WIDTH } from "../lib/chartGeometry.js";

// recharts sets tick/tooltip fonts via inline style, so mirror the CSS
// --font-mono native stack here (SVG text can't read the CSS custom property).
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace';

export function EquityChart({ result }: { result: DisplayResult }) {
  const { times, equity, marketBenchmark, revenueBenchmark } = result.equity;
  const axis = timeAxisFor(result);
  // equity is revenue per unit weight: comma-group large values, keep
  // significant digits on small ones, "$"-prefix USD-priced runs
  const money = (v: number, precision: number) =>
    (result.revenueUnit === "usd" ? "$" : "") + (Math.abs(v) >= 1000 ? fmt(v, 0) : v.toPrecision(precision));
  const data = times.map((ts, i) => ({
    ts,
    equity: equity[i],
    marketBenchmark: marketBenchmark[i],
    revenueBenchmark: revenueBenchmark[i],
  }));

  return (
    <div className="chart-wrap">
      <ResponsiveContainer>
        {/* plot area spans [TIME_AXIS_LEFT, width - TIME_AXIS_RIGHT_PAD], the
            heat-map uses the same span, so dates align vertically across panels */}
        <LineChart
          data={data}
          margin={{ top: 8, right: TIME_AXIS_RIGHT_PAD, bottom: 4, left: TIME_AXIS_LEFT - Y_AXIS_WIDTH }}
        >
          <CartesianGrid stroke="#26303B" strokeDasharray="2 4" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: MONO }}
            tickFormatter={(ts: number) => axis.tick(ts)}
            ticks={axis.epochTicks(times[0] ?? 0, times.at(-1) ?? 0)}
          />
          <YAxis
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: MONO }}
            tickFormatter={(v: number) => money(v, 3)}
            width={Y_AXIS_WIDTH}
          />
          <Tooltip
            contentStyle={{
              background: "#12171E",
              border: "1px solid #26303B",
              fontFamily: MONO,
              fontSize: 11,
            }}
            labelFormatter={(ts) => axis.label(Number(ts))}
            formatter={(value) => (typeof value === "number" ? money(value, 6) : String(value))}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="equity"
            name="strategy"
            stroke="#6FD3A6"
            strokeWidth={1.8}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="marketBenchmark"
            name="market benchmark"
            stroke="#E8B44F"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="revenueBenchmark"
            name="revenue benchmark (foresight)"
            stroke="#6FB8D3"
            strokeWidth={1.4}
            strokeDasharray="2 3"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
