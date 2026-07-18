/** Earned revenue over time: pools × samples, amber intensity = revenue our
 *  portfolio earned from the pool during the sample interval (the earning
 *  rate — cumulative history differenced in-component). The figure at the
 *  right edge of each row is the pool's cumulative total over the whole run.
 *  Same rows, geometry, and time axis as AllocationHeatmap one panel up, so
 *  allocation and payoff line up cell for cell; amber, not phosphor, so the
 *  two maps cannot be confused. Intensity normalizes to the 95th percentile
 *  of nonzero cells: the epoch model pays weekly lump sums ~168× an hourly
 *  stream cell, and max-normalization would black out everything else. */
import type { DisplayResult } from "../lib/serialize.js";
import { timeAxisFor } from "../lib/timeAxis.js";
import { moneyFor } from "../lib/format.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD } from "../lib/chartGeometry.js";
import { useContainerWidth, type HeatmapView } from "./AllocationHeatmap.js";

const ROW_H = 18;
const TICK_ROW_H = 22;

function cellColor(t: number): string {
  if (t <= 0) return "#12171E";
  // panel face → amber (the equity chart's revenue-benchmark color)
  const clamped = Math.min(1, t);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * clamped);
  return `rgb(${mix(18, 232)}, ${mix(23, 180)}, ${mix(30, 79)})`;
}

export function EarningsHeatmap({
  result,
  view = "strategy",
}: {
  result: DisplayResult;
  view?: HeatmapView;
}) {
  const { times, poolNames } = result.allocation;
  const earned =
    view === "market"
      ? result.allocation.marketBenchmarkEarned
      : view === "revenue"
        ? result.allocation.revenueBenchmarkEarned
        : result.allocation.earned;
  const [containerRef, width] = useContainerWidth();
  if (times.length === 0 || poolNames.length === 0 || earned.length === 0) return null;
  const axis = timeAxisFor(result);
  const money = moneyFor(result.revenueUnit);

  const t0 = times[0] ?? result.startTime;
  const tN = times.at(-1) ?? t0;
  const span = Math.max(1, tN - t0);
  const gridLeft = TIME_AXIS_LEFT;
  const gridRight = Math.max(gridLeft + 40, width - TIME_AXIS_RIGHT_PAD);
  const gridW = gridRight - gridLeft;
  const height = poolNames.length * ROW_H + TICK_ROW_H;
  const x = (ts: number) => gridLeft + ((ts - t0) / span) * gridW;

  // per-interval deltas of the cumulative series; cell i keeps the same
  // [tᵢ, tᵢ₊₁) rect placement as the allocation map so columns align
  const deltas = times.map((_, i) =>
    poolNames.map((_, row) => (earned[i]?.[row] ?? 0) - (i > 0 ? (earned[i - 1]?.[row] ?? 0) : 0)),
  );
  const nonzero = deltas
    .flat()
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  const scale = nonzero.length > 0 ? nonzero[Math.floor(0.95 * (nonzero.length - 1))]! : 1;
  const finals = earned.at(-1) ?? [];

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="revenue earned per pool over time">
          {poolNames.map((name, row) => (
            <g key={name} transform={`translate(0 ${row * ROW_H})`}>
              <text className="heatmap-label" x={gridLeft - 8} y={ROW_H / 2 + 3} textAnchor="end">
                {name.length > 24 ? `${name.slice(0, 23)}…` : name}
              </text>
              {times.map((ts, i) => {
                const left = x(ts);
                const right = i + 1 < times.length ? x(times[i + 1]!) : gridRight;
                const d = deltas[i]?.[row] ?? 0;
                return (
                  <rect
                    key={ts}
                    x={left}
                    y={2}
                    width={Math.max(0.5, right - left)}
                    height={ROW_H - 4}
                    fill={cellColor(scale > 0 ? d / scale : 0)}
                  >
                    <title>
                      {name} · {axis.label(ts)} · {money(d, 2)} earned
                    </title>
                  </rect>
                );
              })}
              {/* cumulative row total, overlaid EFIS-readout style so the
                  time axis stays exactly aligned with the panels above */}
              <text
                className="heatmap-label heatmap-total"
                x={gridRight - 4}
                y={ROW_H / 2 + 3}
                textAnchor="end"
                style={{ paintOrder: "stroke", stroke: "#0B0F14", strokeWidth: 3 }}
              >
                {money(finals[row] ?? 0, 0)}
              </text>
            </g>
          ))}
          {/* epoch-flip-aligned time ticks, same positions as the chart above */}
          {axis
            .epochTicks(t0, tN, Math.max(2, Math.min(8, Math.floor(gridW / 118))))
            .map((ts) => (
              <g key={ts}>
                <line x1={x(ts)} x2={x(ts)} y1={0} y2={height - TICK_ROW_H + 4} stroke="#26303B" strokeDasharray="2 4" />
                <text className="heatmap-label" x={x(ts)} y={height - 6} textAnchor="middle">
                  {axis.tick(ts)}
                </text>
              </g>
            ))}
        </svg>
      )}
    </div>
  );
}
