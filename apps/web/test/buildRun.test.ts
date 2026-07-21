/** Window anchoring: historical runs replay the LATEST complete weeks of the
 *  dataset (ending at its last complete epoch), never the oldest ones, and the
 *  still-in-progress epoch at indexing time is excluded. Synthetic runs keep
 *  their fixed start (the process is stationary and seeds must reproduce). */
import { describe, expect, it } from "vitest";
import { buildAndRun } from "../src/lib/buildRun.js";
import { toDisplayResult } from "../src/lib/serialize.js";
import { DEFAULT_RUN, type RunConfig } from "../src/lib/runConfig.js";

const WEEK = 604_800;
const HOUR = 3_600;
// Thu 2025-07-17 00:00:00 UTC, a real epoch flip boundary
const THURSDAY = 1_752_710_400;
const EPOCH_COUNT = 10;
const LAST_TS = THURSDAY + (EPOCH_COUNT - 1) * WEEK;

/** Minimal valid sugar-sourced dataset: 2 pools x 10 complete weekly epochs. */
function historicalDataset(generatedAt: string): unknown {
  const pool = (address: string, name: string, feeScale: number) => ({
    address,
    symbol: name,
    displayName: name,
    token0: "0x1111111111111111111111111111111111111111",
    token1: "0x2222222222222222222222222222222222222222",
    stable: false,
    gaugeAlive: true,
    epochs: Array.from({ length: EPOCH_COUNT }, (_, i) => ({
      // newest-first, like the real indexer output
      ts: LAST_TS - i * WEEK,
      votes: "1000000000000000000000",
      emissions: "10000000000000000000",
      bribes: [],
      fees: [],
      feesUsd: String(BigInt(feeScale) * 10n ** 18n * BigInt(EPOCH_COUNT - i)),
      bribesUsd: "0",
    })),
  });
  return {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt,
    source: "sugar",
    pools: [
      pool("0x3333333333333333333333333333333333333333", "vAMM-A/B", 100),
      pool("0x4444444444444444444444444444444444444444", "vAMM-C/D", 50),
    ],
  };
}

function historicalConfig(durationWeeks: number): RunConfig {
  return {
    ...DEFAULT_RUN,
    data: { kind: "historical" },
    run: { ...DEFAULT_RUN.run, durationWeeks },
  };
}

const completeAt = new Date((LAST_TS + WEEK) * 1000).toISOString(); // after the newest epoch ends
const partialAt = new Date((LAST_TS + 2 * 86_400) * 1000).toISOString(); // 2 days into it

describe("historical window anchoring", () => {
  it("a short run replays the LATEST weeks (window ends at dataset end)", () => {
    const run = buildAndRun(historicalConfig(2), historicalDataset(completeAt));
    const dataEnd = LAST_TS + WEEK;
    expect(run.startTime).toBe(dataEnd - 2 * WEEK + 2 * HOUR);
    expect(run.startTime + run.durationSec).toBe(dataEnd);
  });

  it("excludes the in-progress epoch when generatedAt falls inside it", () => {
    const run = buildAndRun(historicalConfig(2), historicalDataset(partialAt));
    // effective end = start of the partial epoch (last COMPLETE epoch's end)
    expect(run.startTime).toBe(LAST_TS - 2 * WEEK + 2 * HOUR);
    expect(run.startTime + run.durationSec).toBe(LAST_TS);
  });

  it("clamps to the earliest start when more weeks are requested than exist", () => {
    const run = buildAndRun(historicalConfig(500), historicalDataset(completeAt));
    expect(run.startTime).toBe(THURSDAY + WEEK + 2 * HOUR); // one week kept for signals
    expect(run.startTime + run.durationSec).toBe(LAST_TS + WEEK);
  });

  it("synthetic runs keep the fixed start (stationary process, reproducible seeds)", () => {
    const short = buildAndRun({ ...DEFAULT_RUN, run: { ...DEFAULT_RUN.run, durationWeeks: 2 } }, null);
    const long = buildAndRun({ ...DEFAULT_RUN, run: { ...DEFAULT_RUN.run, durationWeeks: 4 } }, null);
    expect(short.startTime).toBe(long.startTime);
    expect(short.result.equityCurve.times[0]).toBe(long.result.equityCurve.times[0]);
  });
});

describe("revenueUnit", () => {
  it("synthetic runs report USD (the archetypes are dollar-calibrated)", () => {
    const run = buildAndRun(DEFAULT_RUN, null);
    expect(run.revenueUnit).toBe("usd");
    expect(run.dataKind).toBe("synthetic");
  });

  it("priced historical runs report USD", () => {
    const run = buildAndRun(historicalConfig(2), historicalDataset(completeAt));
    expect(run.revenueUnit).toBe("usd");
  });

  it("unpriced datasets fall back to index units", () => {
    const dataset = historicalDataset(completeAt) as {
      pools: { epochs: { feesUsd?: string; bribesUsd?: string; fees: unknown[] }[] }[];
    };
    for (const pool of dataset.pools) {
      for (const epoch of pool.epochs) {
        // raw fee amounts keep revenue nonzero once the USD fields are gone
        epoch.fees = [
          { token: "0x5555555555555555555555555555555555555555", amount: epoch.feesUsd! },
        ];
        delete epoch.feesUsd;
        delete epoch.bribesUsd;
      }
    }
    const run = buildAndRun(historicalConfig(2), dataset);
    expect(run.revenueUnit).toBe("index");
  });
});

describe("per-pool earned revenue passthrough", () => {
  it("earned matches the allocation grid dims and serializes to floats", () => {
    const run = buildAndRun(historicalConfig(2), historicalDataset(completeAt));
    const { times, pools, weights, earned } = run.result.allocationHistory;
    expect(earned).toHaveLength(times.length);
    expect(earned.every((row) => row.length === pools.length)).toBe(true);
    expect(weights).toHaveLength(times.length);
    for (const value of earned.at(-1)!) expect(value >= 0n).toBe(true);

    const display = toDisplayResult(run);
    expect(display.allocation.earned).toHaveLength(times.length);
    expect(display.allocation.earned.every((row) => row.length === pools.length)).toBe(true);
    expect(display.allocation.earned.flat().every((n) => typeof n === "number" && n >= 0)).toBe(true);
    // passive benchmark twin serializes on the same grid
    expect(display.allocation.marketBenchmarkWeights).toHaveLength(times.length);
    expect(display.allocation.marketBenchmarkEarned).toHaveLength(times.length);
    expect(display.allocation.marketBenchmarkWeights.every((row) => row.length === pools.length)).toBe(true);
    expect(display.allocation.marketBenchmarkEarned.flat().every((n) => typeof n === "number" && n >= 0)).toBe(true);
    // revenue (oracle) benchmark serializes on the same grid too
    expect(display.allocation.revenueBenchmarkWeights).toHaveLength(times.length);
    expect(display.allocation.revenueBenchmarkEarned).toHaveLength(times.length);
    expect(display.allocation.revenueBenchmarkWeights.every((row) => row.length === pools.length)).toBe(true);
    expect(display.equity.revenueBenchmark).toHaveLength(display.equity.times.length);
    expect(display.revenueBenchmarkReturn).toBeGreaterThanOrEqual(0);
  });
});
