/**
 * ContinuousModel — Aero v3 continuous protocol model.
 *
 * - Revenue streams per second, pro-rata by allocated weight (F10). Weights
 *   are piecewise constant (they change only at allocation / crowd events,
 *   which happen between `advance` calls), so integration over [t, t+dt) is
 *   an exact sum over segments — no numeric integration, all bigint.
 * - Per-position rolling cooldown (default 48h = 172800s, F1/F2). Granularity
 *   is configurable ('position' | 'global') per ARCHITECTURE.md §3 item 1.
 * - Gauge caps (F13/F14): effectiveRate = min(allocatedRate, cap) where
 *   cap = κ × trailingRevenueRate(pool, window); κ default 1.2 — an example
 *   value from the AER FAQ ("e.g., 1.2×"), NOT published-final: PLACEHOLDER.
 *   Caps recalibrate every `capIntervalSec` (default 48h); overage accrues in
 *   a burned counter. Conservation invariant: streamed + burned === emitted.
 * - Optional allocation weight decay (F5): linear, resolved lazily at
 *   allocation events. Default off (fixture paths); on for scenario runs.
 */

import { minBig, mulDiv, sumBig, WAD } from "../math/fixed.js";
import {
  AllocationBlockedError,
  type MarketState,
  type ModelTotals,
  type PoolId,
  type ProtocolModel,
  type RevenueProcess,
  type TargetAllocation,
  type Wad,
} from "./types.js";

/** Default v3 allocation cooldown: 48 hours (F1). */
export const DEFAULT_COOLDOWN_SEC = 172_800;
/** Default cap recalibration interval: 48 hours (F14). */
export const DEFAULT_CAP_INTERVAL_SEC = 172_800;
/** Default κ = 1.2 in Wad. PLACEHOLDER — "e.g." value per F14, re-check at code drop. */
export const DEFAULT_KAPPA_WAD = 1_200_000_000_000_000_000n;

/** Cooldown scope (ARCHITECTURE.md §3 item 1). */
export type CooldownGranularity = "position" | "global";

/** Gauge-cap configuration. */
export interface CapConfig {
  enabled: boolean;
  /** Cap multiplier κ in Wad. Default 1.2e18 (placeholder, F14). */
  kappaWad?: Wad;
  /** Recalibration interval in seconds. Default 172800. */
  intervalSec?: number;
  /** Trailing revenue window used to compute the cap. Default 172800. */
  windowSec?: number;
}

/** Allocation-weight decay configuration (F5). */
export interface DecayConfig {
  enabled: boolean;
  /** Linear decay rate: Wad fraction of weight lost per second. */
  ratePerSecWad: Wad;
}

/** Configuration for `createContinuousModel`. */
export interface ContinuousModelConfig {
  /** Revenue (fees + incentives) process for the pool universe. */
  revenue: RevenueProcess;
  /** Simulation start time (unix seconds). */
  startTime: number;
  /** Rolling allocation cooldown in seconds. Default 172800 (48h). */
  cooldownSec?: number;
  /** Cooldown scope. Default 'position'. */
  cooldownGranularity?: CooldownGranularity;
  /** Global emission rate in Wad per second. Default 0 (emissions off). */
  emissionRatePerSec?: Wad;
  /** Gauge caps. Default disabled. */
  caps?: CapConfig;
  /** Allocation weight decay. Default disabled. */
  decay?: DecayConfig;
}

interface PositionState {
  weight: Wad;
  /** Lazily-resolved effective weight (decay). Equals `weight` when fresh. */
  effectiveWeight: Wad;
  allocation: Map<PoolId, Wad>;
  lastActionAt: number;
  accrued: Wad;
}

function assertValidTarget(pools: readonly PoolId[], target: TargetAllocation): void {
  const known = new Set(pools);
  let sum = 0n;
  for (const [pool, frac] of target) {
    if (!known.has(pool)) throw new Error(`unknown pool in target: ${pool}`);
    if (frac < 0n) throw new Error(`negative target fraction for ${pool}`);
    sum += frac;
  }
  if (sum !== WAD) throw new Error(`target fractions must sum to WAD, got ${sum}`);
}

/** Creates a v3 continuous protocol model. */
export function createContinuousModel(config: ContinuousModelConfig): ProtocolModel {
  const pools = [...config.revenue.pools];
  const revenue = config.revenue;
  const startTime = config.startTime;
  const cooldownSec = config.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
  const granularity = config.cooldownGranularity ?? "position";
  const emissionRate = config.emissionRatePerSec ?? 0n;
  const capsEnabled = config.caps?.enabled ?? false;
  const kappaWad = config.caps?.kappaWad ?? DEFAULT_KAPPA_WAD;
  const capIntervalSec = config.caps?.intervalSec ?? DEFAULT_CAP_INTERVAL_SEC;
  const capWindowSec = config.caps?.windowSec ?? DEFAULT_CAP_INTERVAL_SEC;
  const decayEnabled = config.decay?.enabled ?? false;
  const decayRate = config.decay?.ratePerSecWad ?? 0n;

  let t = startTime;
  let globalLastActionAt = startTime - cooldownSec;
  const positions = new Map<string, PositionState>();
  const crowd = new Map<PoolId, Wad>();
  const capRates = new Map<PoolId, Wad>();
  let capsUpdatedAt = startTime;
  const totals: ModelTotals = {
    emitted: 0n,
    streamed: 0n,
    burned: 0n,
    revenueDust: 0n,
    revenueTotal: 0n,
    crowdRevenue: 0n,
  };

  /** cap_pool = mulWad(κ, trailingRevenue / window) — exact floor semantics. */
  function recalibrateCaps(now: number): void {
    for (const pool of pools) {
      const trailing = revenue.revenueBetween(pool, Math.max(0, now - capWindowSec), now);
      const rate = trailing / BigInt(capWindowSec);
      capRates.set(pool, mulDiv(kappaWad, rate, WAD));
    }
    capsUpdatedAt = now;
  }
  if (capsEnabled) recalibrateCaps(startTime);

  function positionPoolWeight(pos: PositionState, pool: PoolId): Wad {
    const frac = pos.allocation.get(pool) ?? 0n;
    return frac === 0n ? 0n : mulDiv(pos.effectiveWeight, frac, WAD);
  }

  function poolWeight(pool: PoolId): Wad {
    let w = crowd.get(pool) ?? 0n;
    for (const pos of positions.values()) w += positionPoolWeight(pos, pool);
    return w;
  }

  function totalWeight(): Wad {
    return sumBig(pools.map(poolWeight));
  }

  /** Allocated (pre-cap) emission rate for a pool given current weights. */
  function allocatedRate(pool: PoolId, total: Wad): Wad {
    if (emissionRate === 0n || total === 0n) return 0n;
    return mulDiv(emissionRate, poolWeight(pool), total);
  }

  function effectiveRate(pool: PoolId, total: Wad): Wad {
    const alloc = allocatedRate(pool, total);
    if (!capsEnabled) return alloc;
    return minBig(alloc, capRates.get(pool) ?? 0n);
  }

  /** Streams revenue and emissions over [from, to) with constant weights/caps. */
  function streamSegment(from: number, to: number): void {
    if (to <= from) return;
    const seg = BigInt(to - from);
    const total = totalWeight();
    for (const pool of pools) {
      const rev = revenue.revenueBetween(pool, from, to);
      totals.revenueTotal += rev;
      const poolW = poolWeight(pool);
      if (rev > 0n) {
        if (poolW === 0n) {
          totals.revenueDust += rev;
        } else {
          let paid = 0n;
          for (const pos of positions.values()) {
            const w = positionPoolWeight(pos, pool);
            if (w === 0n) continue;
            const payout = mulDiv(rev, w, poolW);
            pos.accrued += payout;
            paid += payout;
          }
          const crowdW = crowd.get(pool) ?? 0n;
          if (crowdW > 0n) {
            const crowdPayout = mulDiv(rev, crowdW, poolW);
            totals.crowdRevenue += crowdPayout;
            paid += crowdPayout;
          }
          totals.revenueDust += rev - paid;
        }
      }
      if (emissionRate > 0n) {
        const alloc = allocatedRate(pool, total);
        const eff = capsEnabled ? minBig(alloc, capRates.get(pool) ?? 0n) : alloc;
        totals.emitted += alloc * seg;
        totals.streamed += eff * seg;
        totals.burned += (alloc - eff) * seg;
      }
    }
  }

  /** Lazily resolves decay for every position at time `now` (idempotent). */
  function resolveDecay(now: number): void {
    if (!decayEnabled) return;
    for (const pos of positions.values()) {
      const elapsed = BigInt(Math.max(0, now - pos.lastActionAt));
      const lost = minBig(WAD, decayRate * elapsed);
      pos.effectiveWeight = pos.weight - mulDiv(pos.weight, lost, WAD);
    }
  }

  function cooldownGate(pos: PositionState, now: number): AllocationBlockedError | null {
    const last = granularity === "global" ? globalLastActionAt : pos.lastActionAt;
    const readyAt = last + cooldownSec;
    if (now < readyAt) return new AllocationBlockedError("CooldownActive", readyAt);
    return null;
  }

  function getPosition(positionId: string): PositionState {
    const pos = positions.get(positionId);
    if (!pos) throw new Error(`unknown position: ${positionId}`);
    return pos;
  }

  function marketState(): MarketState {
    const now = t;
    return {
      now,
      pools,
      trailingRevenue: (pool, windowSec) =>
        revenue.revenueBetween(pool, Math.max(0, now - windowSec), now),
      poolWeight,
      totalWeight,
    };
  }

  return {
    now: () => t,
    marketState,
    advance(dtSec: number): void {
      if (!Number.isInteger(dtSec) || dtSec <= 0) {
        throw new Error(`advance: dtSec must be a positive integer, got ${dtSec}`);
      }
      const end = t + dtSec;
      while (t < end) {
        const nextCap = capsEnabled ? capsUpdatedAt + capIntervalSec : end;
        const segEnd = Math.min(end, nextCap);
        streamSegment(t, segEnd);
        t = segEnd;
        if (capsEnabled && t === nextCap) recalibrateCaps(t);
      }
    },
    addPosition(positionId: string, weight: Wad): void {
      if (positions.has(positionId)) throw new Error(`duplicate position: ${positionId}`);
      if (weight <= 0n) throw new Error(`position weight must be positive: ${weight}`);
      positions.set(positionId, {
        weight,
        effectiveWeight: weight,
        allocation: new Map(),
        lastActionAt: startTime - cooldownSec, // new positions may allocate immediately
        accrued: 0n,
      });
    },
    submitAllocation(positionId: string, target: TargetAllocation): void {
      const pos = getPosition(positionId);
      const gate = cooldownGate(pos, t);
      if (gate) throw gate;
      assertValidTarget(pools, target);
      // F5: decay resolves lazily on state changes; a fresh allocation
      // restores this position to full weight.
      resolveDecay(t);
      pos.allocation = new Map(target);
      pos.lastActionAt = t;
      pos.effectiveWeight = pos.weight;
      globalLastActionAt = t;
    },
    canAllocate: (positionId) => cooldownGate(getPosition(positionId), t) === null,
    nextAllocationTime(positionId: string): number {
      const gate = cooldownGate(getPosition(positionId), t);
      return gate === null ? t : (gate.retryAt ?? t);
    },
    earned: (positionId) => getPosition(positionId).accrued,
    claim(positionId: string): Wad {
      const pos = getPosition(positionId);
      const amount = pos.accrued;
      pos.accrued = 0n;
      return amount;
    },
    setCrowdWeights(weights: ReadonlyMap<PoolId, Wad>): void {
      crowd.clear();
      for (const [pool, w] of weights) {
        if (w < 0n) throw new Error(`negative crowd weight for ${pool}`);
        crowd.set(pool, w);
      }
    },
    emissionShares(): Map<PoolId, Wad> {
      const shares = new Map<PoolId, Wad>();
      const total = totalWeight();
      if (emissionRate === 0n) {
        // Emissions not configured: fall back to weight shares.
        for (const pool of pools) {
          shares.set(pool, total === 0n ? 0n : mulDiv(WAD, poolWeight(pool), total));
        }
        return shares;
      }
      const rates = pools.map((pool) => effectiveRate(pool, total));
      const rateTotal = sumBig(rates);
      pools.forEach((pool, i) => {
        shares.set(pool, rateTotal === 0n ? 0n : mulDiv(WAD, rates[i]!, rateTotal));
      });
      return shares;
    },
    totals: () => ({ ...totals }),
  };
}
