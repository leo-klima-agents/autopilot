/**
 * Water-filling allocator, size-aware marginal-yield equalizer.
 *
 * Maximizes Σ_i w_i·R_i/(W_i + w_i) subject to Σ w_i = budget, w_i >= 0,
 * where R_i is the pool revenue rate, W_i the external (crowd) weight and
 * w_i our allocation. At the optimum the marginal yield
 * R_i·W_i/(W_i + w_i)^2 equals a common λ wherever w_i > 0, giving
 *   w_i(λ) = max(0, isqrt(R_i·W_i·SCALE / λ) − W_i)
 * with λ carried at SCALE = 1e36 precision. Σ w_i(λ) is non-increasing in
 * λ, so we binary-search the smallest integer λ with Σ w_i(λ) <= budget.
 *
 * Iteration bound: exactly bitLength(λ_hi) integer bisection steps, where
 * λ_hi = max_i(R_i·SCALE/W_i) + 1 (the smallest λ that zeroes every pool).
 * With R, W <= 1e30 and SCALE = 1e36 that is <= ~220 iterations; for
 * Wad-scale inputs it is ~128. Fixture-relevant: exact floor semantics
 * throughout, deterministic, replayable in Solidity.
 *
 * Edge cases: pools with R_i·W_i === 0 get w_i = 0 from the formula (a pool
 * with no external weight yields R_i for any ε > 0 of weight, the marginal
 * limit is degenerate, so the closed form assigns nothing). The leftover
 * budget (bisection slack plus degenerate pools) is assigned to the pool
 * with the largest R_i (ties by lowest index), keeping Σ w_i === budget.
 */

import { bitLength, isqrt, sumBig } from "../math/fixed.js";
import type { MarketState, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import {
  portfolioWeightOnPool,
  type ConfigSchema,
  type Portfolio,
  type Strategy,
} from "./types.js";

/** Fixed-point scale for λ in the water-filling bisection. */
export const WATER_FILL_SCALE = 10n ** 36n;

/** Result of the exact water-filling optimization. */
export interface WaterFillResult {
  /** Our optimal weight per pool; sums exactly to `budget`. */
  weights: bigint[];
  /** The equalized marginal yield λ (scaled by `scale`) found by bisection. */
  lambda: bigint;
  /** Number of bisection iterations performed (== bitLength of λ_hi bound). */
  iterations: number;
}

/** w_i(λ) = max(0, isqrt(R_i·W_i·SCALE/λ) − W_i). */
function weightAtLambda(r: bigint, w: bigint, lambda: bigint, scale: bigint): bigint {
  const product = r * w;
  if (product === 0n) return 0n;
  const root = isqrt((product * scale) / lambda);
  return root > w ? root - w : 0n;
}

/**
 * Exact water-filling: allocates `budget` across pools with revenue rates
 * `R` and external weights `W`. Throws on length mismatch or negative
 * inputs. See module docs for the algorithm and edge-case policy.
 */
export function waterFill(
  R: readonly bigint[],
  W: readonly bigint[],
  budget: bigint,
  scale: bigint = WATER_FILL_SCALE,
): WaterFillResult {
  if (R.length !== W.length) throw new Error("waterFill: R/W length mismatch");
  if (budget < 0n) throw new Error("waterFill: negative budget");
  if (scale <= 0n) throw new Error("waterFill: scale must be positive");
  for (let i = 0; i < R.length; i += 1) {
    if (R[i]! < 0n || W[i]! < 0n) throw new Error("waterFill: negative input");
  }
  const n = R.length;
  if (n === 0 || budget === 0n) {
    return { weights: new Array<bigint>(n).fill(0n), lambda: 0n, iterations: 0 };
  }

  // λ_hi: smallest λ making every w_i(λ) zero, w_i(λ)=0 iff R_i·W_i·SCALE/λ <= W_i².
  let hi = 1n;
  for (let i = 0; i < n; i += 1) {
    if (R[i]! > 0n && W[i]! > 0n) {
      const cand = (R[i]! * scale) / W[i]! + 1n;
      if (cand > hi) hi = cand;
    }
  }
  const iterations = bitLength(hi);

  const sumAt = (lambda: bigint): bigint =>
    sumBig(R.map((r, i) => weightAtLambda(r, W[i]!, lambda, scale)));

  // Find smallest integer λ in [1, hi] with Σ w_i(λ) <= budget.
  let lo = 1n;
  let lambda = hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1n;
    if (sumAt(mid) <= budget) {
      hi = mid;
    } else {
      lo = mid + 1n;
    }
  }
  lambda = hi;

  const weights = R.map((r, i) => weightAtLambda(r, W[i]!, lambda, scale));
  let leftover = budget - sumBig(weights);
  if (leftover > 0n) {
    // Deterministic remainder policy: largest R, ties by lowest index.
    let best = 0;
    for (let i = 1; i < n; i += 1) {
      if (R[i]! > R[best]!) best = i;
    }
    weights[best] = weights[best]! + leftover;
    leftover = 0n;
  }
  return { weights, lambda, iterations };
}

/** Configuration for the WaterFilling strategy. */
export interface WaterFillingConfig {
  /** Trailing window (seconds) measuring pool revenue rates. Default 7d. */
  lookbackSec?: number;
  /** Invocation cadence in seconds. Default 48h. */
  cadenceSec?: number;
}

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    lookbackSec: {
      type: "integer",
      description: "Trailing revenue window in seconds used as the R_i signal.",
      default: 604_800,
      minimum: 1,
    },
    cadenceSec: {
      type: "integer",
      description: "How often the strategy re-proposes, in seconds.",
      default: 172_800,
      minimum: 1,
    },
  },
  additionalProperties: false,
};

/** Default WaterFilling config. */
export const waterFillingDefaults = { lookbackSec: 604_800, cadenceSec: 172_800 } as const;

/**
 * WaterFilling strategy: R_i = trailing revenue over `lookbackSec`,
 * W_i = external weight (pool weight minus our own), budget = portfolio
 * total weight; the exact water-filled weights are normalized to Wad
 * fractions (see normalizeToWad).
 */
export function waterFilling(config: WaterFillingConfig = {}): Strategy {
  const cfg = { ...waterFillingDefaults, ...config };
  return {
    name: "WaterFilling",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const R = pools.map((p) => state.trailingRevenue(p, cfg.lookbackSec));
      const W = pools.map((p) => {
        const external = state.poolWeight(p) - portfolioWeightOnPool(portfolio, p);
        return external > 0n ? external : 0n;
      });
      const { weights } = waterFill(R, W, portfolio.totalWeight);
      const scores = new Map<string, Wad>();
      pools.forEach((p, i) => scores.set(p, weights[i]!));
      return normalizeToWad(scores);
    },
  };
}
