/**
 * EpochModel — Aerodrome v2 weekly-epoch protocol model.
 *
 * - Epochs are 604800s, flipping at Thursday 00:00 UTC (unix % WEEK === 0;
 *   the unix epoch began on a Thursday). Fact A1.
 * - One allocation change per position per epoch, mirroring Voter.sol's
 *   onlyNewEpoch: blocked while epochStart(now) <= lastVoted[position]. A4.
 * - Voting blocked in the first hour of an epoch (distribute window, A2) and
 *   — when `enforceLastHourWhitelist` is set — in the last hour for
 *   non-whitelisted positions (A3).
 * - Votes persist across epochs. Rewards for an epoch (fees + bribes accrued
 *   during it) are distributed as a lump sum at the flip, pro-rata to
 *   end-of-epoch weights: reward_i = mulDiv(poolReward, weight_i,
 *   totalPoolWeight) — floor; undistributed dust is tracked.
 */

import { mulDiv, sumBig, WAD } from "../math/fixed.js";
import {
  AllocationBlockedError,
  epochStart,
  HOUR,
  WEEK,
  type MarketState,
  type ModelTotals,
  type PoolId,
  type ProtocolModel,
  type RevenueProcess,
  type TargetAllocation,
  type Wad,
} from "./types.js";

/** Configuration for `createEpochModel`. */
export interface EpochModelConfig {
  /** Revenue (fees + bribes) process for the pool universe. */
  revenue: RevenueProcess;
  /** Simulation start time (unix seconds). */
  startTime: number;
  /** Enforce the last-hour whitelist gate (A3). Default false. */
  enforceLastHourWhitelist?: boolean;
  /** Position ids exempt from the last-hour gate. */
  whitelistedPositions?: readonly string[];
}

interface PositionState {
  weight: Wad;
  allocation: Map<PoolId, Wad>; // Wad fractions summing to WAD (or empty)
  lastVoted: number; // unix ts of last vote; -1 = never
  accrued: Wad;
  accruedByPool: Map<PoolId, Wad>; // same payouts as accrued — sums exactly
  whitelisted: boolean;
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

/** Creates a v2 weekly-epoch protocol model. */
export function createEpochModel(config: EpochModelConfig): ProtocolModel {
  const pools = [...config.revenue.pools];
  const revenue = config.revenue;
  const startTime = config.startTime;
  const whitelisted = new Set(config.whitelistedPositions ?? []);
  const enforceLastHour = config.enforceLastHourWhitelist ?? false;

  let t = startTime;
  const positions = new Map<string, PositionState>();
  const crowd = new Map<PoolId, Wad>();
  const totals: ModelTotals = {
    emitted: 0n,
    streamed: 0n,
    burned: 0n,
    revenueDust: 0n,
    revenueTotal: 0n,
    crowdRevenue: 0n,
  };
  const revenueByPool = new Map<PoolId, Wad>(); // same increments as revenueTotal

  function positionPoolWeight(pos: PositionState, pool: PoolId): Wad {
    const frac = pos.allocation.get(pool) ?? 0n;
    return frac === 0n ? 0n : mulDiv(pos.weight, frac, WAD);
  }

  function poolWeight(pool: PoolId): Wad {
    let w = crowd.get(pool) ?? 0n;
    for (const pos of positions.values()) w += positionPoolWeight(pos, pool);
    return w;
  }

  function totalWeight(): Wad {
    return sumBig(pools.map(poolWeight));
  }

  /** Blocked-reason for voting at time `now`, or null when votable. */
  function voteGate(pos: PositionState, now: number): AllocationBlockedError | null {
    const es = epochStart(now);
    if (es <= pos.lastVoted) {
      return new AllocationBlockedError("AlreadyVotedOrDeposited", es + WEEK + HOUR);
    }
    if (now < es + HOUR) {
      return new AllocationBlockedError("DistributeWindow", es + HOUR);
    }
    if (enforceLastHour && now >= es + WEEK - HOUR && !pos.whitelisted) {
      return new AllocationBlockedError("NotWhitelistedNFT", es + WEEK + HOUR);
    }
    return null;
  }

  /** Distributes the epoch that ends at `flip` using end-of-epoch weights. */
  function distributeEpoch(flip: number): void {
    const from = Math.max(flip - WEEK, startTime);
    for (const pool of pools) {
      const reward = revenue.revenueBetween(pool, from, flip);
      totals.revenueTotal += reward;
      revenueByPool.set(pool, (revenueByPool.get(pool) ?? 0n) + reward);
      if (reward === 0n) continue;
      const total = poolWeight(pool);
      if (total === 0n) {
        totals.revenueDust += reward;
        continue;
      }
      let paid = 0n;
      for (const pos of positions.values()) {
        const w = positionPoolWeight(pos, pool);
        if (w === 0n) continue;
        const payout = mulDiv(reward, w, total);
        pos.accrued += payout;
        pos.accruedByPool.set(pool, (pos.accruedByPool.get(pool) ?? 0n) + payout);
        paid += payout;
      }
      const crowdW = crowd.get(pool) ?? 0n;
      if (crowdW > 0n) {
        const crowdPayout = mulDiv(reward, crowdW, total);
        totals.crowdRevenue += crowdPayout;
        paid += crowdPayout;
      }
      totals.revenueDust += reward - paid;
    }
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

  function getPosition(positionId: string): PositionState {
    const pos = positions.get(positionId);
    if (!pos) throw new Error(`unknown position: ${positionId}`);
    return pos;
  }

  return {
    now: () => t,
    marketState,
    advance(dtSec: number): void {
      if (!Number.isInteger(dtSec) || dtSec <= 0) {
        throw new Error(`advance: dtSec must be a positive integer, got ${dtSec}`);
      }
      const end = t + dtSec;
      // Flips strictly after t, up to and including end.
      for (let flip = epochStart(t) + WEEK; flip <= end; flip += WEEK) {
        distributeEpoch(flip);
      }
      t = end;
    },
    addPosition(positionId: string, weight: Wad): void {
      if (positions.has(positionId)) throw new Error(`duplicate position: ${positionId}`);
      if (weight <= 0n) throw new Error(`position weight must be positive: ${weight}`);
      positions.set(positionId, {
        weight,
        allocation: new Map(),
        lastVoted: -1,
        accrued: 0n,
        accruedByPool: new Map(),
        whitelisted: whitelisted.has(positionId),
      });
    },
    submitAllocation(positionId: string, target: TargetAllocation): void {
      const pos = getPosition(positionId);
      const gate = voteGate(pos, t);
      if (gate) throw gate;
      assertValidTarget(pools, target);
      pos.allocation = new Map(target);
      pos.lastVoted = t;
    },
    canAllocate: (positionId) => voteGate(getPosition(positionId), t) === null,
    nextAllocationTime(positionId: string): number {
      const gate = voteGate(getPosition(positionId), t);
      return gate === null ? t : (gate.retryAt ?? t);
    },
    earned: (positionId) => getPosition(positionId).accrued,
    earnedByPool: (positionId) => new Map(getPosition(positionId).accruedByPool),
    claim(positionId: string): Wad {
      const pos = getPosition(positionId);
      const amount = pos.accrued;
      pos.accrued = 0n;
      pos.accruedByPool.clear();
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
      // v2 has no gauge caps in this model: emission share == weight share.
      const total = totalWeight();
      const shares = new Map<PoolId, Wad>();
      for (const pool of pools) {
        shares.set(pool, total === 0n ? 0n : mulDiv(WAD, poolWeight(pool), total));
      }
      return shares;
    },
    totals: () => ({ ...totals }),
    revenueByPool: () => new Map(revenueByPool),
  };
}
