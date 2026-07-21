/** Pure display-layer helpers behind the RevenueHistogram and the shared
 *  pool-row ordering: end-of-run totals extraction, the deterministic sort
 *  permutation, and the axis step. */
import { describe, expect, it } from "vitest";
import { niceStep, poolOrderByRevenue, poolTotals } from "../src/lib/poolSummary.js";
import type { DisplayResult } from "../src/lib/serialize.js";

function alloc(overrides: Partial<DisplayResult["allocation"]>): DisplayResult["allocation"] {
  return {
    times: [0, 1],
    pools: ["a", "b", "c"],
    poolNames: ["vAMM-A/B", "vAMM-C/D", "vAMM-E/F"],
    weights: [],
    earned: [
      [1, 2, 3],
      [10, 20, 30],
    ],
    marketBenchmarkWeights: [],
    marketBenchmarkEarned: [
      [1, 1, 1],
      [5, 15, 25],
    ],
    revenueBenchmarkWeights: [],
    revenueBenchmarkEarned: [
      [2, 2, 2],
      [40, 25, 35],
    ],
    ...overrides,
  };
}

describe("poolTotals", () => {
  it("takes the last cumulative row of each portfolio", () => {
    const totals = poolTotals(alloc({}));
    expect(totals.strategy).toEqual([10, 20, 30]);
    expect(totals.market).toEqual([5, 15, 25]);
    expect(totals.revenue).toEqual([40, 25, 35]);
  });

  it("is empty-safe and pads short rows with zeros", () => {
    const totals = poolTotals(alloc({ earned: [], marketBenchmarkEarned: [[7]], revenueBenchmarkEarned: [[]] }));
    expect(totals.strategy).toEqual([0, 0, 0]);
    expect(totals.market).toEqual([7, 0, 0]);
    expect(totals.revenue).toEqual([0, 0, 0]);
  });
});

describe("poolOrderByRevenue", () => {
  it("sorts descending by the pool's largest total across portfolios", () => {
    const totals = poolTotals(alloc({}));
    // keys: max(10,5,40)=40, max(20,15,25)=25, max(30,25,35)=35
    expect(poolOrderByRevenue(totals, ["vAMM-A/B", "vAMM-C/D", "vAMM-E/F"])).toEqual([0, 2, 1]);
  });

  it("breaks ties by pool name for a deterministic order", () => {
    const totals = { strategy: [1, 1, 1], market: [1, 1, 1], revenue: [1, 1, 1] };
    expect(poolOrderByRevenue(totals, ["zulu", "alpha", "mike"])).toEqual([1, 2, 0]);
  });

  it("handles empty inputs", () => {
    expect(poolOrderByRevenue({ strategy: [], market: [], revenue: [] }, [])).toEqual([]);
  });
});

describe("niceStep", () => {
  it("picks 1/2/5 × 10ᵏ steps that cover max within the tick budget", () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(97, 5)).toBe(20);
    expect(niceStep(1_000_000, 4)).toBe(500_000);
    expect(niceStep(30, 4)).toBe(10);
  });

  it("degrades safely on empty or non-positive domains", () => {
    expect(niceStep(0, 4)).toBe(1);
    expect(niceStep(-5, 4)).toBe(1);
    expect(niceStep(10, 0)).toBe(1);
  });
});
