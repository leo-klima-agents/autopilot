/**
 * ContinuousGreedy, the latency-race demonstrator for the v3 continuous
 * model. Event-driven: on every tick (cadence configurable down to one Base
 * block, 2s), it computes the exact water-filled ideal and the marginal
 * yields my_i = R_i·W_i·WAD/(W_i + w_i)^2 (Wad, floor). If any tranche is
 * unlocked and the gap between the best pool's marginal yield and the worst
 * held pool's marginal yield exceeds threshold + cost estimate, it emits
 * the water-filled ideal (the scheduler then rotates exactly the unlocked
 * tranches); otherwise it re-affirms the last target.
 */

import { mulDiv, WAD } from "../math/fixed.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import {
  portfolioWeightOnPool,
  type ConfigSchema,
  type Portfolio,
  type Strategy,
} from "./types.js";
import { waterFill } from "./waterFilling.js";

/** Configuration for ContinuousGreedy. */
export interface ContinuousGreedyConfig {
  /** Tick cadence in seconds; down to 2 (one Base block). Default 2. */
  cadenceSec?: number;
  /** Marginal-yield gap (Wad) that must be exceeded to move. Default 0.01. */
  thresholdWad?: Wad;
  /** Estimated per-rotation cost (Wad, same units as the gap). Default 0.001. */
  costWad?: Wad;
  /** Trailing revenue window for R_i, seconds. Default 24h. */
  lookbackSec?: number;
}

/** Default ContinuousGreedy config. */
export const continuousGreedyDefaults = {
  cadenceSec: 2,
  thresholdWad: WAD / 100n,
  costWad: WAD / 1_000n,
  lookbackSec: 86_400,
} as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    cadenceSec: {
      type: "integer",
      description: "Tick cadence in seconds (2 = one Base block).",
      default: 2,
      minimum: 2,
    },
    thresholdWad: {
      type: "string",
      description: "Marginal-yield gap trigger as a Wad decimal string.",
      default: "10000000000000000",
    },
    costWad: {
      type: "string",
      description: "Per-rotation cost estimate as a Wad decimal string.",
      default: "1000000000000000",
    },
    lookbackSec: {
      type: "integer",
      description: "Trailing revenue window in seconds for the R_i signal.",
      default: 86_400,
      minimum: 1,
    },
  },
  additionalProperties: false,
};

/** Marginal yield R·W·WAD/(W+w)^2 in Wad, exact floor; 0 when W + w === 0. */
export function marginalYield(r: Wad, w: Wad, own: Wad): Wad {
  const denom = (w + own) * (w + own);
  if (denom === 0n) return 0n;
  return mulDiv(r * w, WAD, denom);
}

/** ContinuousGreedy strategy factory. */
export function continuousGreedy(config: ContinuousGreedyConfig = {}): Strategy {
  const cfg = { ...continuousGreedyDefaults, ...config };
  let lastTarget: TargetAllocation | null = null;

  return {
    name: "ContinuousGreedy",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, portfolio: Portfolio): TargetAllocation {
      const pools = [...state.pools].sort();
      const R = pools.map((p) => state.trailingRevenue(p, cfg.lookbackSec));
      const ours = pools.map((p) => portfolioWeightOnPool(portfolio, p));
      const W = pools.map((p, i) => {
        const external = state.poolWeight(p) - ours[i]!;
        return external > 0n ? external : 0n;
      });
      const { weights } = waterFill(R, W, portfolio.totalWeight);
      const scores = new Map<PoolId, Wad>();
      pools.forEach((p, i) => scores.set(p, weights[i]!));
      const ideal = normalizeToWad(scores);

      if (lastTarget === null) {
        lastTarget = ideal;
        return ideal;
      }
      const anyUnlocked = portfolio.tranches.some(
        (tr) => state.now >= tr.lastActionAt + portfolio.cooldownSec,
      );
      if (!anyUnlocked) return lastTarget;

      // Gap between the best pool anywhere and the worst pool we hold.
      let best = 0n;
      let worstHeld: Wad | null = null;
      pools.forEach((_, i) => {
        const my = marginalYield(R[i]!, W[i]!, ours[i]!);
        if (my > best) best = my;
        if (ours[i]! > 0n && (worstHeld === null || my < worstHeld)) worstHeld = my;
      });
      const reference = worstHeld ?? 0n;
      const gap = best > reference ? best - reference : 0n;
      if (gap <= cfg.thresholdWad + cfg.costWad) return lastTarget;
      lastTarget = ideal;
      return ideal;
    },
  };
}
