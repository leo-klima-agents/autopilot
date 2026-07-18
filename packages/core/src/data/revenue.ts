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

interface RateSegment {
  start: number;
  end: number;
  ratePerSec: Wad;
}

/**
 * Builds a RevenueProcess from a dataset. Rates are floor(epochRevenue /
 * WEEK) per second (the sub-1-wei-per-second remainder is dropped, i.e. at
 * most WEEK-1 wei per pool-epoch); outside recorded epochs revenue is zero.
 */
export function revenueProcessFromDataset(dataset: DatasetV1): RevenueProcess {
  const segments = new Map<PoolId, RateSegment[]>();
  for (const pool of dataset.pools) {
    const segs = [...pool.epochs]
      .sort((a, b) => a.ts - b.ts)
      .map((epoch) => ({
        start: epoch.ts,
        end: epoch.ts + WEEK,
        ratePerSec: epochRevenueWad(epoch) / BigInt(WEEK),
      }));
    segments.set(pool.address, segs);
  }
  const pools = dataset.pools.map((p) => p.address);
  return {
    pools,
    revenueBetween(pool: PoolId, t0: number, t1: number): Wad {
      if (t1 <= t0) return 0n;
      const segs = segments.get(pool);
      if (!segs) return 0n;
      let total = 0n;
      for (const seg of segs) {
        const overlap = Math.min(t1, seg.end) - Math.max(t0, seg.start);
        if (overlap > 0) total += seg.ratePerSec * BigInt(overlap);
      }
      return total;
    },
  };
}
