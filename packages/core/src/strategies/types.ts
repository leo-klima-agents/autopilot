/**
 * Strategy interface. Strategies are pure-ish proposal engines: given the
 * market state and the portfolio, they return a target allocation (Wad
 * fractions summing exactly to WAD). Stateful strategies (e.g. (s,S)
 * thresholding) keep their memory in the instance closure, so a fresh
 * instance always replays identically.
 */

import { mulDiv, WAD } from "../math/fixed.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import type { TrancheState } from "../scheduler/scheduler.js";

/** Hand-rolled JSON-schema property (no zod, consumed by the web UI). */
export interface ConfigSchemaProperty {
  type: "number" | "integer" | "string" | "boolean" | "array";
  description: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
  items?: { type: string };
}

/** Hand-rolled JSON-schema object describing a strategy's config. */
export interface ConfigSchema {
  type: "object";
  properties: Record<string, ConfigSchemaProperty>;
  required?: readonly string[];
  additionalProperties: boolean;
}

/** The portfolio a strategy allocates for. */
export interface Portfolio {
  /** Tranche states (1:1 with protocol positions). */
  tranches: readonly TrancheState[];
  /** Total staking weight across tranches. */
  totalWeight: Wad;
  /** Cooldown the scheduler enforces per tranche, seconds. */
  cooldownSec: number;
}

/** A target-allocation strategy. */
export interface Strategy {
  readonly name: string;
  /** JSON schema for the config object (rendered as a form by the web UI). */
  readonly configSchema: ConfigSchema;
  /** Effective config after defaults were applied. */
  readonly config: Readonly<Record<string, unknown>>;
  /** How often the backtester/keeper should invoke `propose`, seconds. */
  readonly cadenceSec: number;
  /**
   * Phase offset for the invocation grid: propose fires at times where
   * (t - phaseSec) % cadenceSec === 0. Lets weekly strategies submit late
   * in the epoch (submitOffsetSec before the flip).
   */
  readonly phaseSec: number;
  /** Proposes a target allocation for the current time. */
  propose(state: MarketState, portfolio: Portfolio): TargetAllocation;
}

/** Sums our portfolio's current weight on `pool` across tranches. */
export function portfolioWeightOnPool(portfolio: Portfolio, pool: PoolId): Wad {
  let w = 0n;
  for (const tranche of portfolio.tranches) {
    const frac = tranche.allocation.get(pool) ?? 0n;
    if (frac > 0n) w += mulDiv(tranche.positionWeight, frac, WAD);
  }
  return w;
}
