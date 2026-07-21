/** The presets make on-screen numeric promises (blurbs, Guide, Logbook):
 *  the early-allocator preset advertises ~1.4x capture on the growth pool
 *  and the cbBTC-backtest preset advertises the Sep 2024 - Mar 2025 window.
 *  These tests run the ACTUAL preset configs through buildAndRun — the same
 *  code path as the console — so a web-layer change that moves the shipped
 *  numbers fails here even while core's calibration tests stay green. */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAndRun } from "../src/lib/buildRun.js";
import { toDisplayResult } from "../src/lib/serialize.js";
import { PRESETS, type RunConfig } from "../src/lib/runConfig.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATASET_PATH = resolve(HERE, "../../../data/aerodrome-epochs.v1.json");

function preset(id: string): RunConfig {
  const found = PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`unknown preset: ${id}`);
  return found.config;
}

describe("preset promises", () => {
  it("early-allocator: the growth pool captures ~1.4x (the published band)", () => {
    const run = buildAndRun(preset("early-allocator"), null);
    const display = toDisplayResult(run);
    const growth = display.captures.find((c) => c.name === "CL100-USDC/cbBTC");
    expect(growth).toBeDefined();
    expect(growth!.multiple).not.toBeNull();
    // band, never the exact published 1.43 (seed-dependent)
    expect(growth!.multiple!).toBeGreaterThan(1.2);
    expect(growth!.multiple!).toBeLessThan(2);
    // the edge concentrates in the growth pool: above the rest's average
    const others = display.captures.filter((c) => c.name !== "CL100-USDC/cbBTC");
    const avg =
      others.reduce((acc, c) => acc + (c.multiple ?? 1), 0) / Math.max(1, others.length);
    expect(growth!.multiple!).toBeGreaterThan(avg);
  }, 60_000);

  it("cbbtc-backtest: the window is pinned to Sep 2024 - Mar 2025 on the committed dataset", () => {
    const dataset: unknown = JSON.parse(readFileSync(DATASET_PATH, "utf8"));
    const run = buildAndRun(preset("cbbtc-backtest"), dataset);
    const WEEK = 604_800;
    const windowEnd = run.startTime + run.durationSec;
    // end: Thu 2025-03-06 00:00 UTC; start: 26 weeks earlier (+2h distribute
    // clearance), the cbBTC launch epoch — refresh-proof by construction
    expect(windowEnd).toBe(1_741_219_200);
    expect(run.startTime).toBe(1_741_219_200 - 26 * WEEK + 2 * 3_600);
    // the cbBTC pools ramp inside this window: an early allocator reads
    // above the passive expectation on at least one cbBTC row
    const display = toDisplayResult(run);
    const cbbtc = display.captures.filter((c) => c.name.includes("cbBTC"));
    expect(cbbtc.length).toBeGreaterThan(0);
    expect(Math.max(...cbbtc.map((c) => c.multiple ?? 0))).toBeGreaterThan(1.1);
  }, 120_000);
});
