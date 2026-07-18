/**
 * Backtester: steps a protocol model, invokes a strategy at its cadence,
 * routes actions through the scheduler, and produces exact (bigint) return
 * metrics plus the published on-target methodology (ARCHITECTURE.md F21).
 *
 * The dataset is consumed at model-construction time (the model owns its
 * RevenueProcess), so `runBacktest(strategy, model, config)` takes the model
 * directly. All accounting is bigint; the only floats are the final
 * on/off-target percentages (analytics, marked below).
 */

import { divWad, mulDiv, WAD } from "../math/fixed.js";
import { WEEK } from "../model/types.js";
import type { CrowdModel } from "../model/crowd.js";
import {
  AllocationBlockedError,
  type ProtocolModel,
  type TargetAllocation,
  type Wad,
} from "../model/types.js";
import type { PoolId } from "../model/types.js";
import { DEFAULT_COOLDOWN_SEC } from "../model/continuous.js";
import {
  applyRotation,
  l1Distance,
  plan,
  type TrancheState,
} from "../scheduler/scheduler.js";
import { normalizeToWad } from "../strategies/normalize.js";
import type { Portfolio, Strategy } from "../strategies/types.js";

/** Backtest configuration. */
export interface BacktestConfig {
  /** Simulation start (unix seconds). Must match the model's startTime. */
  startTime: number;
  /** Total simulated duration in seconds. */
  durationSec: number;
  /** Simulation step in seconds. Strategy cadence should be a multiple. */
  stepSec: number;
  /** Number of tranches (1:1 with model positions). */
  trancheCount: number;
  /** Staking weight per tranche. */
  trancheWeight: Wad;
  /** Cooldown the scheduler plans around, seconds. Default 172800. */
  cooldownSec?: number;
  /** Equity/on-target sampling interval, seconds. Default stepSec. */
  sampleIntervalSec?: number;
  /** Optional crowd model driving external weights. */
  crowd?: CrowdModel;
  /** How often crowd weights refresh, seconds. Default stepSec. */
  crowdUpdateSec?: number;
  /** On-target tolerance in Wad (2pp per F21). Default 0.02e18. */
  onTargetToleranceWad?: Wad;
  /** Off-target tolerance in Wad (5pp per F21). Default 0.05e18. */
  offTargetToleranceWad?: Wad;
  /** Trailing window defining the revenue-optimal share, seconds. Default 24h. */
  optimalWindowSec?: number;
}

/** Our portfolio's allocation share and earned revenue per pool over time
 *  (for the heat-maps). */
export interface AllocationHistory {
  times: number[];
  pools: PoolId[];
  /** weights[sampleIndex][poolIndex]: portfolio Wad fraction on the pool. */
  weights: Wad[][];
  /** earned[sampleIndex][poolIndex]: cumulative revenue (raw Wad, NOT per
   *  unit weight) earned from the pool across all tranches. Each row sums
   *  exactly to Σ model.earned(tranche) at that sample. */
  earned: Wad[][];
  /** benchmarkWeights[sampleIndex][poolIndex]: the pool's Wad share of the
   *  GLOBAL weight — the market portfolio the passive benchmark holds. */
  benchmarkWeights: Wad[][];
  /** benchmarkEarned[sampleIndex][poolIndex]: cumulative revenue a passive
   *  market-cap-weighted portfolio of our size (portfolioWeight) would have
   *  earned from the pool, accrued per step as
   *  mulDiv(poolRevenueDelta, portfolioWeight, globalWeight) — the per-pool
   *  twin of the equity chart's passive benchmark (same timing, floor per
   *  pool instead of on the aggregate). */
  benchmarkEarned: Wad[][];
  /** revenueBenchmarkWeights[sampleIndex][poolIndex]: the FORESIGHT (oracle)
   *  benchmark's portfolio fractions — each weekly epoch it holds pools in
   *  proportion to that epoch's TOTAL per-pool revenue. Not investable
   *  (weights need the epoch's realized revenue); an upper reference. */
  revenueBenchmarkWeights: Wad[][];
  /** revenueBenchmarkEarned[sampleIndex][poolIndex]: cumulative revenue the
   *  oracle portfolio earns. Its weight DISPLACES ours: per step and pool,
   *  mulDiv(poolRevenueDelta, oracleWeight, poolWeightExcludingUs +
   *  oracleWeight). The final partial epoch uses revenue-to-date shares. */
  revenueBenchmarkEarned: Wad[][];
}

/** Equity curve time series for the web app (bigint arrays + times). */
export interface EquityCurve {
  times: number[];
  /** Cumulative portfolio return per unit weight, Wad. */
  equity: Wad[];
  /** Cumulative passive benchmark return per unit weight, Wad. */
  benchmark: Wad[];
  /** Cumulative revenue-proportional (foresight) benchmark return per unit
   *  weight, Wad. */
  revenueBenchmark: Wad[];
}

/** Backtest result metrics. */
export interface BacktestResult {
  /** Cumulative revenue earned per unit of portfolio weight, Wad. */
  totalReturn: Wad;
  /** Passive benchmark: global revenue per unit of global weight, Wad. */
  passiveReturn: Wad;
  /** Revenue-proportional (foresight) benchmark return per unit weight, Wad.
   *  The ceiling reference: capture = (totalReturn - passiveReturn) /
   *  (revenueBenchmarkReturn - passiveReturn). */
  revenueBenchmarkReturn: Wad;
  /** totalReturn - passiveReturn (signed). */
  returnVsPassive: bigint;
  /** Max peak-to-trough drawdown of (equity - benchmark), Wad. */
  maxDrawdownVsBenchmark: bigint;
  /** Σ L1(Δallocation)/2 per executed rotation, Wad fractions, cumulated. */
  turnover: Wad;
  /** Number of executed rotations. */
  rotations: number;
  /** Rotations refused by the model (cooldown/epoch gates). */
  blockedSubmissions: number;
  /** Fraction of (pool, sample) points within 2pp of the revenue-optimal share. */
  onTargetPct: number;
  /** Fraction of (pool, sample) points more than 5pp off. */
  offTargetPct: number;
  /** Number of (pool, sample) points measured. */
  poolSamples: number;
  /** Equity curve series. */
  equityCurve: EquityCurve;
  /** Allocation share per pool at each sample (for the heat-map). */
  allocationHistory: AllocationHistory;
}

/**
 * Runs `strategy` against `model`. The model must be freshly constructed at
 * `config.startTime` with no positions registered — the backtester creates
 * one position per tranche. Strategy invocation times follow the strategy's
 * (cadenceSec, phaseSec) grid on absolute unix time, plus one bootstrap
 * invocation at startTime.
 */
export function runBacktest(
  strategy: Strategy,
  model: ProtocolModel,
  config: BacktestConfig,
): BacktestResult {
  const {
    startTime,
    durationSec,
    stepSec,
    trancheCount,
    trancheWeight,
  } = config;
  if (stepSec <= 0 || !Number.isInteger(stepSec)) throw new Error("stepSec must be a positive integer");
  if (durationSec % stepSec !== 0) throw new Error("durationSec must be a multiple of stepSec");
  const cooldownSec = config.cooldownSec ?? DEFAULT_COOLDOWN_SEC;
  const sampleIntervalSec = config.sampleIntervalSec ?? stepSec;
  const crowdUpdateSec = config.crowdUpdateSec ?? stepSec;
  const onTol = config.onTargetToleranceWad ?? WAD / 50n; // 2pp
  const offTol = config.offTargetToleranceWad ?? WAD / 20n; // 5pp
  const optimalWindowSec = config.optimalWindowSec ?? 86_400;

  let tranches: TrancheState[] = [];
  for (let i = 0; i < trancheCount; i += 1) {
    const id = `tranche-${String(i).padStart(2, "0")}`;
    tranches.push({
      id,
      positionWeight: trancheWeight,
      lastActionAt: startTime - cooldownSec,
      allocation: new Map(),
    });
    model.addPosition(id, trancheWeight);
  }
  const portfolioWeight = trancheWeight * BigInt(trancheCount);

  const portfolio = (): Portfolio => ({
    tranches,
    totalWeight: portfolioWeight,
    cooldownSec,
  });

  let turnover = 0n;
  let rotations = 0;
  let blockedSubmissions = 0;
  let benchmark = 0n;
  let prevRevenueTotal = 0n;
  let onCount = 0;
  let offCount = 0;
  let poolSamples = 0;
  const times: number[] = [];
  const equitySeries: Wad[] = [];
  const benchmarkSeries: Wad[] = [];
  const allocPools = [...model.marketState().pools];
  const allocWeights: Wad[][] = [];
  const allocEarned: Wad[][] = [];
  const benchWeights: Wad[][] = [];
  const benchEarned: Wad[][] = [];
  const passiveEarned = new Map<string, Wad>();
  let prevRevByPool: ReadonlyMap<string, Wad> = new Map();

  // -- revenue-proportional (oracle) benchmark --------------------------------
  // Weights fix per weekly epoch, proportional to that epoch's TOTAL per-pool
  // revenue — knowable only at the flip. Steps buffer their (revenue delta,
  // pool weight excluding our tranches) pairs; samples taken inside an open
  // epoch are back-filled when it closes. Run end closes the partial epoch
  // with revenue-to-date shares.
  const oracleEarnedCum: Wad[] = allocPools.map(() => 0n);
  const oracleWeights: Wad[][] = [];
  const oracleEarned: Wad[][] = [];
  const oracleEquity: Wad[] = [];
  let epochStepDeltas: Wad[][] = [];
  let epochStepWeightsExUs: Wad[][] = [];
  let epochRevenue: Wad[] = allocPools.map(() => 0n);
  let pendingOracleSamples: { row: number; steps: number }[] = [];

  const closeOracleEpoch = (): void => {
    let totalRev = 0n;
    for (const rev of epochRevenue) totalRev += rev;
    const oracleW = allocPools.map((_, p) =>
      totalRev === 0n ? 0n : mulDiv(portfolioWeight, epochRevenue[p]!, totalRev),
    );
    const shares = allocPools.map((_, p) =>
      totalRev === 0n ? 0n : mulDiv(WAD, epochRevenue[p]!, totalRev),
    );
    const cumInEpoch = allocPools.map(() => 0n);
    const fillRow = (row: number): void => {
      oracleWeights[row] = shares;
      oracleEarned[row] = allocPools.map((_, p) => oracleEarnedCum[p]! + cumInEpoch[p]!);
      let sum = 0n;
      for (let p = 0; p < allocPools.length; p += 1) sum += oracleEarnedCum[p]! + cumInEpoch[p]!;
      oracleEquity[row] = divWad(sum, portfolioWeight);
    };
    let pi = 0;
    while (pi < pendingOracleSamples.length && pendingOracleSamples[pi]!.steps === 0) {
      fillRow(pendingOracleSamples[pi]!.row);
      pi += 1;
    }
    for (let s = 0; s < epochStepDeltas.length; s += 1) {
      const deltas = epochStepDeltas[s]!;
      const exUs = epochStepWeightsExUs[s]!;
      for (let p = 0; p < allocPools.length; p += 1) {
        const delta = deltas[p]!;
        const w = oracleW[p]!;
        if (delta <= 0n || w === 0n) continue;
        cumInEpoch[p] = cumInEpoch[p]! + mulDiv(delta, w, exUs[p]! + w);
      }
      while (pi < pendingOracleSamples.length && pendingOracleSamples[pi]!.steps === s + 1) {
        fillRow(pendingOracleSamples[pi]!.row);
        pi += 1;
      }
    }
    for (let p = 0; p < allocPools.length; p += 1) {
      oracleEarnedCum[p] = oracleEarnedCum[p]! + cumInEpoch[p]!;
    }
    epochStepDeltas = [];
    epochStepWeightsExUs = [];
    epochRevenue = allocPools.map(() => 0n);
    pendingOracleSamples = [];
  };
  let peak = 0n;
  let maxDrawdown = 0n;

  const strategyDue = (t: number): boolean =>
    ((t - strategy.phaseSec) % strategy.cadenceSec + strategy.cadenceSec) %
      strategy.cadenceSec === 0;

  const portfolioEquity = (): Wad => {
    let earned = 0n;
    for (const tranche of tranches) earned += model.earned(tranche.id);
    return divWad(earned, portfolioWeight);
  };

  const sample = (t: number): void => {
    const equity = portfolioEquity();
    times.push(t);
    equitySeries.push(equity);
    benchmarkSeries.push(benchmark);
    allocWeights.push(
      allocPools.map((pool) => {
        let onPool = 0n;
        for (const tranche of tranches) {
          const frac = tranche.allocation.get(pool) ?? 0n;
          if (frac > 0n) onPool += mulDiv(tranche.positionWeight, frac, WAD);
        }
        return portfolioWeight === 0n ? 0n : divWad(onPool, portfolioWeight);
      }),
    );
    const earnedNow = new Map<string, Wad>();
    for (const tranche of tranches) {
      for (const [pool, amount] of model.earnedByPool(tranche.id)) {
        earnedNow.set(pool, (earnedNow.get(pool) ?? 0n) + amount);
      }
    }
    allocEarned.push(allocPools.map((pool) => earnedNow.get(pool) ?? 0n));
    const market = model.marketState();
    const totalW = market.totalWeight();
    benchWeights.push(
      allocPools.map((pool) => (totalW === 0n ? 0n : divWad(market.poolWeight(pool), totalW))),
    );
    benchEarned.push(allocPools.map((pool) => passiveEarned.get(pool) ?? 0n));
    // oracle rows are back-filled when the epoch's revenue shares are known
    oracleWeights.push([]);
    oracleEarned.push([]);
    oracleEquity.push(0n);
    pendingOracleSamples.push({ row: oracleEarned.length - 1, steps: epochStepDeltas.length });
    const rel = equity - benchmark;
    if (rel > peak) peak = rel;
    const drawdown = peak - rel;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;

    const state = model.marketState();
    const trailing = new Map<string, Wad>();
    let anyRevenue = false;
    for (const pool of state.pools) {
      const rev = state.trailingRevenue(pool, optimalWindowSec);
      trailing.set(pool, rev);
      if (rev > 0n) anyRevenue = true;
    }
    if (!anyRevenue) return; // optimal share undefined without revenue
    const optimal = normalizeToWad(trailing);
    const shares = model.emissionShares();
    for (const pool of state.pools) {
      const diff = (shares.get(pool) ?? 0n) - (optimal.get(pool) ?? 0n);
      const abs = diff < 0n ? -diff : diff;
      poolSamples += 1;
      if (abs <= onTol) onCount += 1;
      if (abs > offTol) offCount += 1;
    }
  };

  const executeTarget = (target: TargetAllocation, t: number): void => {
    const actions = plan(tranches, target, t, cooldownSec);
    for (const action of actions) {
      if (action.kind !== "rotate") continue;
      const idx = tranches.findIndex((tr) => tr.id === action.trancheId);
      const tranche = tranches[idx]!;
      try {
        model.submitAllocation(tranche.id, action.allocation);
      } catch (err) {
        if (err instanceof AllocationBlockedError) {
          blockedSubmissions += 1;
          continue;
        }
        throw err;
      }
      turnover += l1Distance(tranche.allocation, action.allocation) / 2n;
      rotations += 1;
      tranches = tranches.with(idx, applyRotation(tranche, action.allocation, t));
    }
  };

  const end = startTime + durationSec;
  for (let t = startTime; t < end; t += stepSec) {
    if (config.crowd && (t - startTime) % crowdUpdateSec === 0) {
      model.setCrowdWeights(config.crowd.weightsAt(t));
    }
    if (t === startTime || strategyDue(t)) {
      const target = strategy.propose(model.marketState(), portfolio());
      executeTarget(target, t);
    }
    const marketBefore = model.marketState();
    const globalWeight = marketBefore.totalWeight();
    // pool weight minus our tranches at step start — the oracle benchmark's
    // weight displaces ours in the denominator
    const weightsExUs = allocPools.map((pool) => {
      let ours = 0n;
      for (const tranche of tranches) {
        const frac = tranche.allocation.get(pool) ?? 0n;
        if (frac > 0n) ours += mulDiv(tranche.positionWeight, frac, WAD);
      }
      const w = marketBefore.poolWeight(pool);
      return w > ours ? w - ours : 0n;
    });
    model.advance(stepSec);
    const revenueTotal = model.totals().revenueTotal;
    const deltaRev = revenueTotal - prevRevenueTotal;
    prevRevenueTotal = revenueTotal;
    const revByPool = model.revenueByPool();
    const deltas = allocPools.map(
      (pool) => (revByPool.get(pool) ?? 0n) - (prevRevByPool.get(pool) ?? 0n),
    );
    prevRevByPool = revByPool;
    // per-pool twin of the passive benchmark: a market-cap portfolio of our
    // size takes portfolioWeight/globalWeight of each pool's revenue delta
    if (globalWeight > 0n) {
      benchmark += divWad(deltaRev, globalWeight);
      for (let p = 0; p < allocPools.length; p += 1) {
        const delta = deltas[p]!;
        if (delta > 0n) {
          const pool = allocPools[p]!;
          passiveEarned.set(
            pool,
            (passiveEarned.get(pool) ?? 0n) + mulDiv(delta, portfolioWeight, globalWeight),
          );
        }
      }
    }
    // oracle benchmark: buffer the step; close the epoch at weekly flips
    epochStepDeltas.push(deltas);
    epochStepWeightsExUs.push(weightsExUs);
    for (let p = 0; p < allocPools.length; p += 1) {
      epochRevenue[p] = epochRevenue[p]! + deltas[p]!;
    }
    if (Math.floor((t + stepSec) / WEEK) > Math.floor(t / WEEK)) closeOracleEpoch();
    if ((t + stepSec - startTime) % sampleIntervalSec === 0) sample(t + stepSec);
  }
  closeOracleEpoch(); // partial final epoch: revenue-to-date shares

  const totalReturn = portfolioEquity();
  return {
    totalReturn,
    passiveReturn: benchmark,
    revenueBenchmarkReturn: (() => {
      let sum = 0n;
      for (const value of oracleEarnedCum) sum += value;
      return divWad(sum, portfolioWeight);
    })(),
    returnVsPassive: totalReturn - benchmark,
    maxDrawdownVsBenchmark: maxDrawdown,
    turnover,
    rotations,
    blockedSubmissions,
    // Analytics-only floats (marked): final ratio of integer counters.
    onTargetPct: poolSamples === 0 ? 0 : onCount / poolSamples,
    offTargetPct: poolSamples === 0 ? 0 : offCount / poolSamples,
    poolSamples,
    equityCurve: {
      times,
      equity: equitySeries,
      benchmark: benchmarkSeries,
      revenueBenchmark: oracleEquity,
    },
    allocationHistory: {
      times: [...times],
      pools: allocPools,
      weights: allocWeights,
      earned: allocEarned,
      benchmarkWeights: benchWeights,
      benchmarkEarned: benchEarned,
      revenueBenchmarkWeights: oracleWeights,
      revenueBenchmarkEarned: oracleEarned,
    },
  };
}
