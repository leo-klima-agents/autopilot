/**
 * Crowd models: deterministic processes driving the non-portfolio (external)
 * allocation weight in pools, plus an adversarial revenue perturbation.
 * All bigint-exact and seed-free (fully determined by their inputs).
 */

import { splitProportionally } from "../math/split.js";
import type { PoolId, RevenueProcess, Wad } from "./types.js";

/** External crowd weights per pool. */
export type CrowdWeights = Map<PoolId, Wad>;

/** A deterministic crowd-weight process sampled by the simulation loop. */
export interface CrowdModel {
  readonly name: string;
  /** Crowd weight per pool at time `now`. */
  weightsAt(now: number): CrowdWeights;
}

/** A crowd that never moves. */
export function staticCrowd(weights: ReadonlyMap<PoolId, Wad>): CrowdModel {
  const frozen = new Map(weights);
  return {
    name: "static",
    weightsAt: () => new Map(frozen),
  };
}

/** Configuration for `reactiveHerd`. */
export interface ReactiveHerdConfig {
  /** Revenue process the herd is chasing. */
  revenue: RevenueProcess;
  /** Total crowd weight, held constant and re-split every sample. */
  totalWeight: Wad;
  /** Information lag: the herd sees revenue as of (now - lagSeconds). */
  lagSeconds: number;
  /** Trailing window the herd measures revenue over. Default 7 days. */
  windowSec?: number;
}

/**
 * reactiveHerd — reallocates the whole crowd weight proportionally to
 * trailing revenue observed with a lag: score_i = revenue over
 * [now - lag - window, now - lag). Exact proportional split with
 * deterministic remainder (see splitProportionally); uniform when the
 * lagged window has zero revenue everywhere.
 */
export function reactiveHerd(config: ReactiveHerdConfig): CrowdModel {
  const windowSec = config.windowSec ?? 604_800;
  return {
    name: "reactiveHerd",
    weightsAt(now: number): CrowdWeights {
      const to = Math.max(0, now - config.lagSeconds);
      const from = Math.max(0, to - windowSec);
      const scores = new Map<PoolId, Wad>();
      for (const pool of config.revenue.pools) {
        scores.set(pool, config.revenue.revenueBetween(pool, from, to));
      }
      return splitProportionally(config.totalWeight, scores);
    },
  };
}

/** One wash-trading window: extra fake revenue rate over [start, end). */
export interface WashWindow {
  /** Window start (unix seconds, inclusive). */
  start: number;
  /** Window end (unix seconds, exclusive). */
  end: number;
  /** Fake revenue rate added during the window, Wad per second. */
  ratePerSecWad: Wad;
}

/**
 * adversarialWashBait — wraps a revenue process, pumping fake volume/fees
 * into `pool` during the scheduled windows and pulling it outside them.
 * Lag-following crowds (and naive trailing-revenue strategies) chase the
 * bait; the underlying real revenue is unchanged. Exact: fake revenue is
 * rate × overlap seconds per window.
 */
export function adversarialWashBait(
  base: RevenueProcess,
  pool: PoolId,
  schedule: readonly WashWindow[],
): RevenueProcess {
  for (const w of schedule) {
    if (w.end < w.start) throw new Error(`wash window end ${w.end} before start ${w.start}`);
    if (w.ratePerSecWad < 0n) throw new Error("wash window rate must be non-negative");
  }
  return {
    pools: base.pools,
    revenueBetween(p: PoolId, t0: number, t1: number): Wad {
      let rev = base.revenueBetween(p, t0, t1);
      if (p === pool) {
        for (const w of schedule) {
          const overlap = Math.min(t1, w.end) - Math.max(t0, w.start);
          if (overlap > 0) rev += w.ratePerSecWad * BigInt(overlap);
        }
      }
      return rev;
    },
  };
}
