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
