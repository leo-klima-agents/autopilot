/**
 * Target-allocation normalization: exact conversion of arbitrary
 * non-negative scores to Wad fractions summing to exactly WAD, with the
 * remainder distributed deterministically to the largest weights.
 * Fixture-relevant.
 */

import { WAD } from "../math/fixed.js";
import { splitProportionally } from "../math/split.js";
import type { PoolId, TargetAllocation, Wad } from "../model/types.js";

/**
 * Normalizes `scores` to a TargetAllocation summing exactly to WAD.
 * Floor shares via mulDiv(WAD, score, total); the rounding remainder
 * (< pool count) goes one unit at a time to entries sorted by
 * (score desc, poolId asc). All-zero scores yield a uniform allocation.
 * Throws on an empty map or negative scores.
 */
export function normalizeToWad(scores: ReadonlyMap<PoolId, Wad>): TargetAllocation {
  return splitProportionally(WAD, scores);
}

/**
 * The vault's shipped default per-pool weight cap, mirroring
 * `MAX_POOL_WEIGHT_WAD` in contracts/script/Deploy.s.sol (0.5e18). Strategies
 * compute the unconstrained ideal (P1); the submission layer clamps to the
 * vault's guardrail with `clampToMaxPoolWeightWad` so `setTargets` never reverts
 * with `WeightAboveMax`.
 */
export const VAULT_DEFAULT_MAX_POOL_WEIGHT_WAD = 500_000_000_000_000_000n;

/**
 * Clamps a WAD-summing target so no pool exceeds `maxPoolWeightWad`, matching
 * the on-chain `maxPoolWeightWad` guardrail (TargetsFacet). Excess above the cap
 * is redistributed to the remaining pools proportionally to their weight, capping
 * again as needed; the result still sums to exactly WAD (redistribution is exact,
 * so no dust is created or lost). Throws when the cap is infeasible
 * (`maxPoolWeightWad × pools < WAD`, i.e. no distribution can both sum to WAD and
 * respect the cap). A target already within the cap is returned unchanged.
 */
export function clampToMaxPoolWeightWad(
  target: ReadonlyMap<PoolId, Wad>,
  maxPoolWeightWad: Wad,
): TargetAllocation {
  const pools = [...target.keys()].sort();
  const n = pools.length;
  const out = new Map<PoolId, Wad>();
  for (const p of pools) out.set(p, target.get(p) ?? 0n);
  if (n === 0) return out;
  if (maxPoolWeightWad <= 0n) throw new Error("clampToMaxPoolWeightWad: cap must be positive");
  if (maxPoolWeightWad * BigInt(n) < WAD) {
    throw new Error(
      `clampToMaxPoolWeightWad: cap ${maxPoolWeightWad} × ${n} pools < WAD (${WAD}); infeasible`,
    );
  }
  if (pools.every((p) => (out.get(p) ?? 0n) <= maxPoolWeightWad)) return out;

  // Each round caps every over-cap pool (permanently, since a pool sitting exactly
  // at the cap is neither over nor under) and redistributes the freed excess to the
  // strictly-under pools; converges in <= n rounds because feasibility guarantees the
  // under pools have room to absorb the excess.
  for (let round = 0; round <= n; round += 1) {
    let excess = 0n;
    const under: PoolId[] = [];
    for (const p of pools) {
      const wi = out.get(p) ?? 0n;
      if (wi > maxPoolWeightWad) {
        excess += wi - maxPoolWeightWad;
        out.set(p, maxPoolWeightWad);
      } else if (wi < maxPoolWeightWad) {
        under.push(p);
      }
    }
    if (excess === 0n || under.length === 0) break;
    const base = new Map<PoolId, Wad>();
    let baseSum = 0n;
    for (const p of under) {
      const wi = out.get(p) ?? 0n;
      base.set(p, wi);
      baseSum += wi;
    }
    // proportional to current weight (uniform when the under-pools are all zero)
    const add = splitProportionally(
      excess,
      baseSum === 0n ? new Map(under.map((p) => [p, 1n])) : base,
    );
    for (const p of under) out.set(p, (out.get(p) ?? 0n) + (add.get(p) ?? 0n));
  }
  return out;
}
