import type { PoolId, RevenueProcess, Wad } from "../src/model/types.js";

/** Constant per-second revenue rates, the simplest additive RevenueProcess. */
export function constantRevenue(rates: Record<PoolId, Wad>): RevenueProcess {
  return {
    pools: Object.keys(rates),
    revenueBetween: (pool, t0, t1) =>
      t1 > t0 ? (rates[pool] ?? 0n) * BigInt(t1 - t0) : 0n,
  };
}

/** Piecewise-constant rates: list of {from, rate} breakpoints per pool. */
export function steppedRevenue(
  steps: Record<PoolId, { from: number; rate: Wad }[]>,
): RevenueProcess {
  return {
    pools: Object.keys(steps),
    revenueBetween(pool, t0, t1) {
      const poolSteps = steps[pool] ?? [];
      let total = 0n;
      for (let i = 0; i < poolSteps.length; i += 1) {
        const start = poolSteps[i]!.from;
        const end = i + 1 < poolSteps.length ? poolSteps[i + 1]!.from : Number.MAX_SAFE_INTEGER;
        const overlap = Math.min(t1, end) - Math.max(t0, start);
        if (overlap > 0) total += poolSteps[i]!.rate * BigInt(overlap);
      }
      return total;
    },
  };
}

/** A week-aligned start time: Thu 2024-12-26 00:00 UTC. */
export const T0 = 1_735_171_200;
