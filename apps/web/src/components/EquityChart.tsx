/** Equity vs passive benchmark. Our line is phosphor, the benchmark amber and
 *  dashed — the two must never be confusable at a glance. */
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

export function EquityChart({ result }: { result: DisplayResult }) {
  const { times, equity, benchmark } = result.equity;
  const t0 = result.startTime;
  const data = times.map((t, i) => ({
    day: (t - t0) / 86_400,
    equity: equity[i],
    benchmark: benchmark[i],
  }));

  return (
    <div className="chart-wrap">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="#26303B" strokeDasharray="2 4" />
          <XAxis
            dataKey="day"
            stroke="#7C8A96"
            tick={{ fontSize: 10, fontFamily: "B612 Mono" }}
            tickFormatter={(d: number) => `d${Math.round(d)}`}
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
            labelFormatter={(d) => `day ${Number(d).toFixed(1)}`}
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
