/** Equity vs passive benchmark. Our line is phosphor, the benchmark amber and
 *  dashed — the two must never be confusable at a glance. Historical runs get
 *  real UTC dates on the axis; synthetic runs keep relative day labels. */
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

export function EquityChart({ result }: { result: DisplayResult }) {
  const { times, equity, benchmark } = result.equity;
  const axis = timeAxisFor(result);
  const data = times.map((ts, i) => ({
    ts,
    equity: equity[i],
    benchmark: benchmark[i],
  }));

  return (
    <div className="chart-wrap">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#26303B" strokeDasharray="2 4" />
          <XAxis
            dataKey="ts"
            type="number"
            domain={["dataMin", "dataMax"]}
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: "B612 Mono" }}
            tickFormatter={(ts: number) => axis.tick(ts)}
            ticks={axis.epochTicks(times[0] ?? 0, times.at(-1) ?? 0)}
          />
          <YAxis
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: "B612 Mono" }}
            tickFormatter={(v: number) => v.toPrecision(3)}
            width={70}
          />
          <Tooltip
            contentStyle={{
              background: "#12171E",
              border: "1px solid #26303B",
              fontFamily: "B612 Mono",
              fontSize: 11,
            }}
            labelFormatter={(ts) => axis.label(Number(ts))}
            formatter={(value) => (typeof value === "number" ? value.toPrecision(6) : String(value))}
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
            dataKey="benchmark"
            name="passive benchmark"
            stroke="#E8B44F"
            strokeWidth={1.4}
            strokeDasharray="5 4"
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
