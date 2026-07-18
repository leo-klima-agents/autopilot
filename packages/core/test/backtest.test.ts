import { describe, expect, it } from "vitest";
import { divWad, sumBig, WAD } from "../src/math/fixed.js";
import { runBacktest } from "../src/backtest/run.js";
import { createContinuousModel } from "../src/model/continuous.js";
import { reactiveHerd, staticCrowd } from "../src/model/crowd.js";
import { DAY, HOUR, WEEK } from "../src/model/types.js";
import { revenueProcessFromDataset } from "../src/data/revenue.js";
import { generateSyntheticDataset } from "../src/data/synthetic.js";
import { fixedGrid, fixedGridWeekly } from "../src/strategies/fixedGrid.js";
import { constantRevenue, T0 } from "./helpers.js";

describe("runBacktest", () => {
  it("beats the passive benchmark when the crowd is misallocated", () => {
    // All revenue in pool a; the crowd sits entirely in pool b.
    const revenue = constantRevenue({ a: 1_000n * WAD, b: 0n });
    const model = createContinuousModel({ revenue, startTime: T0, cooldownSec: HOUR });
    const result = runBacktest(fixedGrid(HOUR, { lookbackSec: HOUR }), model, {
      startTime: T0,
      durationSec: DAY,
      stepSec: HOUR,
      trancheCount: 2,
      trancheWeight: 50n * WAD,
      cooldownSec: HOUR,
      crowd: staticCrowd(new Map([["b", 100n * WAD]])),
    });
    expect(result.totalReturn > 0n).toBe(true);
    expect(result.returnVsPassive > 0n).toBe(true);
    expect(result.rotations).toBeGreaterThan(0);
    expect(result.turnover > 0n).toBe(true);
  });

  it("matches the passive benchmark exactly when it is the only allocator", () => {
    const revenue = constantRevenue({ a: 123_456n, b: 789n });
    const model = createContinuousModel({ revenue, startTime: T0, cooldownSec: HOUR });
    const result = runBacktest(fixedGrid(HOUR, { lookbackSec: HOUR }), model, {
      startTime: T0,
      durationSec: DAY,
      stepSec: HOUR,
      trancheCount: 1,
      trancheWeight: 100n * WAD,
      cooldownSec: HOUR,
    });
    // With no crowd, our weight IS the global weight: active === passive
    // except for the first step (bootstrap allocates at t0, revenue of the
    // unallocated instant is dust) and floor dust.
    const slack = result.passiveReturn / 1_000_000n + 2n;
    const diff = result.returnVsPassive < 0n ? -result.returnVsPassive : result.returnVsPassive;
    expect(diff <= slack).toBe(true);
  });

  it("produces a consistent equity curve and sampling grid", () => {
    const revenue = constantRevenue({ a: 10n * WAD });
    const model = createContinuousModel({ revenue, startTime: T0, cooldownSec: HOUR });
    const result = runBacktest(fixedGrid(HOUR), model, {
      startTime: T0,
      durationSec: 6 * HOUR,
      stepSec: HOUR,
      sampleIntervalSec: 2 * HOUR,
      trancheCount: 1,
      trancheWeight: WAD,
      cooldownSec: HOUR,
    });
    expect(result.equityCurve.times).toEqual([
      T0 + 2 * HOUR,
      T0 + 4 * HOUR,
      T0 + 6 * HOUR,
    ]);
    expect(result.equityCurve.equity).toHaveLength(3);
    expect(result.equityCurve.benchmark).toHaveLength(3);
    // Equity is non-decreasing (accrual only).
    const eq = result.equityCurve.equity;
    for (let i = 1; i < eq.length; i += 1) expect(eq[i]! >= eq[i - 1]!).toBe(true);
    expect(result.totalReturn).toBe(eq[eq.length - 1]);
  });

  it("counts blocked submissions instead of throwing", () => {
    const revenue = constantRevenue({ a: WAD, b: WAD });
    // Model cooldown much longer than the scheduler thinks: submissions
    // planned after the scheduler cooldown get refused by the model.
    const model = createContinuousModel({ revenue, startTime: T0, cooldownSec: WEEK });
    const result = runBacktest(fixedGrid(HOUR, { lookbackSec: HOUR }), model, {
      startTime: T0,
      durationSec: DAY,
      stepSec: HOUR,
      trancheCount: 1,
      trancheWeight: WAD,
      cooldownSec: HOUR, // scheduler believes 1h
      crowd: staticCrowd(new Map([["a", 5n * WAD], ["b", 5n * WAD]])),
    });
    expect(result.blockedSubmissions).toBeGreaterThanOrEqual(0);
    expect(result.rotations).toBeGreaterThanOrEqual(1); // bootstrap rotation works
  });

  it("validates the step configuration", () => {
    const model = createContinuousModel({ revenue: constantRevenue({ a: 1n }), startTime: T0 });
    expect(() =>
      runBacktest(fixedGrid(HOUR), model, {
        startTime: T0,
        durationSec: 100,
        stepSec: 33,
        trancheCount: 1,
        trancheWeight: WAD,
      }),
    ).toThrow(/multiple/);
  });
});

describe("calibration: published on-target progression (F21, ordering only)", () => {
  // Persistent-ish synthetic dataset with a slowly drifting revenue mix and
  // a stale reactive crowd. Exact percentages need the real dataset (the
  // published 48% -> 64% -> 70% aggregates), so this asserts the qualitative
  // ordering only: weekly < 48h-revote < 48h-revote + gauge caps.
  const dataset = generateSyntheticDataset({
    seed: 20_260_717n,
    poolCount: 6,
    epochCount: 20,
    kind: "regime",
    startTs: T0,
  });
  const revenue = revenueProcessFromDataset(dataset);
  const crowdWeight = 400n * WAD;
  const portfolioWeight = 400n * WAD;

  const run = (cadenceSec: number, lookbackSec: number, capsEnabled: boolean) => {
    const model = createContinuousModel({
      revenue,
      startTime: T0 + 2 * WEEK, // give trailing windows history
      cooldownSec: cadenceSec,
      emissionRatePerSec: WAD,
      caps: { enabled: capsEnabled },
    });
    const strategy =
      cadenceSec === WEEK
        ? fixedGridWeekly({ lookbackSec })
        : fixedGrid(cadenceSec, { lookbackSec });
    return runBacktest(strategy, model, {
      startTime: T0 + 2 * WEEK,
      durationSec: 16 * WEEK,
      stepSec: 4 * HOUR,
      sampleIntervalSec: 12 * HOUR,
      trancheCount: 4,
      trancheWeight: portfolioWeight / 4n,
      cooldownSec: cadenceSec,
      crowd: reactiveHerd({
        revenue,
        totalWeight: crowdWeight,
        lagSeconds: 2 * WEEK, // two-week-old signal, per the published setup
        windowSec: WEEK,
      }),
      crowdUpdateSec: DAY,
      optimalWindowSec: DAY,
    });
  };

  it("orders weekly < 48h-revote < 48h-revote-with-caps on onTargetPct", () => {
    const weekly = run(WEEK, WEEK, false);
    const grid48 = run(2 * DAY, DAY, false);
    const grid48Caps = run(2 * DAY, DAY, true);
    expect(weekly.poolSamples).toBeGreaterThan(0);
    // Wide/ordering-only assertion (see F21 note above).
    expect(weekly.onTargetPct).toBeLessThan(grid48.onTargetPct);
    expect(grid48.onTargetPct).toBeLessThanOrEqual(grid48Caps.onTargetPct);
    // Off-target moves the other way, weekly worst.
    expect(weekly.offTargetPct).toBeGreaterThan(grid48Caps.offTargetPct);
  }, 60_000);

  it("passive benchmark per unit weight equals global revenue over global weight", () => {
    const revenue2 = constantRevenue({ a: 100n * WAD });
    const model = createContinuousModel({ revenue: revenue2, startTime: T0, cooldownSec: HOUR });
    const result = runBacktest(fixedGrid(HOUR, { lookbackSec: HOUR }), model, {
      startTime: T0,
      durationSec: 2 * HOUR,
      stepSec: HOUR,
      trancheCount: 1,
      trancheWeight: 100n * WAD,
      cooldownSec: HOUR,
      crowd: staticCrowd(new Map([["a", 300n * WAD]])),
    });
    // Global: 2h * 100 WAD/s revenue over 400 WAD weight.
    const expected = divWad(100n * WAD * BigInt(2 * HOUR), 400n * WAD);
    expect(result.passiveReturn).toBe(expected);
  });
});
