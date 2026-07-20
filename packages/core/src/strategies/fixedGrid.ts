/**
 * FixedGrid strategies: allocate proportionally to trailing revenue over a
 * lookback window, re-proposed on a fixed cadence ("grid"). The weekly
 * variant is the only live-runnable strategy on Aerodrome v2 (one vote per
 * epoch, A4); the shorter grids target the v3 continuous model.
 */

import { HOUR, WEEK } from "../model/types.js";
import type { MarketState, PoolId, TargetAllocation, Wad } from "../model/types.js";
import { normalizeToWad } from "./normalize.js";
import type { ConfigSchema, Portfolio, Strategy } from "./types.js";

/** Configuration for fixedGrid strategies. */
export interface FixedGridConfig {
  /** Trailing revenue window in seconds. Default 7 days. */
  lookbackSec?: number;
  /**
   * Allowlisted pool universe. Defaults to every pool in the market state.
   */
  pools?: readonly PoolId[];
  /**
   * Weekly grid only: submit this many seconds before the epoch flip. Must be
   * within (1h, WEEK-1h) so the vote lands inside the votable window: the first
   * hour is the distribute window (A2) and the last hour is whitelist-only (A3),
   * both of which reject a non-whitelisted vault. Default 7200 (two hours before
   * Thursday 00:00 UTC), a late-but-safe signal.
   */
  submitOffsetSec?: number;
}

/** Default fixedGrid config values. */
export const fixedGridDefaults = { lookbackSec: WEEK, submitOffsetSec: 2 * HOUR } as const;

const configSchema: ConfigSchema = {
  type: "object",
  properties: {
    lookbackSec: {
      type: "integer",
      description: "Trailing revenue window in seconds used as the signal.",
      default: WEEK,
      minimum: 1,
    },
    pools: {
      type: "array",
      description: "Allowlisted pool ids; empty means the full pool universe.",
      items: { type: "string" },
    },
    submitOffsetSec: {
      type: "integer",
      description:
        "Weekly grid only: seconds before the epoch flip at which the target is submitted (must be within the votable window, i.e. > 1h and < WEEK-1h).",
      default: 2 * HOUR,
      minimum: HOUR + 1,
    },
  },
  additionalProperties: false,
};

function proposeTrailing(
  state: MarketState,
  lookbackSec: number,
  allowlist: readonly PoolId[] | undefined,
): TargetAllocation {
  const pools = [...(allowlist && allowlist.length > 0 ? allowlist : state.pools)].sort();
  const scores = new Map<PoolId, Wad>();
  for (const pool of pools) scores.set(pool, state.trailingRevenue(pool, lookbackSec));
  // All-zero trailing revenue normalizes to a uniform allocation.
  return normalizeToWad(scores);
}

/**
 * Factory: a trailing-revenue strategy re-proposed every `intervalSec`.
 * `fixedGrid(WEEK)` phases its grid `submitOffsetSec` before epoch flips;
 * shorter grids run on an unphased grid from the backtest start.
 */
export function fixedGrid(intervalSec: number, config: FixedGridConfig = {}): Strategy {
  if (!Number.isInteger(intervalSec) || intervalSec <= 0) {
    throw new Error(`fixedGrid: intervalSec must be a positive integer, got ${intervalSec}`);
  }
  const cfg = { ...fixedGridDefaults, ...config };
  const weekly = intervalSec === WEEK;
  // The weekly vote fires at epochStart + WEEK - submitOffsetSec; it must land
  // strictly inside the votable window (epochStart+1h, epochStart+WEEK-1h) or
  // the model's distribute-window / last-hour-whitelist gates reject every vote
  // (silently swallowed as blockedSubmissions), so the strategy never votes.
  if (weekly && (cfg.submitOffsetSec <= HOUR || cfg.submitOffsetSec >= WEEK - HOUR)) {
    throw new Error(
      `fixedGridWeekly: submitOffsetSec must be within (${HOUR}, ${WEEK - HOUR}); got ${cfg.submitOffsetSec}`,
    );
  }
  const phaseSec = weekly ? (WEEK - cfg.submitOffsetSec) % WEEK : 0;
  return {
    name: weekly ? "FixedGridWeekly" : `FixedGrid${intervalSec}s`,
    configSchema,
    config: { ...cfg, intervalSec },
    cadenceSec: intervalSec,
    phaseSec,
    propose(state: MarketState, _portfolio: Portfolio): TargetAllocation {
      return proposeTrailing(state, cfg.lookbackSec, cfg.pools);
    },
  };
}

/** Weekly grid, the only live-runnable strategy on v2. */
export function fixedGridWeekly(config: FixedGridConfig = {}): Strategy {
  return fixedGrid(WEEK, config);
}

/** 48-hour grid. */
export function fixedGrid48h(config: FixedGridConfig = {}): Strategy {
  return fixedGrid(172_800, config);
}

/** 24-hour grid. */
export function fixedGrid24h(config: FixedGridConfig = {}): Strategy {
  return fixedGrid(86_400, config);
}

/** 1-hour grid. */
export function fixedGrid1h(config: FixedGridConfig = {}): Strategy {
  return fixedGrid(3_600, config);
}
