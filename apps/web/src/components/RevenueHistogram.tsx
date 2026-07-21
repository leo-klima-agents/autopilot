/** Revenue capture per pool: the end-of-run integral of the EarningsHeatmap
 *  one panel up. Each pool row shows a phosphor bar (revenue the strategy
 *  earned) over an amber bar (what the market benchmark of our size earned)
 *  on a shared linear money scale, plus a cyan command bug at the foresight
 *  (revenue) benchmark's total, the same three hues as the equity chart, so
 *  the three portfolios read the same everywhere. Shares the heatmaps' label
 *  gutter and container width so the whole instrument stack stays aligned;
 *  shows all three portfolios at once, so no ViewToggle. */
import type { DisplayResult } from "../lib/serialize.js";
import { moneyFor, pct } from "../lib/format.js";
import { poolTotals } from "../lib/poolSummary.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD } from "../lib/chartGeometry.js";
import { useContainerWidth } from "./AllocationHeatmap.js";

const ROW_H = 22;
const TICK_ROW_H = 22;
const STRATEGY = "#6FD3A6";
const MARKET = "#E8B44F";
const FORESIGHT = "#6FB8D3";

/** 3–5 "nice" ticks (1/2/5 × 10^k steps) covering [0, max]. */
function moneyTicks(max: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  return ticks;
}

export function RevenueHistogram({
  result,
  order,
}: {
  result: DisplayResult;
  order?: number[] | undefined;
}) {
  const { poolNames } = result.allocation;
  const [containerRef, width] = useContainerWidth();
  if (poolNames.length === 0) return null;
  const totals = poolTotals(result.allocation);
  const rows = order ?? poolNames.map((_, i) => i);
  const money = moneyFor(result.revenueUnit);

  const max = Math.max(...totals.strategy, ...totals.market, ...totals.revenue, 0);
  const gridLeft = TIME_AXIS_LEFT;
  const gridRight = Math.max(gridLeft + 40, width - TIME_AXIS_RIGHT_PAD);
  const gridW = gridRight - gridLeft;
  const height = rows.length * ROW_H + TICK_ROW_H;
  const x = (v: number) => gridLeft + (max > 0 ? (v / max) * gridW : 0);

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="total revenue per pool">
          {moneyTicks(max).map((v) => (
            <g key={v}>
              <line
                x1={x(v)}
                x2={x(v)}
                y1={0}
                y2={height - TICK_ROW_H + 4}
                stroke="#26303B"
                strokeDasharray="2 4"
              />
              <text className="heatmap-label" x={x(v)} y={height - 6} textAnchor="middle">
                {money(v, 0)}
              </text>
            </g>
          ))}
          {rows.map((pool, row) => {
            const name = poolNames[pool] ?? "";
            const strategy = totals.strategy[pool] ?? 0;
            const market = totals.market[pool] ?? 0;
            const revenue = totals.revenue[pool] ?? 0;
            // capture: the fraction of the foresight edge taken on this pool
            const edge = revenue - market;
            const capture = edge > 1e-12 ? ` · captured ${pct((strategy - market) / edge)}` : "";
            return (
              <g key={name} transform={`translate(0 ${row * ROW_H})`}>
                <text className="heatmap-label" x={gridLeft - 8} y={ROW_H / 2 + 4} textAnchor="end">
                  <title>{name}</title>
                  {name.length > 24 ? `${name.slice(0, 23)}…` : name}
                </text>
                <rect x={gridLeft} y={4} width={Math.max(0, x(strategy) - gridLeft)} height={7} fill={STRATEGY} />
                <rect x={gridLeft} y={13} width={Math.max(0, x(market) - gridLeft)} height={5} fill={MARKET} />
                {/* command bug: the foresight benchmark's total on this pool */}
                <line x1={x(revenue)} x2={x(revenue)} y1={2} y2={ROW_H - 2} stroke={FORESIGHT} strokeWidth={2} />
                {/* transparent hit area so the tooltip covers the whole row */}
                <rect x={gridLeft} y={0} width={gridW} height={ROW_H} fill="transparent">
                  <title>
                    {name} · strategy {money(strategy, 0)} · market bench {money(market, 0)} · revenue bench{" "}
                    {money(revenue, 0)}
                    {capture}
                  </title>
                </rect>
                <text
                  className="heatmap-label heatmap-total"
                  x={gridRight - 4}
                  y={ROW_H / 2 + 4}
                  textAnchor="end"
                  style={{ paintOrder: "stroke", stroke: "#0B0F14", strokeWidth: 3 }}
                >
                  {money(strategy, 0)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
