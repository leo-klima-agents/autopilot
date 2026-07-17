import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mulDiv, WAD } from "../src/math/fixed.js";
import { createContinuousModel } from "../src/model/continuous.js";
import { adversarialWashBait, reactiveHerd, staticCrowd } from "../src/model/crowd.js";
import { AllocationBlockedError } from "../src/model/types.js";
import { constantRevenue, steppedRevenue, T0 } from "./helpers.js";

const wholeTo = (pool: string) => new Map([[pool, WAD]]);

describe("ContinuousModel revenue streaming", () => {
  it("streams pro-rata by allocated weight, exactly", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 8n }),
      startTime: T0,
    });
    model.addPosition("p1", 1n);
    model.addPosition("p2", 3n);
    model.setCrowdWeights(new Map([["a", 4n]]));
    model.submitAllocation("p1", wholeTo("a"));
    model.submitAllocation("p2", wholeTo("a"));
    model.advance(100);
    const rev = 800n;
    expect(model.earned("p1")).toBe(mulDiv(rev, 1n, 8n));
    expect(model.earned("p2")).toBe(mulDiv(rev, 3n, 8n));
    const totals = model.totals();
    expect(totals.crowdRevenue).toBe(mulDiv(rev, 4n, 8n));
    expect(totals.revenueTotal).toBe(rev);
    expect(totals.revenueDust).toBe(0n);
  });

  it("is additive across advance calls (piecewise-exact integration)", () => {
    const build = () => {
      const m = createContinuousModel({
        revenue: steppedRevenue({ a: [{ from: T0, rate: 5n }, { from: T0 + 50, rate: 11n }] }),
        startTime: T0,
      });
      m.addPosition("p1", WAD);
      m.submitAllocation("p1", wholeTo("a"));
      return m;
    };
    const oneShot = build();
    oneShot.advance(200);
    const chunked = build();
    for (let i = 0; i < 20; i += 1) chunked.advance(10);
    expect(oneShot.earned("p1")).toBe(chunked.earned("p1"));
    expect(oneShot.earned("p1")).toBe(5n * 50n + 11n * 150n);
  });

  it("sends revenue of unweighted pools to dust", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 5n, b: 2n }),
      startTime: T0,
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    model.advance(100);
    expect(model.totals().revenueDust).toBe(200n);
  });
});

describe("ContinuousModel cooldown", () => {
  it("enforces a rolling per-position cooldown with exact boundary", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 1n, b: 1n }),
      startTime: T0,
      cooldownSec: 1_000,
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a")); // fresh positions may allocate at once
    expect(model.canAllocate("p1")).toBe(false);
    expect(model.nextAllocationTime("p1")).toBe(T0 + 1_000);
    expect(() => model.submitAllocation("p1", wholeTo("b"))).toThrow(AllocationBlockedError);
    model.advance(999);
    expect(model.canAllocate("p1")).toBe(false);
    model.advance(1);
    expect(model.canAllocate("p1")).toBe(true);
    model.submitAllocation("p1", wholeTo("b"));
  });

  it("per-position granularity leaves other positions free", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 1n }),
      startTime: T0,
      cooldownSec: 1_000,
    });
    model.addPosition("p1", WAD);
    model.addPosition("p2", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    expect(model.canAllocate("p2")).toBe(true);
  });

  it("global granularity locks everyone after any action (§3 item 1 what-if)", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 1n }),
      startTime: T0,
      cooldownSec: 1_000,
      cooldownGranularity: "global",
    });
    model.addPosition("p1", WAD);
    model.addPosition("p2", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    expect(model.canAllocate("p2")).toBe(false);
    expect(model.nextAllocationTime("p2")).toBe(T0 + 1_000);
  });
});

describe("ContinuousModel gauge caps", () => {
  const capSetup = (revRate: bigint) => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: revRate, b: revRate }),
      startTime: T0 + 10 * 604_800, // enough history for the trailing window
      emissionRatePerSec: WAD,
      caps: { enabled: true, intervalSec: 172_800, windowSec: 172_800 },
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    return model;
  };

  it("burns emission above κ × trailing revenue rate and conserves exactly", () => {
    const model = capSetup(2n); // cap = 1.2 * 2 = 2 (floor of mulDiv) per pool
    model.advance(1_000);
    const totals = model.totals();
    // Pool a gets the whole emission rate (only weighted pool): 1e18/s allocated.
    expect(totals.emitted).toBe(WAD * 1_000n);
    const capRate = mulDiv(1_200_000_000_000_000_000n, 2n, WAD); // = 2
    expect(totals.streamed).toBe(capRate * 1_000n);
    expect(totals.burned).toBe(totals.emitted - totals.streamed);
    expect(totals.streamed + totals.burned).toBe(totals.emitted);
  });

  it("does not cap when revenue is high enough", () => {
    const model = capSetup(WAD); // cap = 1.2e18/s >= allocated 1e18/s
    model.advance(1_000);
    const totals = model.totals();
    expect(totals.burned).toBe(0n);
    expect(totals.streamed).toBe(totals.emitted);
  });

  it("recalibrates caps on the interval (segment splitting mid-advance)", () => {
    const t0 = T0 + 10 * 604_800;
    const model = createContinuousModel({
      revenue: steppedRevenue({
        a: [
          { from: 0, rate: 0n }, // no revenue before t0: initial cap = 0
          { from: t0, rate: WAD },
        ],
      }),
      startTime: t0,
      emissionRatePerSec: WAD,
      caps: { enabled: true, intervalSec: 172_800, windowSec: 172_800 },
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    // One advance across the first recalibration boundary.
    model.advance(172_800 + 1_000);
    const totals = model.totals();
    // First 172800s: cap 0 -> everything burned. After recalibration the
    // trailing window is all at rate WAD -> cap = 1.2e18 > 1e18 -> no burn.
    expect(totals.burned).toBe(WAD * 172_800n);
    expect(totals.emitted).toBe(WAD * 173_800n);
    expect(totals.streamed + totals.burned).toBe(totals.emitted);
  });

  it("conservation invariant holds under random scenarios (property)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 0n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.array(fc.integer({ min: 1, max: 400_000 }), { minLength: 1, maxLength: 6 }),
        (rateA, rateB, emission, advances) => {
          const model = createContinuousModel({
            revenue: constantRevenue({ a: rateA, b: rateB }),
            startTime: T0,
            emissionRatePerSec: emission,
            caps: { enabled: true },
          });
          model.addPosition("p1", WAD);
          model.submitAllocation("p1", new Map([["a", WAD / 3n], ["b", WAD - WAD / 3n]]));
          model.setCrowdWeights(new Map([["a", WAD * 5n]]));
          for (const dt of advances) model.advance(dt);
          const totals = model.totals();
          expect(totals.streamed + totals.burned).toBe(totals.emitted);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("emissionShares reflect post-cap effective rates", () => {
    const t0 = T0 + 10 * 604_800;
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 0n, b: WAD }), // pool a: cap 0; pool b: high cap
      startTime: t0,
      emissionRatePerSec: WAD,
      caps: { enabled: true },
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", new Map([["a", WAD / 2n], ["b", WAD / 2n]]));
    const shares = model.emissionShares();
    expect(shares.get("a")).toBe(0n); // fully capped out
    expect(shares.get("b")).toBe(WAD); // all effective emission flows to b
  });
});

describe("ContinuousModel allocation decay (F5)", () => {
  it("resolves decay lazily at allocation events", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 1n, b: 1n }),
      startTime: T0,
      cooldownSec: 0,
      decay: { enabled: true, ratePerSecWad: WAD / 1_000_000n }, // 1e-6/s
    });
    model.addPosition("p1", 1_000_000n);
    model.addPosition("p2", 1_000_000n);
    model.submitAllocation("p1", wholeTo("a"));
    model.submitAllocation("p2", wholeTo("b"));
    const before = model.marketState().poolWeight("a");
    expect(before).toBe(1_000_000n);
    model.advance(500_000); // p1 is now 50% decayed, but not yet resolved
    expect(model.marketState().poolWeight("a")).toBe(1_000_000n);
    // p2 re-allocating resolves everyone lazily; p2 itself refreshes to full.
    model.submitAllocation("p2", wholeTo("b"));
    expect(model.marketState().poolWeight("a")).toBe(500_000n);
    expect(model.marketState().poolWeight("b")).toBe(1_000_000n);
    // p1 re-allocating restores its full weight.
    model.submitAllocation("p1", wholeTo("a"));
    expect(model.marketState().poolWeight("a")).toBe(1_000_000n);
  });

  it("is off by default (fixture paths)", () => {
    const model = createContinuousModel({
      revenue: constantRevenue({ a: 1n, b: 1n }),
      startTime: T0,
      cooldownSec: 0,
    });
    model.addPosition("p1", WAD);
    model.addPosition("p2", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    model.advance(10_000_000);
    model.submitAllocation("p2", wholeTo("b"));
    expect(model.marketState().poolWeight("a")).toBe(WAD);
  });
});

describe("crowd models", () => {
  it("staticCrowd never moves", () => {
    const crowd = staticCrowd(new Map([["a", 5n]]));
    expect(crowd.weightsAt(0)).toEqual(new Map([["a", 5n]]));
    expect(crowd.weightsAt(10 ** 9)).toEqual(new Map([["a", 5n]]));
  });

  it("reactiveHerd chases lagged trailing revenue proportionally", () => {
    const revenue = steppedRevenue({
      a: [{ from: 0, rate: 3n }],
      b: [{ from: 0, rate: 1n }],
    });
    const herd = reactiveHerd({ revenue, totalWeight: 100n, lagSeconds: 0, windowSec: 100 });
    const weights = herd.weightsAt(T0);
    expect(weights.get("a")).toBe(75n);
    expect(weights.get("b")).toBe(25n);
  });

  it("reactiveHerd lag makes it blind to recent shifts", () => {
    const flip = T0 + 1_000;
    const revenue = steppedRevenue({
      a: [{ from: 0, rate: 10n }, { from: flip, rate: 0n }],
      b: [{ from: 0, rate: 0n }, { from: flip, rate: 10n }],
    });
    const lagged = reactiveHerd({ revenue, totalWeight: 100n, lagSeconds: 5_000, windowSec: 100 });
    const fresh = reactiveHerd({ revenue, totalWeight: 100n, lagSeconds: 0, windowSec: 100 });
    const at = flip + 2_000;
    expect(lagged.weightsAt(at).get("a")).toBe(100n); // still sees the old world
    expect(fresh.weightsAt(at).get("b")).toBe(100n);
  });

  it("adversarialWashBait pumps fake revenue only inside its windows", () => {
    const base = constantRevenue({ a: 2n, b: 1n });
    const baited = adversarialWashBait(base, "a", [
      { start: 100, end: 200, ratePerSecWad: 50n },
    ]);
    expect(baited.revenueBetween("a", 0, 100)).toBe(200n);
    expect(baited.revenueBetween("a", 100, 200)).toBe(200n + 5_000n);
    expect(baited.revenueBetween("a", 0, 300)).toBe(600n + 5_000n);
    expect(baited.revenueBetween("b", 0, 300)).toBe(300n); // other pools untouched
    // Additivity is preserved.
    expect(
      baited.revenueBetween("a", 0, 150) + baited.revenueBetween("a", 150, 300),
    ).toBe(baited.revenueBetween("a", 0, 300));
  });
});
