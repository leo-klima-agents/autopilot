/**
 * Golden backtest snapshots: each of the five strategies runs a fixed
 * synthetic scenario and its exact metrics (bigints as decimal strings) are
 * compared against committed JSON under test/golden/. Regenerate with
 * UPDATE_GOLDEN=1 pnpm --filter @aero-autopilot/core test
 * — but treat diffs as accounting changes needing review.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WAD } from "../src/math/fixed.js";
import { runBacktest, type BacktestResult } from "../src/backtest/run.js";
import { createContinuousModel } from "../src/model/continuous.js";
import { createEpochModel } from "../src/model/epoch.js";
import { reactiveHerd } from "../src/model/crowd.js";
import { DAY, HOUR, WEEK, type ProtocolModel } from "../src/model/types.js";
import { revenueProcessFromDataset } from "../src/data/revenue.js";
import { generateSyntheticDataset } from "../src/data/synthetic.js";
import { toJsonValue } from "../src/fixtures/serialize.js";
import { continuousGreedy } from "../src/strategies/continuousGreedy.js";
import { fixedGrid48h, fixedGridWeekly } from "../src/strategies/fixedGrid.js";
import { persistenceCarry } from "../src/strategies/persistenceCarry.js";
import { waterFilling } from "../src/strategies/waterFilling.js";
import type { Strategy } from "../src/strategies/types.js";
import { T0 } from "./helpers.js";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "golden");

/** The fixed synthetic scenario every strategy golden runs against. */
const dataset = generateSyntheticDataset({
  seed: 42n,
  poolCount: 4,
  epochCount: 8,
  kind: "persistent",
  startTs: T0,
});
const revenue = revenueProcessFromDataset(dataset);
const START = T0 + WEEK + HOUR + HOUR; // history for signals; clear of the distribute window
const crowd = reactiveHerd({ revenue, totalWeight: 100n * WAD, lagSeconds: WEEK, windowSec: WEEK });

function goldenPayload(result: BacktestResult): unknown {
  return toJsonValue({
    totalReturn: result.totalReturn,
    passiveReturn: result.passiveReturn,
    returnVsPassive: result.returnVsPassive,
    maxDrawdownVsBenchmark: result.maxDrawdownVsBenchmark,
    turnover: result.turnover,
    rotations: result.rotations,
    blockedSubmissions: result.blockedSubmissions,
    onTargetPct: result.onTargetPct,
    offTargetPct: result.offTargetPct,
    poolSamples: result.poolSamples,
    equityPoints: result.equityCurve.times.length,
    finalEquity: result.equityCurve.equity.at(-1) ?? 0n,
    finalBenchmark: result.equityCurve.benchmark.at(-1) ?? 0n,
  });
}

function checkGolden(name: string, result: BacktestResult): void {
  const path = join(GOLDEN_DIR, `${name}.json`);
  const actual = goldenPayload(result);
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, `${JSON.stringify(actual, null, 2)}\n`, "utf8");
  }
  expect(existsSync(path), `missing golden ${path} — run with UPDATE_GOLDEN=1`).toBe(true);
  const expected: unknown = JSON.parse(readFileSync(path, "utf8"));
  expect(actual).toEqual(expected);
}

function continuousBacktest(strategy: Strategy, cooldownSec: number): BacktestResult {
  const model: ProtocolModel = createContinuousModel({
    revenue,
    startTime: START,
    cooldownSec,
    emissionRatePerSec: WAD,
    caps: { enabled: true },
  });
  return runBacktest(strategy, model, {
    startTime: START,
    durationSec: 5 * WEEK,
    stepSec: HOUR,
    sampleIntervalSec: 12 * HOUR,
    trancheCount: 4,
    trancheWeight: 25n * WAD,
    cooldownSec,
    crowd,
    crowdUpdateSec: DAY,
    optimalWindowSec: DAY,
  });
}

describe("golden backtest snapshots (exact, committed)", () => {
  it("FixedGridWeekly on the v2 epoch model", () => {
    const model = createEpochModel({ revenue, startTime: START });
    const result = runBacktest(fixedGridWeekly({ lookbackSec: WEEK }), model, {
      startTime: START,
      durationSec: 5 * WEEK,
      stepSec: HOUR,
      sampleIntervalSec: 12 * HOUR,
      trancheCount: 4,
      trancheWeight: 25n * WAD,
      cooldownSec: WEEK,
      crowd,
      crowdUpdateSec: DAY,
      optimalWindowSec: DAY,
    });
    checkGolden("fixed-grid-weekly", result);
  });

  it("FixedGrid48h on the continuous model", () => {
    checkGolden("fixed-grid-48h", continuousBacktest(fixedGrid48h({ lookbackSec: DAY }), 2 * DAY));
  });

  it("PersistenceCarry on the continuous model", () => {
    checkGolden(
      "persistence-carry",
      continuousBacktest(persistenceCarry({ lookbackSec: WEEK, buckets: 7 }), 2 * DAY),
    );
  });

  it("WaterFilling on the continuous model", () => {
    checkGolden("water-filling", continuousBacktest(waterFilling({ lookbackSec: DAY }), 2 * DAY));
  });

  it("ContinuousGreedy on the continuous model", () => {
    checkGolden(
      "continuous-greedy",
      continuousBacktest(continuousGreedy({ cadenceSec: HOUR, lookbackSec: DAY }), HOUR),
    );
  });
});
