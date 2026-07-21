/**
 * End-of-run per-pool totals for the revenue histogram and the shared row
 * ordering. The allocation series carry CUMULATIVE earned revenue per pool,
 * so the totals are simply the last sample of each series. Pure functions,
 * unit-tested without a DOM.
 */
import type { DisplayResult } from "./serialize.js";

export interface PoolTotals {
  /** Cumulative revenue our strategy earned per pool over the whole run. */
  strategy: number[];
  /** Cumulative revenue the market benchmark earned per pool. */
  market: number[];
  /** Cumulative revenue the foresight (revenue) benchmark earned per pool. */
  revenue: number[];
}

/** Last cumulative row of each earned series (empty-safe: all-zero rows). */
export function poolTotals(alloc: DisplayResult["allocation"]): PoolTotals {
  const n = alloc.poolNames.length;
  const last = (series: number[][]): number[] => {
    const row = series.at(-1);
    return Array.from({ length: n }, (_, i) => row?.[i] ?? 0);
  };
  return {
    strategy: last(alloc.earned),
    market: last(alloc.marketBenchmarkEarned),
    revenue: last(alloc.revenueBenchmarkEarned),
  };
}

/**
 * Row permutation sorting pools by a total, descending, with the pool name
 * as a deterministic tie-break. Returns row indices into the original
 * (dataset) order; the heatmaps and histogram all render through it so rows
 * never jump between panels or portfolio toggles.
 */
export function poolOrderByRevenue(totals: number[], poolNames: string[]): number[] {
  return totals
    .map((total, index) => ({ total, index }))
    .sort(
      (a, b) =>
        b.total - a.total || (poolNames[a.index] ?? "").localeCompare(poolNames[b.index] ?? ""),
    )
    .map((entry) => entry.index);
}
