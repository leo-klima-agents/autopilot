/** Allocation over time: pools × samples, phosphor intensity = portfolio
 *  weight fraction. Plain SVG — wide content scrolls in its own container.
 *  Historical runs label the time edges with real UTC dates. */
import type { DisplayResult } from "../lib/serialize.js";
import { timeAxisFor } from "../lib/timeAxis.js";

const CELL_W = 4;
const ROW_H = 18;
const LABEL_W = 170;
const MAX_COLS = 240;

function cellColor(w: number): string {
  if (w <= 0) return "#12171E";
  // panel face → phosphor ramp
  const t = Math.min(1, w * 1.6);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
  return `rgb(${mix(18, 111)}, ${mix(23, 211)}, ${mix(30, 166)})`;
}

export function AllocationHeatmap({ result }: { result: DisplayResult }) {
  const { times, poolNames, weights } = result.allocation;
  if (times.length === 0 || poolNames.length === 0) return null;
  const axis = timeAxisFor(result);

  // downsample columns for width sanity
  const stride = Math.max(1, Math.ceil(times.length / MAX_COLS));
  const cols: number[] = [];
  for (let i = 0; i < times.length; i += stride) cols.push(i);

  const width = LABEL_W + cols.length * CELL_W;
  const height = poolNames.length * ROW_H + 22;
  const t0 = result.startTime;

  return (
    <div className="heatmap-scroll">
      <svg width={width} height={height} role="img" aria-label="allocation weight per pool over time">
        {poolNames.map((name, row) => (
          <g key={name} transform={`translate(0 ${row * ROW_H})`}>
            <text className="heatmap-label" x={LABEL_W - 8} y={ROW_H / 2 + 3} textAnchor="end">
              {name.length > 24 ? `${name.slice(0, 23)}…` : name}
            </text>
            {cols.map((i, c) => (
              <rect
                key={i}
                x={LABEL_W + c * CELL_W}
                y={2}
                width={CELL_W}
                height={ROW_H - 4}
                fill={cellColor(weights[i]?.[row] ?? 0)}
              >
                <title>
                  {name} · {axis.label(times[i] ?? t0)} · {(100 * (weights[i]?.[row] ?? 0)).toFixed(1)}%
                </title>
              </rect>
            ))}
          </g>
        ))}
        <text className="heatmap-label" x={LABEL_W} y={height - 6}>
          {axis.tick(times[0] ?? t0)}
        </text>
        <text className="heatmap-label" x={width - 4} y={height - 6} textAnchor="end">
          {axis.tick(times[cols.at(-1) ?? 0] ?? t0)}
        </text>
      </svg>
    </div>
  );
}
