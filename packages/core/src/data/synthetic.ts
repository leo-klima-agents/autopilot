/**
 * Seeded synthetic scenario generator. Emits the same DatasetV1 schema the
 * sugar indexer produces, so the backtester consumes real and synthetic
 * data interchangeably. Entirely bigint + seeded PRNG, deterministic and
 * fixture-safe (no floats anywhere).
 *
 * Pools come from a curated archetype roster of real Aerodrome pools,
 * calibrated once against per-pool medians of data/aerodrome-epochs.v1.json
 * (30 pools × ~52 weekly epochs, indexed 2026-07-18):
 * - `baseFeesUsd`/`baseBribesUsd` are the real pools' median weekly USD
 *   values (CL100-WETH/USDC ≈ $263k/wk fees; sAMM stables earn ~$0.6–0.9k
 *   in fees but $10–15k/wk in bribes).
 * - votes ≈ 544 × prior-week revenue USD (empirical median; p10 180,
 *   p90 1162), applied with ×[0.7, 1.3] noise and a one-week lag.
 * - emissions are pro-rata of a frozen weekly budget by realized votes,
 *   ≈ 4454/1e6 AERO per vote per week (empirical median), stored as a
 *   per-second Wad rate exactly like sugar data.
 *
 * Per-pool fee processes:
 * - persistent: mean-reverting around base, ×U[0.92, 1.08] weekly drift.
 * - bursty: persistent plus a 1/8 chance of a ×3–12 burst week
 *   (memecoin/incident weeks; real max/median ratios run 8–22×).
 * - regime: 2-state Markov, P(switch) = 1/10 per epoch, high state ×4
 *   (meta rotations, incentive programs).
 * - emerging: starts at base/8 and ramps ~+20%/wk toward 1.5× base, the
 *   cbBTC early-allocator arc.
 * - stable-lowvol: ×U[0.97, 1.03] drift (pegged-pair fee stability).
 *
 * The config `kind` is a scenario flavor over the mixed-archetype market:
 * "persistent" replays archetype defaults; "bursty" amplifies burst
 * frequency market-wide; "regime" adds a correlated market-wide 2-state
 * chain (×2 in the high state) on top of the per-pool processes.
 * Every draw uses integer arithmetic on the seeded xoshiro256** stream.
 */

import { WAD } from "../math/fixed.js";
import { createPrng } from "../math/prng.js";
import { epochStart, WEEK } from "../model/types.js";
import type { DatasetV1, EpochRecord, PoolRecord } from "./schema.js";

/** Synthetic scenario flavors (see the header comment for semantics). */
export type SyntheticProcessKind = "persistent" | "bursty" | "regime";

/** Per-pool fee process families (assigned by archetype, not by config). */
type PoolProcess = SyntheticProcessKind | "emerging" | "stable-lowvol";

/** Configuration for `generateSyntheticDataset`. */
export interface SyntheticConfig {
  /** PRNG seed; the dataset is a pure function of the config. */
  seed: bigint;
  /** Number of pools, at most `MAX_SYNTHETIC_POOLS`. */
  poolCount: number;
  /** Number of weekly epochs. */
  epochCount: number;
  /** Scenario flavor biasing the archetype mix. */
  kind: SyntheticProcessKind;
  /**
   * First epoch start (unix seconds); snapped down to a week boundary.
   * Default 1735171200 (Thu 2024-12-26 00:00 UTC).
   */
  startTs?: number;
}

/** Synthetic quote token used for all fee amounts (single-token datasets sum exactly). */
export const SYNTHETIC_QUOTE_TOKEN = "0x00000000000000000000000000000000000000f0";

/** One row of the calibrated roster: a real pool and its synthetic twin's parameters. */
interface PoolArchetype {
  /** Real Aerodrome display name; becomes symbol + displayName. */
  name: string;
  stable: boolean;
  /** Present for Slipstream (CL) pools only. */
  tickSpacing?: number;
  process: PoolProcess;
  /** Median weekly swap fees, whole USD. */
  baseFeesUsd: bigint;
  /** Median weekly bribes, whole USD (0 = the pool never posts incentives). */
  baseBribesUsd: bigint;
  /** A bribe week is skipped with probability 1/bribeSkipDen. */
  bribeSkipDen: bigint;
}

/**
 * The roster, ordered so small poolCounts still get a diverse market:
 * poolCount = 2 pairs the flagship with a memecoin; 6 covers every
 * archetype class (flagship, memecoin, mid-size, emerging, bribed stable,
 * regime-switcher). Values are medians from the real dataset (header note).
 */
const ARCHETYPES: readonly PoolArchetype[] = [
  { name: "CL100-WETH/USDC", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 263_000n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL200-WETH/BRETT", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 6_600n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-USDC/AERO", stable: false, process: "persistent", baseFeesUsd: 79_000n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL100-WETH/cbBTC", stable: false, tickSpacing: 100, process: "emerging", baseFeesUsd: 141_000n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "sAMM-msUSD/USDC", stable: true, process: "stable-lowvol", baseFeesUsd: 600n, baseBribesUsd: 10_000n, bribeSkipDen: 16n },
  { name: "vAMM-VIRTUAL/WETH", stable: false, process: "regime", baseFeesUsd: 18_500n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL50-WETH/msETH", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 8_700n, baseBribesUsd: 30_000n, bribeSkipDen: 16n },
  { name: "CL100-USDC/cbBTC", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 88_000n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL100-ZORA/USDC", stable: false, tickSpacing: 100, process: "bursty", baseFeesUsd: 19_200n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-WETH/VEIL", stable: false, process: "bursty", baseFeesUsd: 2_900n, baseBribesUsd: 6_600n, bribeSkipDen: 16n },
  { name: "CL50-WETH/USDC", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 82_600n, baseBribesUsd: 15_300n, bribeSkipDen: 4n },
  { name: "CL200-WETH/AERO", stable: false, tickSpacing: 200, process: "persistent", baseFeesUsd: 34_600n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL10-WETH/cbBTC", stable: false, tickSpacing: 10, process: "persistent", baseFeesUsd: 35_300n, baseBribesUsd: 8_300n, bribeSkipDen: 8n },
  { name: "CL50-USDC/cbBTC", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 31_600n, baseBribesUsd: 9_600n, bribeSkipDen: 3n },
  { name: "CL50-msUSD/USDC", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 9_300n, baseBribesUsd: 28_000n, bribeSkipDen: 16n },
  { name: "CL2000-USDC/cbBTC", stable: false, tickSpacing: 2000, process: "persistent", baseFeesUsd: 19_100n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL100-VIRTUAL/WETH", stable: false, tickSpacing: 100, process: "regime", baseFeesUsd: 18_900n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL2000-USDC/AERO", stable: false, tickSpacing: 2000, process: "regime", baseFeesUsd: 18_100n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL200-AERO/cbBTC", stable: false, tickSpacing: 200, process: "regime", baseFeesUsd: 17_900n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-WETH/USDC", stable: false, process: "persistent", baseFeesUsd: 17_700n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "sAMM-WETH/msETH", stable: true, process: "stable-lowvol", baseFeesUsd: 850n, baseBribesUsd: 14_700n, bribeSkipDen: 16n },
  { name: "CL200-WETH/MORPHO", stable: false, tickSpacing: 200, process: "persistent", baseFeesUsd: 11_600n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL100-WETH/ZEN", stable: false, tickSpacing: 100, process: "bursty", baseFeesUsd: 11_400n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL200-BNKR/WETH", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 10_500n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL200-cbBTC/ZEN", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 8_600n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-WETH/VVV", stable: false, process: "persistent", baseFeesUsd: 7_600n, baseBribesUsd: 13_600n, bribeSkipDen: 32n },
  { name: "CL100-cbADA/cbBTC", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 7_000n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-WETH/AERO", stable: false, process: "persistent", baseFeesUsd: 6_100n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "CL200-WETH/AAVE", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 4_700n, baseBribesUsd: 0n, bribeSkipDen: 1n },
  { name: "vAMM-fBOMB/AERO", stable: false, process: "persistent", baseFeesUsd: 600n, baseBribesUsd: 4_900n, bribeSkipDen: 3n },
];

/** Largest poolCount `generateSyntheticDataset` accepts (the roster size). */
export const MAX_SYNTHETIC_POOLS = ARCHETYPES.length;

/** Empirical median votes per weekly revenue dollar (Wad votes per Wad USD). */
const VOTES_PER_USD = 544n;

/** Empirical median weekly AERO emissions per vote, in parts per million. */
const EMISSIONS_PER_VOTE_PPM = 4_454n;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Generates a deterministic synthetic dataset in the v1 schema. */
export function generateSyntheticDataset(config: SyntheticConfig): DatasetV1 {
  const { seed, poolCount, epochCount, kind } = config;
  if (poolCount <= 0 || epochCount <= 0) {
    throw new Error("generateSyntheticDataset: poolCount and epochCount must be positive");
  }
  if (poolCount > ARCHETYPES.length) {
    throw new Error(`generateSyntheticDataset: poolCount must be <= ${ARCHETYPES.length}`);
  }
  const startTs = epochStart(config.startTs ?? 1_735_171_200);
  const prng = createPrng(seed);

  // Market-wide regime chain ("regime" flavor), drawn up front so every pool
  // sees the same correlated market state.
  const marketHigh: boolean[] = [];
  if (kind === "regime") {
    let high = prng.nextBigintBelow(4n) === 0n;
    for (let e = 0; e < epochCount; e += 1) {
      if (prng.nextBigintBelow(10n) === 0n) high = !high;
      marketHigh.push(high);
    }
  }

  // Pass 1: fees, bribes, and votes per pool per epoch.
  const feesByPool: bigint[][] = [];
  const bribesByPool: bigint[][] = [];
  const votesByPool: bigint[][] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const a = ARCHETYPES[p]!;
    // Per-seed level jitter ±25% so two seeds are not the same market.
    const base = (a.baseFeesUsd * WAD * (750n + prng.nextBigintBelow(501n))) / 1000n;
    const emergingTarget = (base * 3n) / 2n;
    let level = a.process === "emerging" ? base / 8n : base;
    let regimeHigh = a.process === "regime" && prng.nextBigintBelow(4n) === 0n;
    // Seeds the epoch-0 vote lag with the pool's steady-state revenue.
    let prevRevenue = level + a.baseBribesUsd * WAD;
    const fees: bigint[] = [];
    const bribes: bigint[] = [];
    const votes: bigint[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      // Votes follow last week's revenue (a lagged crowd), ×[0.7, 1.3] noise.
      votes.push((prevRevenue * VOTES_PER_USD * (700n + prng.nextBigintBelow(601n))) / 1000n);
      if (a.process === "stable-lowvol") {
        level = (3n * level + base) / 4n;
        level = (level * (970n + prng.nextBigintBelow(61n))) / 1000n;
      } else if (a.process === "emerging") {
        // Ramp from base/8 toward 1.5× base, then mean-revert around it.
        if (level >= emergingTarget) level = (3n * level + emergingTarget) / 4n;
        level = (level * (920n + prng.nextBigintBelow(161n))) / 1000n;
        if (level < emergingTarget) level = (level * 120n) / 100n;
      } else {
        level = (3n * level + base) / 4n;
        level = (level * (920n + prng.nextBigintBelow(161n))) / 1000n;
      }
      let fee = level;
      if (a.process === "bursty") {
        const burstDen = kind === "bursty" ? 4n : 8n;
        if (prng.nextBigintBelow(burstDen) === 0n) fee *= 3n + prng.nextBigintBelow(10n);
      } else if (kind === "bursty" && a.process !== "stable-lowvol") {
        // Turbulent flavor: even steady pools catch smaller ×2–5 bursts.
        if (prng.nextBigintBelow(20n) === 0n) fee *= 2n + prng.nextBigintBelow(4n);
      }
      if (a.process === "regime") {
        if (prng.nextBigintBelow(10n) === 0n) regimeHigh = !regimeHigh;
        if (regimeHigh) fee *= 4n;
      }
      if (kind === "regime" && marketHigh[e]) fee *= 2n;
      let bribe = 0n;
      if (a.baseBribesUsd > 0n && prng.nextBigintBelow(a.bribeSkipDen) !== 0n) {
        bribe = (a.baseBribesUsd * WAD * (800n + prng.nextBigintBelow(401n))) / 1000n;
      }
      fees.push(fee);
      bribes.push(bribe);
      prevRevenue = fee + bribe;
    }
    feesByPool.push(fees);
    bribesByPool.push(bribes);
    votesByPool.push(votes);
  }

  // Pass 2: emissions pro-rata of a frozen weekly budget by realized votes,
  // mirroring the real minter (emissions strictly follow votes in the data).
  let budgetWeekly = 0n;
  for (let p = 0; p < poolCount; p += 1) {
    const a = ARCHETYPES[p]!;
    budgetWeekly +=
      ((a.baseFeesUsd + a.baseBribesUsd) * WAD * VOTES_PER_USD * EMISSIONS_PER_VOTE_PPM) / 1_000_000n;
  }
  const totalVotes: bigint[] = [];
  for (let e = 0; e < epochCount; e += 1) {
    let t = 0n;
    for (let p = 0; p < poolCount; p += 1) t += votesByPool[p]![e]!;
    totalVotes.push(t);
  }

  const pools: PoolRecord[] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const a = ARCHETYPES[p]!;
    const epochs: EpochRecord[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      const fee = feesByPool[p]![e]!;
      const bribe = bribesByPool[p]![e]!;
      const votes = votesByPool[p]![e]!;
      // Per-second Wad rate, same semantics as the sugar indexer's field.
      const emissionRate =
        totalVotes[e]! > 0n ? (budgetWeekly * votes) / totalVotes[e]! / BigInt(WEEK) : 0n;
      const record: EpochRecord = {
        ts: startTs + e * WEEK,
        votes: votes.toString(),
        emissions: emissionRate.toString(),
        feesUsd: fee.toString(),
        bribes: bribe > 0n ? [{ token: SYNTHETIC_QUOTE_TOKEN, amount: bribe.toString() }] : [],
        fees: [{ token: SYNTHETIC_QUOTE_TOKEN, amount: fee.toString() }],
      };
      if (bribe > 0n) record.bribesUsd = bribe.toString();
      epochs.push(record);
    }
    const pool: PoolRecord = {
      // "sim:" keeps synthetic addresses out of the real address space; the
      // zero-padded index keeps lexicographic order == roster order (the web
      // app sorts addresses for wash-bait / static-crowd targeting).
      address: `sim:pool-${pad(p)}`,
      symbol: a.name,
      displayName: a.name,
      token0: `0x000000000000000000000000000000000000${pad(p)}1`,
      token1: SYNTHETIC_QUOTE_TOKEN,
      stable: a.stable,
      gaugeAlive: true,
      epochs,
    };
    if (a.tickSpacing !== undefined) pool.tickSpacing = a.tickSpacing;
    pools.push(pool);
  }

  return {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: "1970-01-01T00:00:00.000Z", // fixed: dataset is a pure function of config
    source: "synthetic",
    pools,
  };
}
