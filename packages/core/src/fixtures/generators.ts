/**
 * Differential fixture generators. Each family produces a seeded,
 * deterministic set of input/expected vectors — bigints as decimal strings
 * after serialization — that the Solidity twin replays and asserts EXACT
 * equality against (P2). Adversarial edges included per family: zero
 * weights, single pool, magnitudes up to 1e30, dust rounding.
 */

import { minBig, mulDiv, sumBig, WAD } from "../math/fixed.js";
import { createPrng, type Prng } from "../math/prng.js";
import { splitProportionally } from "../math/split.js";
import type { PoolId, Wad } from "../model/types.js";
import { plan, type TrancheState } from "../scheduler/scheduler.js";
import { waterFill, WATER_FILL_SCALE } from "../strategies/waterFilling.js";
import type { FixtureFile } from "./serialize.js";

/** Adversarial magnitude bound used across families. */
export const MAX_MAGNITUDE = 10n ** 30n;

// ---------------------------------------------------------------------------
// Pro-rata revenue vectors
// ---------------------------------------------------------------------------

/** Pro-rata case: poolReward split by weights; floor payouts, dust tracked. */
export interface ProRataCase {
  name: string;
  inputs: { poolReward: bigint; weights: bigint[] };
  expected: { payouts: bigint[]; dust: bigint };
}

function proRataExpected(poolReward: bigint, weights: readonly bigint[]): ProRataCase["expected"] {
  const total = sumBig(weights);
  if (total === 0n) {
    return { payouts: weights.map(() => 0n), dust: poolReward };
  }
  const payouts = weights.map((w) => mulDiv(poolReward, w, total));
  return { payouts, dust: poolReward - sumBig(payouts) };
}

/** Builds the pro-rata revenue fixture family (~120 cases). */
export function buildProRataFixtures(seed: bigint): FixtureFile<ProRataCase> {
  const prng = createPrng(seed);
  const cases: ProRataCase[] = [];
  const push = (name: string, poolReward: bigint, weights: bigint[]): void => {
    cases.push({ name, inputs: { poolReward, weights }, expected: proRataExpected(poolReward, weights) });
  };

  push("zero-reward", 0n, [WAD, WAD]);
  push("zero-total-weight", WAD, [0n, 0n, 0n]);
  push("single-pool-takes-all", 123_456_789n, [WAD]);
  push("one-wei-reward-two-weights", 1n, [1n, 1n]);
  push("dust-thirds", 100n, [1n, 1n, 1n]);
  push("max-magnitude", MAX_MAGNITUDE, [MAX_MAGNITUDE, 1n, MAX_MAGNITUDE - 1n]);
  push("mixed-zero-weights", 10n ** 18n, [0n, 5n, 0n, 7n]);
  push("tiny-weights-huge-reward", MAX_MAGNITUDE, [1n, 2n, 3n]);

  for (let i = 0; i < 112; i += 1) {
    const n = 1 + prng.nextIntBelow(8);
    const weights: bigint[] = [];
    for (let j = 0; j < n; j += 1) {
      // ~1 in 5 weights are zero to exercise dust paths.
      weights.push(prng.nextIntBelow(5) === 0 ? 0n : prng.nextBigintBelow(MAX_MAGNITUDE));
    }
    const poolReward = prng.nextBigintBelow(MAX_MAGNITUDE);
    push(`random-${String(i).padStart(3, "0")}`, poolReward, weights);
  }
  return { name: "pro-rata-revenue", cases };
}

// ---------------------------------------------------------------------------
// Cap / burn vectors
// ---------------------------------------------------------------------------

/**
 * Cap/burn case, mirroring the ContinuousModel exactly:
 *   capRate       = mulDiv(kappaWad, trailingRevenue / windowSec, WAD)
 *   effectiveRate = min(allocatedRate, capRate)
 *   emitted  = allocatedRate * dt ; streamed = effectiveRate * dt
 *   burned   = emitted - streamed  (conservation: streamed + burned == emitted)
 */
export interface CapBurnCase {
  name: string;
  inputs: {
    allocatedRatePerSec: bigint;
    trailingRevenue: bigint;
    windowSec: number;
    kappaWad: bigint;
    dtSec: number;
  };
  expected: {
    capRate: bigint;
    effectiveRate: bigint;
    emitted: bigint;
    streamed: bigint;
    burned: bigint;
  };
}

function capBurnExpected(inputs: CapBurnCase["inputs"]): CapBurnCase["expected"] {
  const trailingRate = inputs.trailingRevenue / BigInt(inputs.windowSec);
  const capRate = mulDiv(inputs.kappaWad, trailingRate, WAD);
  const effectiveRate = minBig(inputs.allocatedRatePerSec, capRate);
  const dt = BigInt(inputs.dtSec);
  const emitted = inputs.allocatedRatePerSec * dt;
  const streamed = effectiveRate * dt;
  return { capRate, effectiveRate, emitted, streamed, burned: emitted - streamed };
}

/** Builds the cap/burn fixture family (~100 cases). */
export function buildCapBurnFixtures(seed: bigint): FixtureFile<CapBurnCase> {
  const prng = createPrng(seed);
  const kappa = 1_200_000_000_000_000_000n; // κ = 1.2 (placeholder per F14)
  const cases: CapBurnCase[] = [];
  const push = (name: string, inputs: CapBurnCase["inputs"]): void => {
    cases.push({ name, inputs, expected: capBurnExpected(inputs) });
  };

  push("zero-revenue-all-burned", {
    allocatedRatePerSec: WAD,
    trailingRevenue: 0n,
    windowSec: 172_800,
    kappaWad: kappa,
    dtSec: 3_600,
  });
  push("uncapped-under-cap", {
    allocatedRatePerSec: WAD,
    trailingRevenue: WAD * 172_800n * 10n,
    windowSec: 172_800,
    kappaWad: kappa,
    dtSec: 172_800,
  });
  push("exactly-at-cap", {
    allocatedRatePerSec: mulDiv(kappa, WAD, WAD),
    trailingRevenue: WAD * 172_800n,
    windowSec: 172_800,
    kappaWad: kappa,
    dtSec: 1,
  });
  push("kappa-zero-deactivated-gauge", {
    allocatedRatePerSec: WAD,
    trailingRevenue: WAD * 172_800n,
    windowSec: 172_800,
    kappaWad: 0n,
    dtSec: 60,
  });
  push("sub-second-rate-floors-to-zero", {
    allocatedRatePerSec: 5n,
    trailingRevenue: 172_799n,
    windowSec: 172_800,
    kappaWad: kappa,
    dtSec: 172_800,
  });
  push("max-magnitude", {
    allocatedRatePerSec: MAX_MAGNITUDE,
    trailingRevenue: MAX_MAGNITUDE,
    windowSec: 1,
    kappaWad: kappa,
    dtSec: 604_800,
  });

  const windows = [3_600, 86_400, 172_800, 604_800];
  const kappas = [kappa, WAD, WAD / 2n, 2n * WAD];
  for (let i = 0; i < 94; i += 1) {
    push(`random-${String(i).padStart(3, "0")}`, {
      allocatedRatePerSec: prng.nextBigintBelow(MAX_MAGNITUDE),
      trailingRevenue: prng.nextBigintBelow(MAX_MAGNITUDE),
      windowSec: windows[prng.nextIntBelow(windows.length)]!,
      kappaWad: kappas[prng.nextIntBelow(kappas.length)]!,
      dtSec: 1 + prng.nextIntBelow(604_800),
    });
  }
  return { name: "cap-burn", cases };
}

// ---------------------------------------------------------------------------
// Water-filling vectors
// ---------------------------------------------------------------------------

/** Water-filling case: exact allocator output for (R, W, budget). */
export interface WaterFillingCase {
  name: string;
  inputs: { R: bigint[]; W: bigint[]; budget: bigint; scale: bigint };
  expected: { weights: bigint[]; lambda: bigint; iterations: number };
}

/** Builds the water-filling fixture family (~64 cases). */
export function buildWaterFillingFixtures(seed: bigint): FixtureFile<WaterFillingCase> {
  const prng = createPrng(seed);
  const cases: WaterFillingCase[] = [];
  const push = (name: string, R: bigint[], W: bigint[], budget: bigint): void => {
    const expected = waterFill(R, W, budget, WATER_FILL_SCALE);
    cases.push({
      name,
      inputs: { R, W, budget, scale: WATER_FILL_SCALE },
      expected: {
        weights: expected.weights,
        lambda: expected.lambda,
        iterations: expected.iterations,
      },
    });
  };

  push("single-pool", [WAD], [WAD], WAD);
  push("zero-budget", [WAD, WAD], [WAD, WAD], 0n);
  push("zero-revenue-everywhere", [0n, 0n, 0n], [WAD, WAD, WAD], WAD);
  push("zero-external-weight", [WAD, WAD], [0n, WAD], WAD);
  push("symmetric-two-pools", [WAD, WAD], [WAD, WAD], 2n * WAD);
  push("dominant-pool", [1_000n * WAD, WAD], [WAD, WAD], 10n * WAD);
  push(
    "max-magnitude",
    [MAX_MAGNITUDE, MAX_MAGNITUDE / 2n, 1n],
    [MAX_MAGNITUDE, 1n, MAX_MAGNITUDE],
    MAX_MAGNITUDE,
  );

  for (let i = 0; i < 57; i += 1) {
    const n = 1 + prng.nextIntBelow(6);
    const R: bigint[] = [];
    const W: bigint[] = [];
    for (let j = 0; j < n; j += 1) {
      R.push(prng.nextIntBelow(6) === 0 ? 0n : prng.nextBigintBelow(MAX_MAGNITUDE));
      W.push(prng.nextIntBelow(6) === 0 ? 0n : prng.nextBigintBelow(MAX_MAGNITUDE));
    }
    push(`random-${String(i).padStart(3, "0")}`, R, W, prng.nextBigintBelow(MAX_MAGNITUDE));
  }
  return { name: "water-filling", cases };
}

// ---------------------------------------------------------------------------
// Cooldown-scheduler transition vectors
// ---------------------------------------------------------------------------

/** Serializable tranche snapshot. */
export interface SchedulerFixtureTranche {
  id: string;
  positionWeight: bigint;
  lastActionAt: number;
  allocation: Map<PoolId, Wad>;
}

/** Serializable expected action. */
export type SchedulerFixtureAction =
  | { kind: "rotate"; trancheId: string; allocation: Map<PoolId, Wad> }
  | { kind: "wait"; trancheId: string; until: number };

/** Scheduler transition case: (states, target, now) -> expected actions. */
export interface SchedulerCase {
  name: string;
  inputs: {
    tranches: SchedulerFixtureTranche[];
    target: Map<PoolId, Wad>;
    now: number;
    cooldownSec: number;
  };
  expected: { actions: SchedulerFixtureAction[] };
}

function randomAllocation(prng: Prng, pools: readonly PoolId[]): Map<PoolId, Wad> {
  const scores = new Map<PoolId, Wad>();
  for (const pool of pools) {
    scores.set(pool, prng.nextIntBelow(4) === 0 ? 0n : prng.nextBigintBelow(WAD));
  }
  return splitProportionally(WAD, scores);
}

/** Builds the cooldown-scheduler fixture family (~60 cases). */
export function buildSchedulerFixtures(seed: bigint): FixtureFile<SchedulerCase> {
  const prng = createPrng(seed);
  const cases: SchedulerCase[] = [];
  const push = (
    name: string,
    tranches: SchedulerFixtureTranche[],
    target: Map<PoolId, Wad>,
    now: number,
    cooldownSec: number,
  ): void => {
    const actions = plan(
      tranches.map<TrancheState>((tr) => ({ ...tr, allocation: new Map(tr.allocation) })),
      new Map(target),
      now,
      cooldownSec,
    );
    cases.push({
      name,
      inputs: { tranches, target, now, cooldownSec },
      expected: {
        actions: actions.map((a) =>
          a.kind === "rotate"
            ? { kind: "rotate", trancheId: a.trancheId, allocation: a.allocation }
            : { kind: "wait", trancheId: a.trancheId, until: a.until },
        ),
      },
    });
  };

  const pools: PoolId[] = ["pool-a", "pool-b", "pool-c", "pool-d"];
  const t0 = 1_735_171_200;
  const cd = 172_800;
  const uniform = splitProportionally(WAD, new Map(pools.map((p) => [p, 1n])));
  const concentrated = new Map<PoolId, Wad>([["pool-a", WAD]]);

  push("empty-tranche-list", [], uniform, t0, cd);
  push(
    "all-on-target-no-actions",
    [{ id: "t0", positionWeight: WAD, lastActionAt: t0 - cd, allocation: new Map(uniform) }],
    uniform,
    t0,
    cd,
  );
  push(
    "single-free-tranche-rotates",
    [{ id: "t0", positionWeight: WAD, lastActionAt: t0 - cd, allocation: new Map(concentrated) }],
    uniform,
    t0,
    cd,
  );
  push(
    "cooldown-boundary-exact",
    [
      { id: "t0", positionWeight: WAD, lastActionAt: t0 - cd, allocation: new Map(concentrated) },
      { id: "t1", positionWeight: WAD, lastActionAt: t0 - cd + 1, allocation: new Map(concentrated) },
    ],
    uniform,
    t0,
    cd,
  );
  push(
    "tie-distance-lowest-id-first",
    [
      { id: "t1", positionWeight: WAD, lastActionAt: t0 - cd, allocation: new Map(concentrated) },
      { id: "t0", positionWeight: WAD, lastActionAt: t0 - cd, allocation: new Map(concentrated) },
    ],
    uniform,
    t0,
    cd,
  );
  push(
    "zero-cooldown-always-free",
    [{ id: "t0", positionWeight: WAD, lastActionAt: t0, allocation: new Map() }],
    concentrated,
    t0,
    0,
  );

  for (let i = 0; i < 54; i += 1) {
    const count = 1 + prng.nextIntBelow(5);
    const tranches: SchedulerFixtureTranche[] = [];
    for (let j = 0; j < count; j += 1) {
      tranches.push({
        id: `t${j}`,
        positionWeight: WAD * BigInt(1 + prng.nextIntBelow(10)),
        lastActionAt: t0 - prng.nextIntBelow(2 * cd),
        // Some tranches start unallocated; some start exactly on a target-ish mix.
        allocation: prng.nextIntBelow(5) === 0 ? new Map() : randomAllocation(prng, pools),
      });
    }
    push(
      `random-${String(i).padStart(3, "0")}`,
      tranches,
      randomAllocation(prng, pools),
      t0 + prng.nextIntBelow(cd),
      cd,
    );
  }
  return { name: "cooldown-scheduler", cases };
}
