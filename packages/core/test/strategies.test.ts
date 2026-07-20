import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isqrt, sumBig, WAD } from "../src/math/fixed.js";
import type { MarketState, TargetAllocation } from "../src/model/types.js";
import { WEEK } from "../src/model/types.js";
import type { TrancheState } from "../src/scheduler/scheduler.js";
import {
  continuousGreedy,
  marginalYield,
} from "../src/strategies/continuousGreedy.js";
import { fixedGrid, fixedGrid48h, fixedGridWeekly } from "../src/strategies/fixedGrid.js";
import {
  clampToMaxPoolWeightWad,
  normalizeToWad,
  VAULT_DEFAULT_MAX_POOL_WEIGHT_WAD,
} from "../src/strategies/normalize.js";
import {
  persistenceCarry,
  persistenceFactor,
} from "../src/strategies/persistenceCarry.js";
import { portfolioWeightOnPool, type Portfolio } from "../src/strategies/types.js";
import { waterFill, waterFilling, WATER_FILL_SCALE } from "../src/strategies/waterFilling.js";

/** Fake market state: cumulative revenue via constant per-second rates. */
function fakeState(
  rates: Record<string, bigint>,
  weights: Record<string, bigint>,
  now = 1_000_000_000,
): MarketState {
  const pools = Object.keys(rates);
  return {
    now,
    pools,
    trailingRevenue: (pool, windowSec) => (rates[pool] ?? 0n) * BigInt(windowSec),
    poolWeight: (pool) => weights[pool] ?? 0n,
    totalWeight: () => sumBig(Object.values(weights)),
  };
}

function makePortfolio(tranches: TrancheState[], cooldownSec = 172_800): Portfolio {
  return {
    tranches,
    totalWeight: sumBig(tranches.map((t) => t.positionWeight)),
    cooldownSec,
  };
}

const freeTranche = (id: string, weight = WAD): TrancheState => ({
  id,
  positionWeight: weight,
  lastActionAt: 0,
  allocation: new Map(),
});

function expectSumsToWad(target: TargetAllocation): void {
  expect(sumBig([...target.values()])).toBe(WAD);
}

describe("normalizeToWad", () => {
  it("always sums exactly to WAD (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.string({ minLength: 1, maxLength: 4 }), fc.bigInt({ min: 0n, max: 10n ** 30n })), {
          minLength: 1,
          maxLength: 8,
        }),
        (pairs) => {
          expectSumsToWad(normalizeToWad(new Map(pairs)));
        },
      ),
    );
  });
});

describe("fixedGrid", () => {
  it("allocates proportional to trailing revenue", () => {
    const strategy = fixedGridWeekly();
    const state = fakeState({ a: 30n, b: 10n }, { a: 0n, b: 0n });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")).toBe((WAD * 3n) / 4n);
    expect(target.get("b")).toBe(WAD / 4n);
  });

  it("weekly grid phases its cadence submitOffsetSec before the flip", () => {
    const strategy = fixedGridWeekly({ submitOffsetSec: 2 * 3_600 });
    expect(strategy.cadenceSec).toBe(WEEK);
    expect(strategy.phaseSec).toBe(WEEK - 2 * 3_600);
    expect(strategy.name).toBe("FixedGridWeekly");
  });

  it("rejects a weekly submitOffsetSec on or outside the votable window", () => {
    // 1h is the distribute-window boundary; WEEK-1h the last-hour gate. Both blocked.
    expect(() => fixedGridWeekly({ submitOffsetSec: 3_600 })).toThrow(/submitOffsetSec/);
    expect(() => fixedGridWeekly({ submitOffsetSec: WEEK - 3_600 })).toThrow(/submitOffsetSec/);
    expect(() => fixedGridWeekly({ submitOffsetSec: 0 })).toThrow(/submitOffsetSec/);
  });

  it("short grids share the factory", () => {
    expect(fixedGrid48h().cadenceSec).toBe(172_800);
    expect(fixedGrid(60).cadenceSec).toBe(60);
    expect(fixedGrid(60).phaseSec).toBe(0);
    expect(() => fixedGrid(0)).toThrow(/positive integer/);
  });

  it("falls back to uniform when there is no revenue anywhere", () => {
    const strategy = fixedGrid48h();
    const state = fakeState({ a: 0n, b: 0n }, { a: 0n, b: 0n });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expect(target.get("a")).toBe(WAD / 2n);
    expect(target.get("b")).toBe(WAD / 2n);
  });

  it("respects the pool allowlist", () => {
    const strategy = fixedGrid48h({ pools: ["a", "c"] });
    const state = fakeState({ a: 5n, b: 100n, c: 5n }, {});
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expect(target.has("b")).toBe(false);
    expectSumsToWad(target);
  });
});

describe("persistenceFactor", () => {
  it("gives no haircut to perfectly steady revenue", () => {
    expect(persistenceFactor([10n, 10n, 10n], WAD / 2n)).toBe(WAD);
  });

  it("haircuts proportional to MAD/mean, capped at the full haircut", () => {
    // buckets [0, 20]: mean 10, MAD 10 -> vol 100% -> full haircut.
    expect(persistenceFactor([0n, 20n], WAD / 2n)).toBe(WAD / 2n);
    // buckets [5, 15]: mean 10, MAD 5 -> vol 50% -> half the haircut.
    expect(persistenceFactor([5n, 15n], WAD / 2n)).toBe(WAD - WAD / 4n);
    // zero mean -> treated as fully volatile.
    expect(persistenceFactor([0n, 0n], WAD / 2n)).toBe(WAD / 2n);
  });
});

describe("persistenceCarry", () => {
  it("downweights volatile pools relative to plain trailing revenue", () => {
    const strategy = persistenceCarry({ lookbackSec: 700, buckets: 7, sWad: 0n });
    // Steady pool a; pool b same total trailing revenue but all in one bucket.
    const state: MarketState = {
      now: 1_000_000_000,
      pools: ["a", "b"],
      trailingRevenue: (pool, windowSec) => {
        if (pool === "a") return 10n * BigInt(windowSec);
        // b: 7000 total, all accrued in the most recent 100s bucket.
        return BigInt(Math.min(windowSec, 100)) * 70n;
      },
      poolWeight: () => 0n,
      totalWeight: () => 0n,
    };
    const target = strategy.propose(state, makePortfolio([freeTranche("t0")]));
    expectSumsToWad(target);
    expect(target.get("a")! > target.get("b")!).toBe(true);
  });

  it("applies (s,S): holds the last target until the L1 gap exceeds s", () => {
    const strategy = persistenceCarry({ sWad: WAD / 4n, lookbackSec: 700, buckets: 7 });
    const portfolio = makePortfolio([freeTranche("t0")], 0);
    const first = strategy.propose(fakeState({ a: 10n, b: 10n }, {}), portfolio);
    // Small shift (below s = 25pp): stays on the previous target.
    const second = strategy.propose(fakeState({ a: 11n, b: 10n }, {}), portfolio);
    expect(second).toEqual(first);
    // Large shift: moves fully to the new ideal (S).
    const third = strategy.propose(fakeState({ a: 100n, b: 1n }, {}), portfolio);
    expect(third).not.toEqual(first);
    expect(third.get("a")! > (WAD * 9n) / 10n).toBe(true);
  });

  it("does not spend the threshold while all tranches are locked", () => {
    const strategy = persistenceCarry({ sWad: 0n, lookbackSec: 700, buckets: 7 });
    const locked = makePortfolio(
      [{ id: "t0", positionWeight: WAD, lastActionAt: 999_999_999, allocation: new Map() }],
      172_800,
    );
    const first = strategy.propose(fakeState({ a: 10n, b: 10n }, {}), locked);
    const second = strategy.propose(fakeState({ a: 100n, b: 1n }, {}), locked);
    expect(second).toEqual(first); // locked: reaffirm last target
  });
});

describe("waterFill (exact allocator)", () => {
  const bigArb = fc.bigInt({ min: 0n, max: 10n ** 30n });

  it("conserves the budget exactly (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(bigArb, bigArb), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 10n ** 30n }),
        (rw, budget) => {
          const R = rw.map(([r]) => r);
          const W = rw.map(([, w]) => w);
          const { weights } = waterFill(R, W, budget);
          expect(sumBig(weights)).toBe(budget);
          for (const w of weights) expect(w >= 0n).toBe(true);
        },
      ),
      { numRuns: 60 },
    );
  });

  it("satisfies the bisection invariant: sum(λ) <= budget < sum(λ-1)", () => {
    const wAt = (R: bigint[], W: bigint[], lambda: bigint): bigint =>
      sumBig(
        R.map((r, i) => {
          const p = r * W[i]!;
          if (p === 0n) return 0n;
          const root = isqrt((p * WATER_FILL_SCALE) / lambda);
          return root > W[i]! ? root - W[i]! : 0n;
        }),
      );
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.bigInt({ min: 1n, max: 10n ** 24n }), fc.bigInt({ min: 1n, max: 10n ** 24n })), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        (rw, budget) => {
          const R = rw.map(([r]) => r);
          const W = rw.map(([, w]) => w);
          const { lambda } = waterFill(R, W, budget);
          expect(wAt(R, W, lambda) <= budget).toBe(true);
          if (lambda > 1n) expect(wAt(R, W, lambda - 1n) > budget).toBe(true);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("equalizes marginal yield: puts more into higher R pools", () => {
    const { weights } = waterFill([100n * WAD, 10n * WAD], [WAD, WAD], 10n * WAD);
    expect(weights[0]! > weights[1]!).toBe(true);
    expect(sumBig(weights)).toBe(10n * WAD);
  });

  it("symmetric pools split the budget symmetrically (up to remainder policy)", () => {
    const { weights } = waterFill([WAD, WAD], [WAD, WAD], 2n * WAD);
    const diff = weights[0]! - weights[1]!;
    expect(diff >= 0n ? diff : -diff).toBeLessThanOrEqual(1n);
  });

  it("handles degenerate inputs", () => {
    expect(waterFill([], [], 0n).weights).toEqual([]);
    expect(waterFill([WAD], [WAD], 0n).weights).toEqual([0n]);
    // Zero R everywhere: whole budget goes to index 0 (largest R tie -> lowest index).
    expect(waterFill([0n, 0n], [WAD, WAD], 7n).weights).toEqual([7n, 0n]);
    expect(() => waterFill([1n], [1n, 2n], 1n)).toThrow(/length mismatch/);
    expect(() => waterFill([1n], [1n], -1n)).toThrow(/negative/);
  });

  it("documents its iteration bound: iterations === bitLength(λ_hi)", () => {
    const { iterations } = waterFill([WAD], [WAD], WAD);
    // λ_hi = R*scale/W + 1 = 1e36 + 1 -> ~120 bits.
    expect(iterations).toBeGreaterThan(100);
    expect(iterations).toBeLessThan(140);
  });
});

describe("waterFilling strategy", () => {
  it("proposes a normalized target favoring under-crowded revenue", () => {
    const strategy = waterFilling();
    // Same revenue, but pool b is heavily crowded.
    const state = fakeState({ a: WAD, b: WAD }, { a: 10n * WAD, b: 1_000n * WAD });
    const target = strategy.propose(state, makePortfolio([freeTranche("t0", 100n * WAD)]));
    expectSumsToWad(target);
    expect(target.get("a")! > target.get("b")!).toBe(true);
  });

  it("subtracts our own tranche weight from the external weight", () => {
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: 10n * WAD,
      lastActionAt: 0,
      allocation: new Map([["a", WAD]]),
    };
    expect(portfolioWeightOnPool(makePortfolio([tranche]), "a")).toBe(10n * WAD);
    expect(portfolioWeightOnPool(makePortfolio([tranche]), "b")).toBe(0n);
  });
});

describe("continuousGreedy", () => {
  it("marginalYield is exact and handles zero denominators", () => {
    expect(marginalYield(WAD, 0n, 0n)).toBe(0n);
    expect(marginalYield(4n * WAD, WAD, WAD)).toBe(WAD); // 4W*W*WAD/(2W)^2 = WAD
  });

  it("moves when the yield gap exceeds threshold + cost", () => {
    const strategy = continuousGreedy({ thresholdWad: WAD / 100n, costWad: 0n });
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map([["b", WAD]]), // we sit in the bad pool
    };
    const portfolio = makePortfolio([tranche], 0);
    const first = strategy.propose(fakeState({ a: WAD, b: WAD }, { a: WAD, b: WAD }), portfolio);
    expectSumsToWad(first);
    // Massive gap: pool a revenue explodes -> re-proposes toward a.
    const second = strategy.propose(
      fakeState({ a: 1_000n * WAD, b: 1n }, { a: WAD, b: WAD }),
      portfolio,
    );
    expect(second.get("a")! > second.get("b")!).toBe(true);
  });

  it("holds the last target while every tranche is locked", () => {
    const strategy = continuousGreedy({ thresholdWad: 0n, costWad: 0n });
    const locked: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 999_999_999,
      allocation: new Map([["b", WAD]]),
    };
    const portfolio = makePortfolio([locked], 172_800);
    const first = strategy.propose(fakeState({ a: WAD, b: WAD }, { a: WAD, b: WAD }), portfolio);
    const second = strategy.propose(
      fakeState({ a: 1_000n * WAD, b: 1n }, { a: WAD, b: WAD }),
      portfolio,
    );
    expect(second).toEqual(first);
  });

  it("defaults to one Base block cadence", () => {
    expect(continuousGreedy().cadenceSec).toBe(2);
  });
});

describe("clampToMaxPoolWeightWad (guardrail-valid targets, mirrors TargetsFacet)", () => {
  const sumOf = (m: TargetAllocation): bigint => {
    let s = 0n;
    for (const v of m.values()) s += v;
    return s;
  };

  it("returns an in-cap target unchanged", () => {
    const t = new Map([
      ["a", WAD / 2n],
      ["b", WAD / 2n],
    ]);
    expect(clampToMaxPoolWeightWad(t, VAULT_DEFAULT_MAX_POOL_WEIGHT_WAD)).toEqual(t);
  });

  it("caps an over-weight pool and redistributes, still summing to WAD", () => {
    const t = normalizeToWad(new Map([["a", 8n], ["b", 1n], ["c", 1n]])); // 0.8 / 0.1 / 0.1
    const c = clampToMaxPoolWeightWad(t, WAD / 2n);
    expect(sumOf(c)).toBe(WAD);
    for (const v of c.values()) expect(v <= WAD / 2n).toBe(true);
    expect(c.get("a")).toBe(WAD / 2n);
    expect(c.get("b")).toBe(WAD / 4n);
    expect(c.get("c")).toBe(WAD / 4n);
  });

  it("spreads a fully-concentrated target across zero-weight pools", () => {
    const cap = (WAD * 4n) / 10n; // 0.4, feasible over 3 pools (1.2 >= 1)
    const t = normalizeToWad(new Map([["a", 1n], ["b", 0n], ["c", 0n]])); // a = WAD
    const c = clampToMaxPoolWeightWad(t, cap);
    expect(sumOf(c)).toBe(WAD);
    for (const v of c.values()) expect(v <= cap).toBe(true);
  });

  it("throws when the cap cannot sum to WAD", () => {
    expect(() => clampToMaxPoolWeightWad(new Map([["a", WAD]]), WAD / 2n)).toThrow(/infeasible/);
  });
});
