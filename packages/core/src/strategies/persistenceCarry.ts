/**
 * PersistenceCarry, persistence-weighted trailing revenue with
 * (s,S)-threshold reallocation.
 *
 * Signal (all bigint-exact, per pool i over `lookbackSec` split into K
 * equal buckets of floor(lookback/K) seconds ending at now):
 *   r_j   = revenue in bucket j                      (j = 0..K-1)
 *   μ     = floor(Σ r_j / K)                         (bucket mean)
 *   MAD   = floor(Σ |r_j − μ| / K)                   (mean absolute deviation)
 *   vol_i = μ === 0 ? WAD : min(WAD, mulDiv(WAD, MAD, μ))
 *   persistence_i = WAD − mulDiv(haircutWad, vol_i, WAD)
 *   score_i = mulDiv(trailingRev_i, persistence_i, WAD)
 * so the haircut is proportional to revenue volatility (dispersion/mean),
 * capped at the full configured haircut for vol >= 100%.
 *
 * (s,S) policy: a new target ("S": move fully to the ideal) is emitted only
 * when the L1 distance between the current ideal and the last submitted
 * target exceeds `sWad`; otherwise the last target is re-affirmed (a no-op
 * for the scheduler). Lock-timing aware: the (s,S) state only updates when
 * at least one tranche is free per the scheduler's cooldown rule, so the
 * threshold is never "spent" while every tranche is locked.
 */

import { minBig, mulDiv, WAD } from "../math/fixed.js";
import { WEEK } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { l1Distance } from "../scheduler/scheduler.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for PersistenceCarry. */
export interface PersistenceCarryConfig {
  /** Trailing signal window in seconds. Default 7 days. */
  lookbackSec?: number;
  /** Number of volatility buckets K. Default 7. */
  buckets?: number;
  /** Max persistence haircut in Wad (applied at 100% volatility). Default 0.5. */
  haircutWad?: Wad;
  /** (s,S) trigger: minimum L1 distance (Wad) before a new target. Default 0.05. */
  sWad?: Wad;
  /** Invocation cadence in seconds. Default 6h. */
  cadenceSec?: number;
  /** Allowlisted pools; default full universe. */
  pools?: readonly PoolId[];
}

/** Default PersistenceCarry config. */
export const persistenceCarryDefaults = {
  lookbackSec: WEEK,
  buckets: 7,
  haircutWad: WAD / 2n,
  sWad: WAD / 20n,
  cadenceSec: 6 * 3_600,
} as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    lookbackSec: {
      type: "integer",
      description: "Trailing signal window in seconds.",
      default: WEEK,
      minimum: 1,
    },
    buckets: {
      type: "integer",
      description: "Number of equal sub-windows used for the volatility estimate.",
      default: 7,
      minimum: 2,
    },
    haircutWad: {
      type: "string",
      description: "Maximum persistence haircut as a Wad decimal string (1e18 = 100%).",
      default: "500000000000000000",
    },
    sWad: {
      type: "string",
      description: "(s,S) trigger: minimum L1 target distance (Wad decimal string).",
      default: "50000000000000000",
    },
    cadenceSec: {
      type: "integer",
      description: "How often the strategy re-evaluates, in seconds.",
      default: 21_600,
      minimum: 1,
    },
    pools: {
      type: "array",
      description: "Allowlisted pool ids; empty means the full pool universe.",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};

/** Exact persistence factor in Wad for one pool. Exported for tests. */
export function persistenceFactor(
  bucketRevenues: readonly Wad[],
  haircutWad: Wad,
): Wad {
  const k = BigInt(bucketRevenues.length);
  if (k === 0n) return WAD;
  let sum = 0n;
  for (const r of bucketRevenues) sum += r;
  const mean = sum / k;
  if (mean === 0n) return WAD - mulDiv(haircutWad, WAD, WAD); // vol treated as 100%
  let dev = 0n;
  for (const r of bucketRevenues) dev += r >= mean ? r - mean : mean - r;
  const mad = dev / k;
  const vol = minBig(WAD, mulDiv(WAD, mad, mean));
  return WAD - mulDiv(haircutWad, vol, WAD);
}

/** PersistenceCarry strategy factory (holds its (s,S) memory in closure). */
export function persistenceCarry(config: PersistenceCarryConfig = {}): Strategy {
  const cfg = { ...persistenceCarryDefaults, ...config };
  const bucketSec = Math.floor(cfg.lookbackSec / cfg.buckets);
  if (bucketSec < 1) throw new Error("persistenceCarry: lookbackSec/buckets must be >= 1s");
  let lastTarget: TargetAllocation | null = null;

  return {
    name: "PersistenceCarry",
    configSchema,
    config: cfg,
    cadenceSec: cfg.cadenceSec,
    phaseSec: 0,
    propose(state: MarketState, portfolio: Portfolio): TargetAllocation {
      const pools = [
        ...(cfg.pools && cfg.pools.length > 0 ? cfg.pools : state.pools),
      ].sort();
      const scores = new Map<PoolId, Wad>();
      for (const pool of pools) {
        const trailing = state.trailingRevenue(pool, cfg.lookbackSec);
        // Bucket j covers the window (j+1)·bucketSec .. j·bucketSec ago.
        const buckets: Wad[] = [];
        for (let j = 0; j < cfg.buckets; j += 1) {
          const upper = state.trailingRevenue(pool, (j + 1) * bucketSec);
          const lower = state.trailingRevenue(pool, j * bucketSec);
          buckets.push(upper - lower);
        }
        const persistence = persistenceFactor(buckets, cfg.haircutWad);
        scores.set(pool, mulDiv(trailing, persistence, WAD));
      }
      const ideal = normalizeToWad(scores);

      const anyTrancheFree = portfolio.tranches.some(
        (tr) => state.now >= tr.lastActionAt + portfolio.cooldownSec,
      );
      if (lastTarget === null) {
        lastTarget = ideal;
        return ideal;
      }
      if (!anyTrancheFree) return lastTarget;
      if (l1Distance(ideal, lastTarget) <= cfg.sWad) return lastTarget;
      lastTarget = ideal;
      return ideal;
    },
  };
}
