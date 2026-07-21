/** Pure helpers for the per-pool revenue summary (RevenueHistogram) and the
 *  shared row ordering of the pool panels. Display-layer only: operates on
 *  the float grids the worker already ships, no new worker fields needed. */
import type { DisplayResult } from "./serialize.js";

export interface PoolTotals {
  /** End-of-run cumulative revenue the strategy earned per pool. */
  strategy: number[];
  /** Same for the market (weight-proportional) benchmark portfolio. */
  market: number[];
  /** Same for the revenue (foresight) benchmark portfolio. */
  revenue: number[];
}

/** End-of-run cumulative revenue per pool for all three portfolios. */
export function poolTotals(alloc: DisplayResult["allocation"]): PoolTotals {
  const n = alloc.poolNames.length;
  const last = (grid: number[][]) => {
    const row = grid.at(-1) ?? [];
    return Array.from({ length: n }, (_, i) => row[i] ?? 0);
  };
  return {
    strategy: last(alloc.earned),
    market: last(alloc.marketBenchmarkEarned),
    revenue: last(alloc.revenueBenchmarkEarned),
  };
}

/** Row permutation shared by every pool panel: descending by the pool's
 *  largest total across the three portfolios (so a big pool the strategy
 *  missed still sorts high), pool-name tie-break. Stable across the
 *  strategy/market/revenue view toggle by construction. */
export function poolOrderByRevenue(totals: PoolTotals, poolNames: string[]): number[] {
  const key = (i: number) =>
    Math.max(totals.strategy[i] ?? 0, totals.market[i] ?? 0, totals.revenue[i] ?? 0);
  return poolNames
    .map((_, i) => i)
    .sort((a, b) => {
      const d = key(b) - key(a);
      if (d !== 0) return d;
      return (poolNames[a] ?? "").localeCompare(poolNames[b] ?? "");
    });
}

/** A "nice" axis step (1/2/5 × 10ᵏ) covering `max` in at most `ticks` steps. */
export function niceStep(max: number, ticks: number): number {
  if (!(max > 0) || ticks < 1) return 1;
  const raw = max / ticks;
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) {
    if (m * pow >= raw) return m * pow;
  }
  return 10 * pow;
}
