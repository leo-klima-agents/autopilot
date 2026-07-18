/**
 * Exact proportional splitting of a bigint total across keyed scores with
 * deterministic remainder distribution. Fixture-relevant: this is the single
 * implementation behind target-allocation normalization and crowd weight
 * assignment, so rounding behavior is identical everywhere.
 */

import { FixedPointError, mulDiv, sumBig } from "./fixed.js";

/**
 * Splits `total` across `scores.keys()` proportionally to their scores,
 * exactly: floor shares via mulDiv, then the remainder (< number of keys)
 * is distributed one unit at a time to entries sorted by (score desc,
 * key asc). When every score is zero the split is uniform with the
 * remainder going to the lexicographically smallest keys.
 *
 * The result values sum exactly to `total`. Throws on an empty map,
 * negative total, or any negative score.
 */
export function splitProportionally(
  total: bigint,
  scores: ReadonlyMap<string, bigint>,
): Map<string, bigint> {
  if (total < 0n) throw new FixedPointError(`splitProportionally: negative total ${total}`);
  if (scores.size === 0) throw new FixedPointError("splitProportionally: empty scores");
  const keys = [...scores.keys()].sort();
  const values = keys.map((k) => {
    const v = scores.get(k)!;
    if (v < 0n) throw new FixedPointError(`splitProportionally: negative score for ${k}`);
    return v;
  });
  const sum = sumBig(values);
  const out = new Map<string, bigint>();

  if (sum === 0n) {
    const n = BigInt(keys.length);
    const base = total / n;
    const rem = total % n;
    keys.forEach((k, i) => out.set(k, base + (BigInt(i) < rem ? 1n : 0n)));
    return out;
  }

  let assigned = 0n;
  keys.forEach((k, i) => {
    const share = mulDiv(total, values[i]!, sum);
    out.set(k, share);
    assigned += share;
  });
  let remainder = total - assigned;
  // remainder < keys.length: each floor loses strictly less than one unit.
  const order = keys
    .map((k, i) => ({ k, v: values[i]! }))
    .sort((a, b) => (a.v === b.v ? (a.k < b.k ? -1 : 1) : a.v > b.v ? -1 : 1));
  for (const { k } of order) {
    if (remainder === 0n) break;
    out.set(k, out.get(k)! + 1n);
    remainder -= 1n;
  }
  return out;
}
