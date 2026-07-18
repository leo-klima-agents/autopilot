/**
 * Shared protocol-model types. Both the v2 EpochModel and the v3
 * ContinuousModel implement `ProtocolModel`, so the scheduler, strategies,
 * backtester and fixture generator are model-agnostic.
 */

/** Pool identifier: an address or a synthetic id. */
export type PoolId = string;

/** 1e18 fixed-point bigint. */
export type Wad = bigint;

/**
 * A target allocation: WAD-denominated fractions per pool summing exactly
 * to WAD (see `normalizeToWad` in ./strategies).
 */
export type TargetAllocation = Map<PoolId, Wad>;

/** Seconds in a protocol week (v2 epoch length). */
export const WEEK = 604_800;
/** Seconds in a day. */
export const DAY = 86_400;
/** Seconds in an hour. */
export const HOUR = 3_600;

/**
 * v2 epoch start for a unix timestamp: `ts - (ts % WEEK)`.
 * The unix epoch began on a Thursday, so this flips at Thursday 00:00 UTC.
 */
export function epochStart(ts: number): number {
  return ts - (ts % WEEK);
}

/** Start of the epoch after the one containing `ts`. */
export function epochNext(ts: number): number {
  return epochStart(ts) + WEEK;
}

/**
 * Revenue source consumed by both models. Implementations MUST be additive
 * on integer-second boundaries: revenueBetween(p,a,b) + revenueBetween(p,b,c)
 * === revenueBetween(p,a,c). Piecewise-constant integer rates guarantee this.
 */
export interface RevenueProcess {
  /** Pools this process produces revenue for. */
  readonly pools: readonly PoolId[];
  /** Exact revenue (Wad) accrued by `pool` over [t0, t1), integer seconds. */
  revenueBetween(pool: PoolId, t0: number, t1: number): Wad;
}

/**
 * Read-only market view handed to strategies at the current simulation time.
 */
export interface MarketState {
  /** Current unix time (integer seconds). */
  readonly now: number;
  /** The pool universe. */
  readonly pools: readonly PoolId[];
  /** Trailing revenue (fees + bribes, Wad) of `pool` over the past `windowSec`. */
  trailingRevenue(pool: PoolId, windowSec: number): Wad;
  /** Total allocated weight currently on `pool` (crowd + our positions). */
  poolWeight(pool: PoolId): Wad;
  /** Global allocated weight across all pools. */
  totalWeight(): Wad;
}

/** Aggregate conservation counters exposed by models. */
export interface ModelTotals {
  /** Total emissions accrued at the allocated (pre-cap) rate. */
  emitted: Wad;
  /** Emissions actually streamed to pools (post-cap). */
  streamed: Wad;
  /** Emissions burned by gauge caps. Invariant: streamed + burned === emitted. */
  burned: Wad;
  /** Revenue rounding dust never distributed to any allocator. */
  revenueDust: Wad;
  /** Total revenue produced by all pools since model start. */
  revenueTotal: Wad;
  /** Revenue credited to the external crowd weight. */
  crowdRevenue: Wad;
}

/** Error thrown when an allocation change is not currently allowed. */
export class AllocationBlockedError extends Error {
  /** Earliest time (unix seconds) the position may allocate, if known. */
  readonly retryAt: number | undefined;
  constructor(message: string, retryAt?: number) {
    super(message);
    this.name = "AllocationBlockedError";
    this.retryAt = retryAt;
  }
}

/**
 * Common protocol-model interface.
 *
 * Lifecycle: construct → addPosition(...) → repeat { setCrowdWeights?,
 * submitAllocation?, advance(dt) } → claim/earned. `advance` streams revenue
 * and emissions from `now()` to `now() + dt`; allocations and crowd changes
 * take effect at the instant they are submitted, so weights are piecewise
 * constant between calls and all integration is exact.
 */
export interface ProtocolModel {
  /** Current model time (unix seconds). */
  now(): number;
  /** Read-only market view at the current time. */
  marketState(): MarketState;
  /** Advances time by `dtSec` integer seconds, streaming revenue/emissions. */
  advance(dtSec: number): void;
  /** Registers an allocator position with `weight` staking weight. */
  addPosition(positionId: string, weight: Wad): void;
  /**
   * Sets the position's allocation to `target` (Wad fractions summing to
   * WAD). Throws AllocationBlockedError when gated (cooldown, epoch rules).
   */
  submitAllocation(positionId: string, target: TargetAllocation): void;
  /** Whether `positionId` may allocate right now. */
  canAllocate(positionId: string): boolean;
  /** Earliest time `positionId` may next allocate. */
  nextAllocationTime(positionId: string): number;
  /** Revenue accrued and not yet claimed by the position. */
  earned(positionId: string): Wad;
  /** Claims accrued revenue; returns the amount and zeroes the accrual. */
  claim(positionId: string): Wad;
  /** Replaces the external (non-portfolio) crowd weight per pool. */
  setCrowdWeights(weights: ReadonlyMap<PoolId, Wad>): void;
  /**
   * Current effective emission share per pool as Wad fractions of the total
   * effective (post-cap) emission rate. Sums to <= WAD (floor rounding).
   */
  emissionShares(): Map<PoolId, Wad>;
  /** Conservation counters. */
  totals(): ModelTotals;
}
