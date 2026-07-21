/** End-of-run revenue capture per pool: for each pool a phosphor bar (what
 *  the strategy earned) over an amber bar (what the market benchmark earned),
 *  with the revenue/foresight benchmark as a cyan command bug on the same
 *  scale — the same three hues as the equity chart. This panel is the
 *  end-of-run integral of the earnings heat-map one panel up: same rows,
 *  same label gutter, so the whole instrument stack reads as one column. */
import type { DisplayResult } from "../lib/serialize.js";
import { moneyFor } from "../lib/format.js";
import { niceStep, type PoolTotals } from "../lib/poolSummary.js";
import { TIME_AXIS_LEFT, TIME_AXIS_RIGHT_PAD } from "../lib/chartGeometry.js";
import { useContainerWidth } from "./AllocationHeatmap.js";

const ROW_H = 22;
const TICK_ROW_H = 22;

const PHOSPHOR = "#6FD3A6";
const AMBER = "#E8B44F";
const CYAN = "#6FB8D3";

export function RevenueHistogram({
  result,
  totals,
  order,
}: {
  result: DisplayResult;
  totals: PoolTotals;
  order?: number[];
}) {
  const { poolNames } = result.allocation;
  const [containerRef, width] = useContainerWidth();
  if (poolNames.length === 0) return null;
  const money = moneyFor(result.revenueUnit);

  const gridLeft = TIME_AXIS_LEFT;
  const gridRight = Math.max(gridLeft + 40, width - TIME_AXIS_RIGHT_PAD);
  const gridW = gridRight - gridLeft;
  const height = poolNames.length * ROW_H + TICK_ROW_H;

  const max = Math.max(1e-9, ...totals.strategy, ...totals.market, ...totals.revenue);
  const x = (v: number) => gridLeft + (Math.min(v, max) / max) * gridW;

  const step = niceStep(max, Math.max(2, Math.min(5, Math.floor(gridW / 130))));
  const ticks: number[] = [];
  for (let v = step; v <= max; v += step) ticks.push(v);

  return (
    <div ref={containerRef}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="total revenue captured per pool">
          {ticks.map((v) => (
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
          {poolNames.map((_, displayRow) => {
            const row = order?.[displayRow] ?? displayRow;
            const name = poolNames[row]!;
            const strat = totals.strategy[row] ?? 0;
            const market = totals.market[row] ?? 0;
            const revenue = totals.revenue[row] ?? 0;
            return (
              <g key={name} transform={`translate(0 ${displayRow * ROW_H})`}>
                <text className="heatmap-label" x={gridLeft - 8} y={ROW_H / 2 + 3} textAnchor="end">
                  {name.length > 24 ? `${name.slice(0, 23)}…` : name}
                  <title>{name}</title>
                </text>
                <rect x={gridLeft} y={4} width={Math.max(0, x(strat) - gridLeft)} height={7} fill={PHOSPHOR}>
                  <title>
                    {name} · strategy {money(strat, 0)} · market bench {money(market, 0)} · revenue bench{" "}
                    {money(revenue, 0)}
                  </title>
                </rect>
                <rect
                  x={gridLeft}
                  y={13}
                  width={Math.max(0, x(market) - gridLeft)}
                  height={5}
                  fill={AMBER}
                  opacity={0.8}
                >
                  <title>
                    {name} · market bench {money(market, 0)}
                  </title>
                </rect>
                {/* foresight ceiling as an EFIS command bug */}
                <line x1={x(revenue)} x2={x(revenue)} y1={2} y2={ROW_H - 2} stroke={CYAN} strokeWidth={2}>
                  <title>
                    {name} · revenue bench (foresight) {money(revenue, 0)}
                  </title>
                </line>
                <text
                  className="heatmap-label heatmap-total"
                  x={gridRight - 4}
                  y={ROW_H / 2 + 3}
                  textAnchor="end"
                  style={{ paintOrder: "stroke", stroke: "#0B0F14", strokeWidth: 3 }}
                >
                  {money(strat, 0)}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
