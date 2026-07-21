/** poolTotals extracts end-of-run cumulative rows; poolOrderByRevenue gives a
 *  stable descending permutation with a name tie-break. */
import { describe, expect, it } from "vitest";
import { poolOrderByRevenue, poolTotals } from "../src/lib/poolSummary.js";
import type { DisplayResult } from "../src/lib/serialize.js";

function alloc(overrides: Partial<DisplayResult["allocation"]>): DisplayResult["allocation"] {
  return {
    times: [0, 1],
    pools: ["a", "b", "c"],
    poolNames: ["A", "B", "C"],
    weights: [],
    earned: [
      [1, 2, 3],
      [10, 20, 30],
    ],
    marketBenchmarkWeights: [],
    marketBenchmarkEarned: [
      [0, 0, 0],
      [5, 6, 7],
    ],
    revenueBenchmarkWeights: [],
    revenueBenchmarkEarned: [
      [0, 0, 0],
      [40, 50, 60],
    ],
    ...overrides,
  };
}

describe("poolTotals", () => {
  it("returns the last cumulative row of each series", () => {
    expect(poolTotals(alloc({}))).toEqual({
      strategy: [10, 20, 30],
      market: [5, 6, 7],
      revenue: [40, 50, 60],
    });
  });

  it("is empty-safe: no samples yields all-zero totals per pool", () => {
    const totals = poolTotals(
      alloc({ earned: [], marketBenchmarkEarned: [], revenueBenchmarkEarned: [] }),
    );
    expect(totals).toEqual({ strategy: [0, 0, 0], market: [0, 0, 0], revenue: [0, 0, 0] });
  });

  it("pads short rows with zeros", () => {
    const totals = poolTotals(alloc({ earned: [[7]] }));
    expect(totals.strategy).toEqual([7, 0, 0]);
  });
});

describe("poolOrderByRevenue", () => {
  it("sorts descending by total", () => {
    expect(poolOrderByRevenue([1, 3, 2], ["A", "B", "C"])).toEqual([1, 2, 0]);
  });

  it("breaks ties by pool name", () => {
    expect(poolOrderByRevenue([5, 5, 9], ["Zed", "Alpha", "Mid"])).toEqual([2, 1, 0]);
  });

  it("handles empty input", () => {
    expect(poolOrderByRevenue([], [])).toEqual([]);
  });
});
