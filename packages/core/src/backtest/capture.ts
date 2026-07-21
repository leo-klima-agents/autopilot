/**
 * Per-pool captured revenue vs the passive expectation: the single
 * documented definition behind the "captured vs expected" reading. For each
 * pool, `earned` is the strategy's cumulative revenue from that pool at the
 * final sample, and `benchmarkEarned` is what a passive market-cap-weighted
 * portfolio of identical total weight would have earned from the same pool
 * over the same window (AllocationHistory.marketBenchmarkEarned). Their
 * ratio is the capture multiple — the analogue of the published cbBTC
 * early-allocator statistic (earliest allocators realized ≈1.43× the fees
 * a trailing-performance expectation predicted, Sep 2024 – Feb 2025).
 */

import { divWad } from "../math/fixed.js";
import type { PoolId, Wad } from "../model/types.js";
import type { BacktestResult } from "./run.js";

/** One pool's captured-vs-expected reading at the end of a run. */
export interface PoolCapture {
  pool: PoolId;
  /** Strategy cumulative revenue from the pool (raw Wad, final sample). */
  earned: Wad;
  /** Passive same-size portfolio's cumulative revenue from the pool. */
  benchmarkEarned: Wad;
  /** divWad(earned, benchmarkEarned); null when benchmarkEarned is zero
   *  (a pool the market held no weight in has no defined expectation). */
  captureMultipleWad: Wad | null;
}

/** Final per-pool capture readings for a finished backtest, in the
 *  allocation history's pool order. Empty when the run recorded no samples. */
export function poolCaptures(result: BacktestResult): PoolCapture[] {
  const history = result.allocationHistory;
  const earnedRow = history.earned.at(-1);
  const benchRow = history.marketBenchmarkEarned.at(-1);
  if (earnedRow === undefined || benchRow === undefined) return [];
  return history.pools.map((pool, i) => {
    const earned = earnedRow[i] ?? 0n;
    const benchmarkEarned = benchRow[i] ?? 0n;
    return {
      pool,
      earned,
      benchmarkEarned,
      captureMultipleWad: benchmarkEarned === 0n ? null : divWad(earned, benchmarkEarned),
    };
  });
}
