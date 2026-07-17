/**
 * Seeded synthetic scenario generator. Emits the same DatasetV1 schema the
 * sugar indexer produces, so the backtester consumes real and synthetic
 * data interchangeably. Entirely bigint + seeded PRNG — deterministic and
 * fixture-safe (no floats anywhere).
 *
 * Calibration constants (documented approximations of empirical Aerodrome
 * weekly pool fee distributions for the top-30 pools, mid-2025 reads):
 * - Base weekly fees are log-uniform-ish across pools: $1k × 2^k for
 *   k ∈ [0, 10), i.e. ~$1k to ~$512k per week.
 * - persistent: multiplicative weekly drift uniform in [0.90, 1.10].
 * - bursty: persistent plus a Poisson-like burst overlay — each epoch has a
 *   1/10 chance of a 5× revenue burst (wash-trading / incident weeks).
 * - regime-switching: 2-state Markov chain, P(stay) = 9/10 per epoch; the
 *   high state multiplies revenue 4× (meta rotations, incentive programs).
 * Every draw uses integer arithmetic on the seeded xoshiro256** stream.
 */

import { WAD } from "../math/fixed.js";
import { createPrng } from "../math/prng.js";
import { epochStart, WEEK } from "../model/types.js";
import type { DatasetV1, EpochRecord, PoolRecord } from "./schema.js";

/** Synthetic fee process families. */
export type SyntheticProcessKind = "persistent" | "bursty" | "regime";

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

/** Synthetic quote token used for all fee amounts (single-token datasets sum exactly). */
export const SYNTHETIC_QUOTE_TOKEN = "0x00000000000000000000000000000000000000f0";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Generates a deterministic synthetic dataset in the v1 schema. */
export function generateSyntheticDataset(config: SyntheticConfig): DatasetV1 {
  const { seed, poolCount, epochCount, kind } = config;
  if (poolCount <= 0 || epochCount <= 0) {
    throw new Error("generateSyntheticDataset: poolCount and epochCount must be positive");
  }
  const startTs = epochStart(config.startTs ?? 1_735_171_200);
  const prng = createPrng(seed);

  const pools: PoolRecord[] = [];
  for (let p = 0; p < poolCount; p += 1) {
    // Base weekly fees: $1k × 2^k, k in [0, 10) — heavy-tailed across pools.
    const base = 1_000n * WAD * (1n << prng.nextBigintBelow(10n));
    let level = base;
    let regimeHigh = prng.nextBigintBelow(4n) === 0n; // 25% start in high state
    const epochs: EpochRecord[] = [];
    for (let e = 0; e < epochCount; e += 1) {
      // persistent drift: ×(900..1100)/1000 each week.
      level = (level * (900n + prng.nextBigintBelow(201n))) / 1_000n;
      let revenue = level;
      if (kind === "bursty") {
        // Poisson-like burst overlay: 1/10 chance of a 5x week.
        if (prng.nextBigintBelow(10n) === 0n) revenue *= 5n;
      } else if (kind === "regime") {
        // 2-state Markov: switch with prob 1/10; high state is 4x.
        if (prng.nextBigintBelow(10n) === 0n) regimeHigh = !regimeHigh;
        if (regimeHigh) revenue *= 4n;
      }
      // Votes loosely follow last week's revenue (a lagged crowd), plus noise.
      const votes = revenue / 100n + prng.nextBigintBelow(WAD);
      epochs.push({
        ts: startTs + e * WEEK,
        votes: votes.toString(),
        emissions: (WAD / 10n).toString(),
        feesUsd: revenue.toString(),
        bribes: [],
        fees: [{ token: SYNTHETIC_QUOTE_TOKEN, amount: revenue.toString() }],
      });
    }
    pools.push({
      address: `sim:pool-${pad(p)}`,
      symbol: `vAMM-SIM${pad(p)}/QUOTE`,
      displayName: `vAMM-SIM${pad(p)}/QUOTE`,
      token0: `0x000000000000000000000000000000000000${pad(p)}1`,
      token1: SYNTHETIC_QUOTE_TOKEN,
      stable: false,
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
