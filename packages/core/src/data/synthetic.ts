/**
 * Seeded synthetic scenario generator. Emits the same DatasetV1 schema the
 * sugar indexer produces, so the backtester consumes real and synthetic
 * data interchangeably. Entirely bigint + seeded PRNG, deterministic and
 * fixture-safe (no floats anywhere).
 *
 * Provenance: the pool roster below is a curated archetype table calibrated
 * once (at design time) from per-pool medians of the committed real dataset
 * (data/aerodrome-epochs.v1.json, top-30 Aerodrome pools, ~52 weekly epochs,
 * USD-priced). Each archetype carries a real pool's display name, its median
 * weekly fees and bribes in whole USD, and the revenue process family its
 * history most resembles. The dataset is NOT loaded at runtime; the numbers
 * are frozen constants so the generator stays self-contained and bundles
 * for the browser.
 *
 * Cross-pool empirical relationships encoded here (measured on the same
 * dataset):
 * - votes ≈ 580 × prior-week revenue USD (fees + bribes), ×U[0.7,1.3]
 *   noise, one-week lag (the crowd votes on last week's revenue; the
 *   observed median ratio is ~515, p10–p90 ≈ 180–1140).
 * - weekly emissions ≈ votes × 0.00441 (observed median 0.00438): pools
 *   split a frozen global weekly emission budget pro-rata to votes, and the
 *   `emissions` field is the per-second Wad rate exactly as sugar reports.
 *   Generation is two-pass: pass 1 draws fees/bribes/votes per pool per
 *   epoch, pass 2 derives emissions from the vote totals (no extra draws).
 *   The backtester reads only fees/bribes (see revenue.ts); votes and
 *   emissions are realism/display-only.
 *
 * Per-pool process families:
 * - persistent: mean-reverting level around the archetype base,
 *   `level = (level*3 + base)/4` then ×U[0.92,1.08] weekly noise.
 * - stable-lowvol: same, with ×U[0.97,1.03] noise (correlated-pair pools).
 * - bursty: persistent plus a 1/8 chance of a ×3–12 burst week
 *   (memecoin/incident weeks; the real ZORA pool peaks at 11.8× median).
 * - regime: 2-state Markov chain, P(switch) = 1/10; high state ×4
 *   (meta rotations, incentive programs).
 * - emerging: starts at base/8 and ramps ~+15%/week until 1.5× base, then
 *   mean-reverts there (the cbBTC early-allocator ramp).
 *
 * The `kind` config value is a SCENARIO FLAVOR, not a single shared
 * process (wire values unchanged for URL compatibility):
 * - "persistent": archetype defaults, a realistic mixed market.
 * - "bursty": burst probabilities amplified everywhere (bursty pools 1/4,
 *   every other pool gains a 1/16 burst chance).
 * - "regime": adds a correlated market-wide 2-state chain (×2 high,
 *   P(switch) = 1/10) on top of the per-pool processes.
 * Every draw uses integer arithmetic on the seeded xoshiro256** stream in a
 * fixed order, so the same seed always yields the identical dataset.
 */

import { WAD } from "../math/fixed.js";
import { createPrng, type Prng } from "../math/prng.js";
import { epochStart, WEEK } from "../model/types.js";
import type { DatasetV1, EpochRecord, PoolRecord } from "./schema.js";

/** Synthetic scenario flavors (wire values are stable; see header). */
export type SyntheticProcessKind = "persistent" | "bursty" | "regime";

/** Per-pool revenue process families (internal to the archetype roster). */
type ProcessKind = "persistent" | "bursty" | "regime" | "emerging" | "stable-lowvol";

/** One curated pool archetype (see header for provenance). */
interface PoolArchetype {
  /** Real Aerodrome pool name, used as displayName and symbol. */
  name: string;
  stable: boolean;
  /** Present iff the archetype is a Slipstream (CL) pool. */
  tickSpacing?: number;
  process: ProcessKind;
  /** Median weekly fees, whole USD. */
  baseFeesUsd: bigint;
  /** Median weekly bribes, whole USD (0n = this pool never bribes). */
  baseBribesUsd: bigint;
  /** A bribe week is skipped with probability 1/N (16n typical; 3n long-tail). */
  bribeEveryN: bigint;
}

/**
 * The archetype roster, ordered so a small poolCount still gets a diverse
 * mix: poolCount=2 is flagship + memecoin, 6 covers every process class.
 * Names, magnitudes, and process families come from the real dataset's
 * per-pool medians (see header).
 */
const ROSTER: PoolArchetype[] = [
  { name: "CL100-WETH/USDC", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 263_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL200-WETH/BRETT", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 6_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL100-WETH/cbBTC", stable: false, tickSpacing: 100, process: "emerging", baseFeesUsd: 141_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "sAMM-msUSD/USDC", stable: true, process: "stable-lowvol", baseFeesUsd: 600n, baseBribesUsd: 10_000n, bribeEveryN: 16n },
  { name: "vAMM-VIRTUAL/WETH", stable: false, process: "regime", baseFeesUsd: 18_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL50-WETH/msETH", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 9_000n, baseBribesUsd: 30_000n, bribeEveryN: 16n },
  { name: "vAMM-USDC/AERO", stable: false, process: "persistent", baseFeesUsd: 79_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL100-USDC/cbBTC", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 88_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL100-ZORA/USDC", stable: false, tickSpacing: 100, process: "bursty", baseFeesUsd: 19_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL50-WETH/USDC", stable: false, tickSpacing: 50, process: "stable-lowvol", baseFeesUsd: 82_500n, baseBribesUsd: 27_000n, bribeEveryN: 3n },
  { name: "vAMM-WETH/VVV", stable: false, process: "persistent", baseFeesUsd: 7_500n, baseBribesUsd: 14_000n, bribeEveryN: 16n },
  { name: "CL200-AERO/cbBTC", stable: false, tickSpacing: 200, process: "regime", baseFeesUsd: 18_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL2000-USDC/AERO", stable: false, tickSpacing: 2000, process: "persistent", baseFeesUsd: 18_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL10-WETH/cbBTC", stable: false, tickSpacing: 10, process: "stable-lowvol", baseFeesUsd: 35_000n, baseBribesUsd: 14_000n, bribeEveryN: 3n },
  { name: "CL100-WETH/ZEN", stable: false, tickSpacing: 100, process: "bursty", baseFeesUsd: 11_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL50-msUSD/USDC", stable: false, tickSpacing: 50, process: "persistent", baseFeesUsd: 9_300n, baseBribesUsd: 30_000n, bribeEveryN: 16n },
  { name: "CL100-VIRTUAL/WETH", stable: false, tickSpacing: 100, process: "persistent", baseFeesUsd: 19_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "vAMM-WETH/USDC", stable: false, process: "persistent", baseFeesUsd: 17_700n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL2000-USDC/cbBTC", stable: false, tickSpacing: 2000, process: "persistent", baseFeesUsd: 19_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "sAMM-WETH/msETH", stable: true, process: "stable-lowvol", baseFeesUsd: 850n, baseBribesUsd: 15_000n, bribeEveryN: 16n },
  { name: "CL200-BNKR/WETH", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 10_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "vAMM-WETH/VEIL", stable: false, process: "bursty", baseFeesUsd: 2_900n, baseBribesUsd: 7_000n, bribeEveryN: 16n },
  { name: "CL200-WETH/MORPHO", stable: false, tickSpacing: 200, process: "persistent", baseFeesUsd: 11_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL200-cbBTC/ZEN", stable: false, tickSpacing: 200, process: "regime", baseFeesUsd: 8_600n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "vAMM-fBOMB/AERO", stable: false, process: "persistent", baseFeesUsd: 600n, baseBribesUsd: 4_900n, bribeEveryN: 3n },
  { name: "vAMM-WETH/AERO", stable: false, process: "persistent", baseFeesUsd: 6_100n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL200-WETH/AERO", stable: false, tickSpacing: 200, process: "emerging", baseFeesUsd: 34_500n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL50-USDC/cbBTC", stable: false, tickSpacing: 50, process: "stable-lowvol", baseFeesUsd: 31_500n, baseBribesUsd: 17_500n, bribeEveryN: 3n },
  { name: "CL200-WETH/AAVE", stable: false, tickSpacing: 200, process: "bursty", baseFeesUsd: 4_700n, baseBribesUsd: 0n, bribeEveryN: 16n },
  { name: "CL100-cbADA/cbBTC", stable: false, tickSpacing: 100, process: "regime", baseFeesUsd: 7_000n, baseBribesUsd: 0n, bribeEveryN: 16n },
];

/** The roster (exported for tests/UI limits): poolCount may not exceed it. */
export const SYNTHETIC_POOL_ARCHETYPES: readonly { name: string; stable: boolean; tickSpacing?: number }[] =
  ROSTER.map(({ name, stable, tickSpacing }) => (tickSpacing === undefined ? { name, stable } : { name, stable, tickSpacing }));

/** votes ≈ VOTES_PER_REVENUE_USD × prior-week revenue (see header). */
const VOTES_PER_REVENUE_USD = 580n;
/** weekly emissions ≈ votes × EMISSIONS_PER_VOTE_MICRO / 1e6 (0.00441). */
const EMISSIONS_PER_VOTE_MICRO = 4_410n;

/** Configuration for `generateSyntheticDataset`. */
export interface SyntheticConfig {
  /** PRNG seed; the dataset is a pure function of the config. */
  seed: bigint;
  /** Number of pools (max = archetype roster size, 30). */
  poolCount: number;
  /** Number of weekly epochs. */
  epochCount: number;
  /** Scenario flavor (see header). */
  kind: SyntheticProcessKind;
  /**
   * First epoch start (unix seconds); snapped down to a week boundary.
   * Default 1735171200 (Thu 2024-12-26 00:00 UTC).
   */
  startTs?: number;
}

/** Synthetic quote token used for all fee amounts (single-token datasets sum exactly). */
export const SYNTHETIC_QUOTE_TOKEN = "0x00000000000000000000000000000000000000f0";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** ×U[lo/1000, (lo+span-1)/1000] multiplicative jitter, integer-exact. */
function jitter(prng: Prng, value: bigint, lo: bigint, span: bigint): bigint {
  return (value * (lo + prng.nextBigintBelow(span))) / 1_000n;
}

/** Generates a deterministic synthetic dataset in the v1 schema. */
export function generateSyntheticDataset(config: SyntheticConfig): DatasetV1 {
  const { seed, poolCount, epochCount, kind } = config;
  if (poolCount <= 0 || epochCount <= 0) {
    throw new Error("generateSyntheticDataset: poolCount and epochCount must be positive");
  }
  if (poolCount > ROSTER.length) {
    throw new Error(
      `generateSyntheticDataset: poolCount ${poolCount} exceeds the archetype roster (${ROSTER.length})`,
    );
  }
  const startTs = epochStart(config.startTs ?? 1_735_171_200);
  const prng = createPrng(seed);

  // The "regime" flavor's market-wide chain is drawn up front (one draw per
  // epoch + the initial state) so per-pool draw order stays independent of it.
  const marketMul: bigint[] = new Array<bigint>(epochCount).fill(1n);
  if (kind === "regime") {
    let high = prng.nextBigintBelow(4n) === 0n; // 25% start in the high state
    for (let e = 0; e < epochCount; e += 1) {
      if (prng.nextBigintBelow(10n) === 0n) high = !high;
      marketMul[e] = high ? 2n : 1n;
    }
  }

  // -- pass 1: fees, bribes, votes per pool per epoch -------------------------
  interface Draft {
    feesUsd: bigint;
    bribesUsd: bigint;
    votes: bigint;
  }
  const drafts: Draft[][] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const arch = ROSTER[p]!;
    // per-seed level jitter ±25% on the archetype base, so different seeds
    // are different markets, not the same table replayed
    let base = jitter(prng, arch.baseFeesUsd * WAD, 750n, 501n);
    let level = arch.process === "emerging" ? base / 8n : base;
    let ramping = arch.process === "emerging";
    // burst chance denominator: 0n = never (see flavor semantics in header)
    const burstDenom =
      arch.process === "bursty" ? (kind === "bursty" ? 4n : 8n) : kind === "bursty" ? 16n : 0n;
    let regimeHigh = arch.process === "regime" && prng.nextBigintBelow(4n) === 0n;
    // votes lag revenue by one week; before the first epoch the crowd has
    // only the archetype's steady state to go on
    let prevRevenue = base + (arch.baseBribesUsd > 0n ? arch.baseBribesUsd * WAD : 0n);
    const rows: Draft[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      if (ramping) {
        level = (level * 115n) / 100n; // ~+15%/week ramp
        if (level >= (base * 3n) / 2n) {
          base = (base * 3n) / 2n; // plateau: mean-revert around 1.5× base
          level = base;
          ramping = false;
        }
      } else {
        level = (level * 3n + base) / 4n; // mean-reverting drift toward base
      }
      level =
        arch.process === "stable-lowvol" ? jitter(prng, level, 970n, 61n) : jitter(prng, level, 920n, 161n);
      let feesUsd = level;
      if (burstDenom > 0n && prng.nextBigintBelow(burstDenom) === 0n) {
        feesUsd *= 3n + prng.nextBigintBelow(10n); // ×3–12 burst week
      }
      if (arch.process === "regime") {
        if (prng.nextBigintBelow(10n) === 0n) regimeHigh = !regimeHigh;
        if (regimeHigh) feesUsd *= 4n;
      }
      feesUsd *= marketMul[e]!;
      let bribesUsd = 0n;
      if (arch.baseBribesUsd > 0n && prng.nextBigintBelow(arch.bribeEveryN) !== 0n) {
        bribesUsd = jitter(prng, arch.baseBribesUsd * WAD, 800n, 401n);
      }
      const votes = (prevRevenue * VOTES_PER_REVENUE_USD * (700n + prng.nextBigintBelow(601n))) / 1_000n;
      prevRevenue = feesUsd + bribesUsd;
      rows.push({ feesUsd, bribesUsd, votes });
    }
    drafts.push(rows);
  }

  // -- pass 2: emissions pro-rata votes of a frozen global weekly budget ------
  // The budget is a pure function of the selected roster (its steady-state
  // revenue × the empirical votes and emissions ratios), frozen across epochs.
  let weeklyBudget = 0n;
  for (let p = 0; p < poolCount; p += 1) {
    const arch = ROSTER[p]!;
    weeklyBudget +=
      ((arch.baseFeesUsd + arch.baseBribesUsd) * WAD * VOTES_PER_REVENUE_USD * EMISSIONS_PER_VOTE_MICRO) /
      1_000_000n;
  }
  const totalVotes: bigint[] = new Array<bigint>(epochCount).fill(0n);
  for (let e = 0; e < epochCount; e += 1) {
    for (let p = 0; p < poolCount; p += 1) totalVotes[e] = totalVotes[e]! + drafts[p]![e]!.votes;
  }

  const pools: PoolRecord[] = [];
  for (let p = 0; p < poolCount; p += 1) {
    const arch = ROSTER[p]!;
    const epochs: EpochRecord[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      const { feesUsd, bribesUsd, votes } = drafts[p]![e]!;
      const weeklyEmissions =
        totalVotes[e]! > 0n ? (weeklyBudget * votes) / totalVotes[e]! : 0n;
      const epoch: EpochRecord = {
        ts: startTs + e * WEEK,
        votes: votes.toString(),
        // per-second Wad rate, exactly as sugar reports emissions
        emissions: (weeklyEmissions / BigInt(WEEK)).toString(),
        feesUsd: feesUsd.toString(),
        bribes: bribesUsd > 0n ? [{ token: SYNTHETIC_QUOTE_TOKEN, amount: bribesUsd.toString() }] : [],
        fees: [{ token: SYNTHETIC_QUOTE_TOKEN, amount: feesUsd.toString() }],
      };
      // invariant: feesUsd === Σ fees and bribesUsd === Σ bribes, exactly,
      // so revenue.ts's single-quote-token fallback agrees with the USD path
      if (bribesUsd > 0n) epoch.bribesUsd = bribesUsd.toString();
      epochs.push(epoch);
    }
    pools.push({
      // zero-padded so lexicographic address order == roster index order
      // (buildRun sorts addresses for washBait/static-crowd targeting)
      address: `sim:pool-${pad(p)}`,
      symbol: arch.name,
      displayName: arch.name,
      token0: `0x000000000000000000000000000000000000${pad(p)}1`,
      token1: SYNTHETIC_QUOTE_TOKEN,
      stable: arch.stable,
      ...(arch.tickSpacing !== undefined ? { tickSpacing: arch.tickSpacing } : {}),
      gaugeAlive: true,
      epochs,
    });
  }

  return {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: "1970-01-01T00:00:00.000Z", // fixed: dataset is a pure function of config
    source: "synthetic",
    pools,
  };
}
