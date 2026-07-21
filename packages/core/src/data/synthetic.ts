/**
 * Seeded synthetic scenario generator. Emits the same DatasetV1 schema the
 * sugar indexer produces, so the backtester consumes real and synthetic
 * data interchangeably. Entirely bigint + seeded PRNG, deterministic and
 * fixture-safe (no floats anywhere).
 *
 * Realism model (calibrated against the committed data/aerodrome-epochs.v1
 * snapshot, 2025-07 → 2026-07 read; provenance figures inline below):
 * - Pools come from a fixed archetype roster mirroring the real top pools:
 *   CL/vAMM/sAMM naming with tickSpacing, real Base token addresses, and a
 *   heavy-tailed weekly fee scale (top pool ~$365k/week down to ~$1k).
 * - Fee processes per pool: persistent (multiplicative drift ×U[0.90,1.10]
 *   weekly), bursty (drift plus a 1/10 chance of a 5× week: wash-trading /
 *   incident weeks), regime-switching (2-state Markov, switch 1/10, high
 *   state 4×: meta rotations, incentive programs), and growth (a cbBTC-like
 *   adoption ramp: geometric ×GROWTH_PER_EPOCH_MILLI/1000 per epoch for
 *   GROWTH_RAMP_EPOCHS epochs, then plateau — the published early-allocator
 *   arc, Sep 2024 – Feb 2025, where trailing-performance expectations
 *   under-predicted realized fees by ~43% for the earliest allocators).
 * - Bribes: per-archetype bribe/fee ratio (most pools ≲0.3×; bribe-dominant
 *   pools like the msETH/msUSD pairs run 2–10× fees), jittered ×U[0.7,1.3].
 * - Votes: a one-epoch-lagged crowd splits a fixed veAERO total pro-rata to
 *   trailing (fees + bribes) revenue with per-pool noise ×U[0.8,1.2]
 *   (snapshot: ~800M veAERO total, top pool ~201M).
 * - Emissions: a fixed weekly AERO budget split pro-rata to votes, recorded
 *   as a per-second rate exactly like sugar reports gauge emissions
 *   (snapshot: top pool ~1.9 AERO/s ≈ 1.15M AERO/week at ~25% vote share
 *   ⇒ global ~4.6M AERO/week). Gauge caps are NOT modeled here: the
 *   continuous model applies its own κ-cap to emissions; modeling caps in
 *   the data would double-apply them.
 *
 * Determinism discipline: one splitmix64 seed stream hands an independent
 * xoshiro256** stream to each pool (fee/bribe draws) plus one dedicated
 * stream for vote noise. Pool p's fee path is a function of (seed, p,
 * process) only, so growing `poolCount` leaves existing pools' fees
 * bit-identical; votes and emissions are global splits and legitimately
 * change with the universe size.
 */

import { WAD, mulDiv } from "../math/fixed.js";
import { createPrng, splitmix64, type Prng } from "../math/prng.js";
import { splitProportionally } from "../math/split.js";
import { epochStart, WEEK } from "../model/types.js";
import type { DatasetV1, EpochRecord, PoolRecord } from "./schema.js";

/** Synthetic fee process families. Legacy kinds apply one process to every
 *  pool; "mixed" gives each pool its archetype's own process (the realistic
 *  default: real venues are a mixture). */
export type SyntheticProcessKind = "persistent" | "bursty" | "regime" | "mixed";

/**
 * Generator version, bumped on any change that alters the numbers a given
 * (seed, config) produces — the archetype recalibration that introduced it
 * was such a change. Consumers that serialize synthetic configs (the web
 * app's share links) stamp this in and can tell a link generated under an
 * older generator from one that reproduces exactly today. Version 1 is the
 * original uncalibrated generator (vAMM-SIMxx pools, $1k×2^k fees).
 */
export const SYNTHETIC_GENERATOR_VERSION = 2;

/** Per-pool process kinds (the archetype column behind "mixed"). */
type PoolProcessKind = "persistent" | "bursty" | "regime" | "growth";

/** Configuration for `generateSyntheticDataset`. */
export interface SyntheticConfig {
  /** PRNG seed; the dataset is a pure function of the config. */
  seed: bigint;
  /** Number of pools. */
  poolCount: number;
  /** Number of weekly epochs. */
  epochCount: number;
  /** Fee process family. */
  kind: SyntheticProcessKind;
  /**
   * First epoch start (unix seconds); snapped down to a week boundary.
   * Default 1735171200 (Thu 2024-12-26 00:00 UTC).
   */
  startTs?: number;
}

/** Synthetic quote token used for all fee/bribe amounts (single-token
 *  datasets sum exactly; 1 unit ≡ $1 Wad). */
export const SYNTHETIC_QUOTE_TOKEN = "0x00000000000000000000000000000000000000f0";

// Real Base token addresses (from the committed data/tokens.json cache) so
// synthetic pools carry plausible token identities for display tooling.
const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const CBBTC = "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const ZORA = "0x1111111111166b7fe7bd91427724b487980afc69";
const VIRTUAL = "0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b";
const ZEN = "0xf43eb8de897fbc7f2502483b2bef7bb9ea179229";
const MORPHO = "0xbaa5cc21fd487b8fcc2f632f3f4e8d37262a0842";
const MSETH = "0x7ba6f01772924a82d9626c126347a28299e98c98";
const MSUSD = "0x526728dbc96689597f85ae4cd716d4f7fccbae9d";
const BRETT = "0x532f27101965dd16442e59d40670faf5ebb142e4";
const VVV = "0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf";
const AAVE = "0x63706e401c06ac8513145b7687a14804d17f814b";

/** veAERO total split across pools each epoch (snapshot: ~800M locked). */
export const TOTAL_VEAERO_WAD = 800_000_000n * WAD;
/** Weekly AERO emission budget split pro-rata to votes (snapshot: ~4.6M/wk). */
export const WEEKLY_EMISSIONS_WAD = 4_600_000n * WAD;

/** Growth (cbBTC-arc) ramp: level ×1.35/epoch for 10 epochs starting at
 *  epoch 3 (~20× over the ramp, the Sep-2024→Feb-2025 cbBTC trajectory
 *  compressed to a preset-sized window). Calibrated so a persistence-carry
 *  early allocator on a 24h signal captures ≈1.4× vs the passive benchmark
 *  on the growth pool against a two-week-lagged crowd (the published
 *  methodology's baseline signal), test-asserted as a band, never the
 *  exact published 1.43. */
export const GROWTH_RAMP_START = 3;
export const GROWTH_RAMP_EPOCHS = 10;
const GROWTH_PER_EPOCH_MILLI = 1_350n;

/** Pools are addressed `sim:pool-NN` with a fixed-width index so that
 *  lexicographically sorted addresses equal roster order — an invariant the
 *  web app's pool-index controls (wash-bait targeting) rely on. Two digits
 *  bound poolCount at 100; the generator rejects larger universes rather
 *  than silently breaking the sort order. */
const MAX_POOL_COUNT = 100;

interface PoolArchetype {
  displayName: string;
  stable: boolean;
  tickSpacing?: number;
  token0: string;
  token1: string;
  /** Weekly fee scale, Wad USD (empirical average of the snapshot pool). */
  baseFeesUsdWad: bigint;
  /** Bribes as ‰ of weekly fees (0 = never bribed). */
  bribeToFeeMilli: bigint;
  /** Process used when kind === "mixed". */
  process: PoolProcessKind;
}

/** The roster, fee-scale descending like the real top-30 (snapshot averages
 *  in comments). Index 3 is the growth slot: the cbBTC pool enters small and
 *  ramps, so every mixed run of ≥4 pools contains the early-allocator arc. */
const ROSTER: readonly PoolArchetype[] = [
  // $365k/wk, bribes ≈0
  { displayName: "CL100-WETH/USDC", stable: false, tickSpacing: 100, token0: WETH, token1: USDC, baseFeesUsdWad: 360_000n * WAD, bribeToFeeMilli: 1n, process: "persistent" },
  // $152k/wk
  { displayName: "CL100-WETH/cbBTC", stable: false, tickSpacing: 100, token0: WETH, token1: CBBTC, baseFeesUsdWad: 150_000n * WAD, bribeToFeeMilli: 1n, process: "persistent" },
  // $110k/wk; the AERO book turns with incentive metas
  { displayName: "vAMM-USDC/AERO", stable: false, token0: USDC, token1: AERO, baseFeesUsdWad: 110_000n * WAD, bribeToFeeMilli: 1n, process: "regime" },
  // the growth slot: enters at ~$8k/wk, ramps toward the ~$98k/wk snapshot average
  { displayName: "CL100-USDC/cbBTC", stable: false, tickSpacing: 100, token0: USDC, token1: CBBTC, baseFeesUsdWad: 8_000n * WAD, bribeToFeeMilli: 30n, process: "growth" },
  // $63k/wk, bribed ~0.36×
  { displayName: "CL50-WETH/USDC", stable: false, tickSpacing: 50, token0: WETH, token1: USDC, baseFeesUsdWad: 63_000n * WAD, bribeToFeeMilli: 360n, process: "persistent" },
  // $41k/wk memecoin flow
  { displayName: "CL100-ZORA/USDC", stable: false, tickSpacing: 100, token0: ZORA, token1: USDC, baseFeesUsdWad: 41_000n * WAD, bribeToFeeMilli: 70n, process: "bursty" },
  // $36k/wk
  { displayName: "CL200-AERO/cbBTC", stable: false, tickSpacing: 200, token0: AERO, token1: CBBTC, baseFeesUsdWad: 36_000n * WAD, bribeToFeeMilli: 40n, process: "regime" },
  // $35k/wk
  { displayName: "CL200-WETH/AERO", stable: false, tickSpacing: 200, token0: WETH, token1: AERO, baseFeesUsdWad: 35_000n * WAD, bribeToFeeMilli: 1n, process: "persistent" },
  // $30k/wk, bribed ~0.4×
  { displayName: "CL10-WETH/cbBTC", stable: false, tickSpacing: 10, token0: WETH, token1: CBBTC, baseFeesUsdWad: 30_000n * WAD, bribeToFeeMilli: 400n, process: "persistent" },
  // $29k/wk
  { displayName: "CL2000-USDC/AERO", stable: false, tickSpacing: 2000, token0: USDC, token1: AERO, baseFeesUsdWad: 29_000n * WAD, bribeToFeeMilli: 10n, process: "persistent" },
  // $27k/wk, bribed ~0.42×
  { displayName: "CL50-USDC/cbBTC", stable: false, tickSpacing: 50, token0: USDC, token1: CBBTC, baseFeesUsdWad: 27_000n * WAD, bribeToFeeMilli: 420n, process: "persistent" },
  // $26k/wk AI-meme flow
  { displayName: "vAMM-VIRTUAL/WETH", stable: false, token0: VIRTUAL, token1: WETH, baseFeesUsdWad: 26_000n * WAD, bribeToFeeMilli: 1n, process: "bursty" },
  // $24k/wk
  { displayName: "CL100-WETH/ZEN", stable: false, tickSpacing: 100, token0: WETH, token1: ZEN, baseFeesUsdWad: 24_000n * WAD, bribeToFeeMilli: 20n, process: "bursty" },
  // $22k/wk
  { displayName: "CL2000-USDC/cbBTC", stable: false, tickSpacing: 2000, token0: USDC, token1: CBBTC, baseFeesUsdWad: 22_000n * WAD, bribeToFeeMilli: 1n, process: "persistent" },
  // $20k/wk
  { displayName: "vAMM-WETH/USDC", stable: false, token0: WETH, token1: USDC, baseFeesUsdWad: 20_000n * WAD, bribeToFeeMilli: 1n, process: "persistent" },
  // $13k/wk
  { displayName: "CL200-WETH/MORPHO", stable: false, tickSpacing: 200, token0: WETH, token1: MORPHO, baseFeesUsdWad: 13_000n * WAD, bribeToFeeMilli: 50n, process: "regime" },
  // $12.5k/wk fees vs $29.5k/wk bribes: bribe-dominant LST pool
  { displayName: "CL50-WETH/msETH", stable: false, tickSpacing: 50, token0: WETH, token1: MSETH, baseFeesUsdWad: 12_500n * WAD, bribeToFeeMilli: 2_360n, process: "persistent" },
  // $12.5k/wk fees vs $27.6k/wk bribes: bribe-dominant stable pool
  { displayName: "CL50-msUSD/USDC", stable: false, tickSpacing: 50, token0: MSUSD, token1: USDC, baseFeesUsdWad: 12_500n * WAD, bribeToFeeMilli: 2_215n, process: "persistent" },
  // $11.5k/wk
  { displayName: "CL200-WETH/BRETT", stable: false, tickSpacing: 200, token0: WETH, token1: BRETT, baseFeesUsdWad: 11_500n * WAD, bribeToFeeMilli: 5n, process: "bursty" },
  // $10.5k/wk fees vs $16.5k/wk bribes
  { displayName: "vAMM-WETH/VVV", stable: false, token0: WETH, token1: VVV, baseFeesUsdWad: 10_500n * WAD, bribeToFeeMilli: 1_570n, process: "regime" },
  // $8.6k/wk
  { displayName: "vAMM-WETH/AERO", stable: false, token0: WETH, token1: AERO, baseFeesUsdWad: 8_600n * WAD, bribeToFeeMilli: 10n, process: "persistent" },
  // $8.1k/wk
  { displayName: "CL200-WETH/AAVE", stable: false, tickSpacing: 200, token0: WETH, token1: AAVE, baseFeesUsdWad: 8_100n * WAD, bribeToFeeMilli: 25n, process: "persistent" },
  // $1.6k/wk fees vs $16.1k/wk bribes: the sAMM bribe-farm shape
  { displayName: "sAMM-WETH/msETH", stable: true, token0: WETH, token1: MSETH, baseFeesUsdWad: 1_600n * WAD, bribeToFeeMilli: 10_000n, process: "persistent" },
  // $1.2k/wk fees vs $10.9k/wk bribes
  { displayName: "sAMM-msUSD/USDC", stable: true, token0: MSUSD, token1: USDC, baseFeesUsdWad: 1_200n * WAD, bribeToFeeMilli: 9_100n, process: "persistent" },
];

/** Index of the growth-archetype pool (the cbBTC slot), derived from the
 *  roster so inserting or reordering archetypes cannot desynchronize it. */
export const GROWTH_POOL_INDEX = ROSTER.findIndex((a) => a.process === "growth");

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Archetype for pool index `p`: roster entry, or a deterministic long-tail
 *  pool (fee scale decaying ×4/5 per rank past the roster, unbribed). */
function archetypeFor(p: number): PoolArchetype {
  const entry = ROSTER[p];
  if (entry !== undefined) return entry;
  let base = ROSTER[ROSTER.length - 1]!.baseFeesUsdWad;
  for (let i = ROSTER.length; i <= p; i += 1) base = mulDiv(base, 4n, 5n);
  return {
    displayName: `vAMM-SIM${pad(p)}/USDC`,
    stable: false,
    // 0x + 37 zeros + 2-digit index + 1 = a well-formed 40-hex address
    token0: `0x0000000000000000000000000000000000000${pad(p)}1`,
    token1: USDC,
    baseFeesUsdWad: base,
    bribeToFeeMilli: 0n,
    process: "persistent",
  };
}

/** Generates a deterministic synthetic dataset in the v1 schema. */
export function generateSyntheticDataset(config: SyntheticConfig): DatasetV1 {
  const { seed, poolCount, epochCount, kind } = config;
  if (poolCount <= 0 || epochCount <= 0) {
    throw new Error("generateSyntheticDataset: poolCount and epochCount must be positive");
  }
  if (poolCount > MAX_POOL_COUNT) {
    throw new Error(
      `generateSyntheticDataset: poolCount ${poolCount} exceeds ${MAX_POOL_COUNT} (address sort-order bound)`,
    );
  }
  if (!["persistent", "bursty", "regime", "mixed"].includes(kind)) {
    throw new Error(`generateSyntheticDataset: unknown kind ${JSON.stringify(kind)}`);
  }
  const startTs = epochStart(config.startTs ?? 1_735_171_200);

  // One independent stream per pool (prefix-stable in poolCount), then one
  // for vote noise. Order matters: pool streams are seeded first so pool p's
  // stream depends only on (seed, p).
  const seedGen = splitmix64(seed);
  const poolPrngs: Prng[] = Array.from({ length: poolCount }, () => createPrng(seedGen()));
  const votesPrng = createPrng(seedGen());

  // -- pass 1: per-pool fee/bribe paths (independent streams) -----------------
  const archetypes = Array.from({ length: poolCount }, (_, p) => archetypeFor(p));
  const baseLevels: bigint[] = [];
  const feesUsd: bigint[][] = []; // [pool][epoch]
  const bribesUsd: bigint[][] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const arch = archetypes[p]!;
    const prng = poolPrngs[p]!;
    const process: PoolProcessKind = kind === "mixed" ? arch.process : kind;
    // Per-seed scale jitter ×U[0.85, 1.15] around the empirical base.
    const base = (arch.baseFeesUsdWad * (850n + prng.nextBigintBelow(301n))) / 1_000n;
    baseLevels.push(base);
    let level = base;
    let regimeHigh = process === "regime" ? prng.nextBigintBelow(4n) === 0n : false;
    const fees: bigint[] = [];
    const bribes: bigint[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      // persistent drift: ×(900..1100)/1000 each week (all processes).
      level = (level * (900n + prng.nextBigintBelow(201n))) / 1_000n;
      if (
        process === "growth" &&
        e >= GROWTH_RAMP_START &&
        e < GROWTH_RAMP_START + GROWTH_RAMP_EPOCHS
      ) {
        // adoption ramp compounds into the level (permanent growth)
        level = (level * GROWTH_PER_EPOCH_MILLI) / 1_000n;
      }
      let revenue = level;
      if (process === "bursty") {
        // Poisson-like burst overlay: 1/10 chance of a 5x week (transient).
        if (prng.nextBigintBelow(10n) === 0n) revenue *= 5n;
      } else if (process === "regime") {
        // 2-state Markov: switch with prob 1/10; high state is 4x (transient).
        if (prng.nextBigintBelow(10n) === 0n) regimeHigh = !regimeHigh;
        if (regimeHigh) revenue *= 4n;
      }
      fees.push(revenue);
      // Bribes are budgeted incentives: tied to the pool's steady level (not
      // burst weeks), jittered ×U[0.7, 1.3].
      const bribe =
        arch.bribeToFeeMilli === 0n
          ? 0n
          : (((level * arch.bribeToFeeMilli) / 1_000n) * (700n + prng.nextBigintBelow(601n))) /
            1_000n;
      bribes.push(bribe);
    }
    feesUsd.push(fees);
    bribesUsd.push(bribes);
  }

  // -- pass 2: votes (lagged crowd) and emissions (pro-rata budget) ------------
  const addresses = Array.from({ length: poolCount }, (_, p) => `sim:pool-${pad(p)}`);
  const votesByEpoch: Map<string, bigint>[] = [];
  const emissionsByEpoch: Map<string, bigint>[] = [];
  for (let e = 0; e < epochCount; e += 1) {
    // The crowd votes on trailing total revenue (fees + bribes; bribes are
    // exactly what pulls votes), one epoch behind, with per-pool noise.
    const scores = new Map<string, bigint>();
    for (let p = 0; p < poolCount; p += 1) {
      // Epoch 0 has no trailing week; seed it with the pool's expected
      // steady-state total (base fees plus the archetype's bribe budget) so
      // bribe-dominant pools are not spuriously under-voted in week one.
      const trailing =
        e === 0
          ? (baseLevels[p]! * (1_000n + archetypes[p]!.bribeToFeeMilli)) / 1_000n
          : feesUsd[p]![e - 1]! + bribesUsd[p]![e - 1]!;
      const noisy = (trailing * (800n + votesPrng.nextBigintBelow(401n))) / 1_000n;
      scores.set(addresses[p]!, noisy);
    }
    const votes = splitProportionally(TOTAL_VEAERO_WAD, scores);
    votesByEpoch.push(votes);
    emissionsByEpoch.push(splitProportionally(WEEKLY_EMISSIONS_WAD, votes));
  }

  // -- assemble ----------------------------------------------------------------
  const pools: PoolRecord[] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const arch = archetypes[p]!;
    const address = addresses[p]!;
    const epochs: EpochRecord[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      const fee = feesUsd[p]![e]!;
      const bribe = bribesUsd[p]![e]!;
      epochs.push({
        ts: startTs + e * WEEK,
        votes: votesByEpoch[e]!.get(address)!.toString(),
        // per-second rate, exactly how sugar reports gauge emissions
        emissions: (emissionsByEpoch[e]!.get(address)! / BigInt(WEEK)).toString(),
        feesUsd: fee.toString(),
        bribesUsd: bribe.toString(),
        bribes: bribe > 0n ? [{ token: SYNTHETIC_QUOTE_TOKEN, amount: bribe.toString() }] : [],
        fees: [{ token: SYNTHETIC_QUOTE_TOKEN, amount: fee.toString() }],
      });
    }
    const record: PoolRecord = {
      address,
      symbol: arch.displayName,
      displayName: arch.displayName,
      token0: arch.token0,
      token1: arch.token1,
      stable: arch.stable,
      gaugeAlive: true,
      epochs,
    };
    if (arch.tickSpacing !== undefined) record.tickSpacing = arch.tickSpacing;
    pools.push(record);
  }

  return {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: "1970-01-01T00:00:00.000Z", // fixed: dataset is a pure function of config
    source: "synthetic",
    pools,
  };
}
