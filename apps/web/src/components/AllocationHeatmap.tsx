/** Allocation over time: pools × samples, phosphor intensity = portfolio
 *  weight fraction. The cell grid spans the exact horizontal range of the
 *  equity chart's plot area (shared geometry in lib/chartGeometry), so a date
 *  here sits on the same vertical line as the same date up in the chart.
 *  Historical runs label the time ticks with real UTC dates. */
import { useEffect, useRef, useState } from "react";
import type { DisplayResult } from "../lib/serialize.js";
import { timeAxisFor } from "../lib/timeAxis.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD } from "../lib/chartGeometry.js";
import { pct } from "../lib/format.js";

const ROW_H = 18;
const TICK_ROW_H = 22;

/** Which portfolio the heat-maps display: ours, the market benchmark's
 *  (weight-proportional), or the revenue benchmark's (foresight,
 *  revenue-proportional). Shared by both maps and the App-level toggle. */
export type HeatmapView = "strategy" | "market" | "revenue";

function cellColor(w: number): string {
  if (w <= 0) return "#12171E";
  // panel face → phosphor ramp
  const t = Math.min(1, w * 1.6);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(18, 111)}, ${mix(23, 211)}, ${mix(30, 166)})`;
}

/** Container width via ResizeObserver, the heat-map stretches like the chart.
 *  Shared with EarningsHeatmap. */
export function useContainerWidth(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.floor(w));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

export function AllocationHeatmap({
  result,
  view = "strategy",
  order,
}: {
  result: DisplayResult;
  view?: HeatmapView;
  /** Row permutation (indices into dataset order); identity when omitted.
   *  Shared with EarningsHeatmap/RevenueHistogram so rows line up. */
  order?: number[] | undefined;
}) {
  const { times, poolNames } = result.allocation;
  const weights =
    view === "market"
      ? result.allocation.marketBenchmarkWeights
      : view === "revenue"
        ? result.allocation.revenueBenchmarkWeights
        : result.allocation.weights;
  const [containerRef, width] = useContainerWidth();
  if (times.length === 0 || poolNames.length === 0) return null;
  const rows = order ?? poolNames.map((_, i) => i);
  const axis = timeAxisFor(result);

  const t0 = times[0] ?? result.startTime;
  const tN = times.at(-1) ?? t0;
  const span = Math.max(1, tN - t0);
  const gridLeft = TIME_AXIS_LEFT;
  const gridRight = Math.max(gridLeft + 40, width - TIME_AXIS_RIGHT_PAD);
  const gridW = gridRight - gridLeft;
  const height = poolNames.length * ROW_H + TICK_ROW_H;

  // identical time→x mapping to the chart's linear scale over [t0, tN]
  const x = (ts: number) => gridLeft + ((ts - t0) / span) * gridW;

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="allocation weight per pool over time">
          {rows.map((pool, row) => {
            const name = poolNames[pool] ?? "";
            return (
              <g key={name} transform={`translate(0 ${row * ROW_H})`}>
                <text className="heatmap-label" x={gridLeft - 8} y={ROW_H / 2 + 3} textAnchor="end">
                  <title>{name}</title>
                  {name.length > 24 ? `${name.slice(0, 23)}…` : name}
                </text>
                {times.map((ts, i) => {
                  // a cell covers [tᵢ, tᵢ₊₁), allocation holds between samples
                  const left = x(ts);
                  const right = i + 1 < times.length ? x(times[i + 1]!) : gridRight;
                  return (
                    <rect
                      key={ts}
                      x={left}
                      y={2}
                      width={Math.max(0.5, right - left)}
                      height={ROW_H - 4}
                      fill={cellColor(weights[i]?.[pool] ?? 0)}
                    >
                      <title>
                        {name} · {axis.label(ts)} · {pct(weights[i]?.[pool] ?? 0)}
                      </title>
                    </rect>
                  );
                })}
              </g>
            );
          })}
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
