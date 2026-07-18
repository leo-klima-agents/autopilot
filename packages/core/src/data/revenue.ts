/**
 * Bridge from the dataset schema to the models' RevenueProcess: each epoch's
 * revenue becomes a piecewise-constant per-second rate over [ts, ts + WEEK),
 * so integration is exact and additive on integer-second boundaries.
 *
 * Epoch revenue is `feesUsd` (Wad USD) when present — the comparable,
 * bigint-exact choice — otherwise the unpriced sum of fee + bribe raw
 * amounts (only meaningful when the dataset uses a single quote token, as
 * synthetic datasets do; documented dataset-quality caveat for sugar data
 * without feesUsd).
 */

import { sumBig } from "../math/fixed.js";
import { WEEK, type PoolId, type RevenueProcess, type Wad } from "../model/types.js";
import { parseAmount, type DatasetV1, type EpochRecord } from "./schema.js";

/** Exact Wad revenue attributed to one epoch record. */
export function epochRevenueWad(epoch: EpochRecord): Wad {
  if (epoch.feesUsd !== undefined) return parseAmount(epoch.feesUsd);
  return (
    sumBig(epoch.fees.map((f) => parseAmount(f.amount))) +
    sumBig(epoch.bribes.map((b) => parseAmount(b.amount)))
  );
}

interface PoolSegments {
  /** Segment starts, ascending (weekly epoch boundaries, non-overlapping). */
  starts: number[];
  /** Segment ends (start + WEEK). */
  ends: number[];
  /** Per-second rate of each segment. */
  rates: Wad[];
  /** cum[i] = exact total revenue of segments 0..i-1 in full. */
  cum: Wad[];
}

/**
 * Exact cumulative revenue up to `t`: full segments before `t` via the
 * prefix sum, plus the partial overlap of the segment containing `t`.
 * O(log segments) by binary search — revenueBetween(t0, t1) = C(t1) − C(t0)
 * is arithmetically identical to the per-segment overlap sum because
 * segments are sorted and non-overlapping, so this is a pure speedup with
 * bit-identical results (the golden and differential suites pin that down).
 */
function cumulativeAt(p: PoolSegments, t: number): Wad {
  const n = p.starts.length;
  // rightmost segment with start <= t (binary search); -1 = before all
  let lo = 0;
  let hi = n - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (p.starts[mid]! <= t) {
      k = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (k < 0) return 0n;
  const within = Math.min(t, p.ends[k]!) - p.starts[k]!;
  return p.cum[k]! + (within > 0 ? p.rates[k]! * BigInt(within) : 0n);
}

/**
 * Builds a RevenueProcess from a dataset. Rates are floor(epochRevenue /
 * WEEK) per second (the sub-1-wei-per-second remainder is dropped, i.e. at
 * most WEEK-1 wei per pool-epoch); outside recorded epochs revenue is zero.
 * Precondition (holds for sugar and synthetic datasets): one epoch per week
 * boundary per pool — segments never overlap.
 */
export function revenueProcessFromDataset(dataset: DatasetV1): RevenueProcess {
  const segments = new Map<PoolId, PoolSegments>();
  for (const pool of dataset.pools) {
    const sorted = [...pool.epochs].sort((a, b) => a.ts - b.ts);
    const p: PoolSegments = { starts: [], ends: [], rates: [], cum: [] };
    let running = 0n;
    for (const epoch of sorted) {
      p.starts.push(epoch.ts);
      p.ends.push(epoch.ts + WEEK);
      const rate = epochRevenueWad(epoch) / BigInt(WEEK);
      p.rates.push(rate);
      p.cum.push(running);
      running += rate * BigInt(WEEK);
    }
    segments.set(pool.address, p);
  }
  const pools = dataset.pools.map((p) => p.address);
  return {
    pools,
    revenueBetween(pool: PoolId, t0: number, t1: number): Wad {
      if (t1 <= t0) return 0n;
      const p = segments.get(pool);
      if (!p || p.starts.length === 0) return 0n;
      return cumulativeAt(p, t1) - cumulativeAt(p, t0);
    },
  };
}
