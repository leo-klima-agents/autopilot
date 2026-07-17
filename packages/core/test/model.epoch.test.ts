import { describe, expect, it } from "vitest";
import { mulDiv, WAD } from "../src/math/fixed.js";
import { createEpochModel } from "../src/model/epoch.js";
import {
  AllocationBlockedError,
  epochNext,
  epochStart,
  HOUR,
  WEEK,
} from "../src/model/types.js";
import { constantRevenue, T0 } from "./helpers.js";

const wholeTo = (pool: string) => new Map([[pool, WAD]]);

describe("epoch timing", () => {
  it("epochStart flips at Thursday 00:00 UTC (unix % 604800)", () => {
    expect(T0 % WEEK).toBe(0);
    expect(new Date(T0 * 1000).getUTCDay()).toBe(4); // Thursday
    expect(epochStart(T0)).toBe(T0);
    expect(epochStart(T0 + WEEK - 1)).toBe(T0);
    expect(epochStart(T0 + WEEK)).toBe(T0 + WEEK);
    expect(epochNext(T0)).toBe(T0 + WEEK);
  });
});

describe("EpochModel voting gates", () => {
  const setup = (startOffset: number, enforceLastHour = false) => {
    const model = createEpochModel({
      revenue: constantRevenue({ a: 10n, b: 5n }),
      startTime: T0 + startOffset,
      enforceLastHourWhitelist: enforceLastHour,
      whitelistedPositions: ["vip"],
    });
    model.addPosition("p1", WAD);
    return model;
  };

  it("blocks voting during the first hour (distribute window)", () => {
    const model = setup(30 * 60);
    expect(model.canAllocate("p1")).toBe(false);
    expect(model.nextAllocationTime("p1")).toBe(T0 + HOUR);
    expect(() => model.submitAllocation("p1", wholeTo("a"))).toThrow(AllocationBlockedError);
    expect(() => model.submitAllocation("p1", wholeTo("a"))).toThrow(/DistributeWindow/);
  });

  it("enforces one vote per epoch (onlyNewEpoch), releasing at the next epoch", () => {
    const model = setup(2 * HOUR);
    model.submitAllocation("p1", wholeTo("a"));
    expect(model.canAllocate("p1")).toBe(false);
    expect(() => model.submitAllocation("p1", wholeTo("b"))).toThrow(/AlreadyVotedOrDeposited/);
    // Still blocked later in the same epoch.
    model.advance(3 * 24 * 3600);
    expect(model.canAllocate("p1")).toBe(false);
    // New epoch + distribute window passed: free again.
    model.advance(WEEK - 3 * 24 * 3600 - HOUR); // lands at flip + 1h
    expect(model.canAllocate("p1")).toBe(true);
    model.submitAllocation("p1", wholeTo("b"));
  });

  it("blocks non-whitelisted voting in the last hour when the flag is on", () => {
    const model = setup(WEEK - 30 * 60, true);
    model.addPosition("vip", WAD);
    expect(() => model.submitAllocation("p1", wholeTo("a"))).toThrow(/NotWhitelistedNFT/);
    model.submitAllocation("vip", wholeTo("a")); // whitelisted is allowed
  });

  it("allows the last hour when the flag is off (default)", () => {
    const model = setup(WEEK - 30 * 60, false);
    model.submitAllocation("p1", wholeTo("a"));
  });

  it("rejects malformed targets", () => {
    const model = setup(2 * HOUR);
    expect(() => model.submitAllocation("p1", new Map([["a", WAD - 1n]]))).toThrow(/sum to WAD/);
    expect(() => model.submitAllocation("p1", new Map([["zzz", WAD]]))).toThrow(/unknown pool/);
    expect(() => model.submitAllocation("nobody", wholeTo("a"))).toThrow(/unknown position/);
  });
});

describe("EpochModel rewards", () => {
  it("distributes epoch revenue pro-rata to end-of-epoch weights, tracking dust", () => {
    const rateA = 7n;
    const model = createEpochModel({
      revenue: constantRevenue({ a: rateA }),
      startTime: T0 + 2 * HOUR,
    });
    model.addPosition("p1", 3n);
    model.addPosition("p2", 7n);
    model.setCrowdWeights(new Map([["a", 5n]]));
    model.submitAllocation("p1", wholeTo("a"));
    model.submitAllocation("p2", wholeTo("a"));

    // Nothing distributed before the flip.
    model.advance(WEEK - 3 * HOUR);
    expect(model.earned("p1")).toBe(0n);

    // Cross the flip: lump-sum distribution of the epoch's revenue.
    model.advance(2 * HOUR);
    const reward = rateA * BigInt(WEEK - 2 * HOUR); // accrual starts at model start
    const total = 3n + 7n + 5n;
    const p1 = mulDiv(reward, 3n, total);
    const p2 = mulDiv(reward, 7n, total);
    const crowd = mulDiv(reward, 5n, total);
    expect(model.earned("p1")).toBe(p1);
    expect(model.earned("p2")).toBe(p2);
    const totals = model.totals();
    expect(totals.crowdRevenue).toBe(crowd);
    expect(totals.revenueDust).toBe(reward - p1 - p2 - crowd);
    expect(totals.revenueTotal).toBe(reward);
    // Conservation: payouts + crowd + dust === revenue.
    expect(p1 + p2 + crowd + totals.revenueDust).toBe(reward);
  });

  it("keeps votes persistent across epochs and pays every epoch", () => {
    const model = createEpochModel({
      revenue: constantRevenue({ a: 10n }),
      startTime: T0 + 2 * HOUR,
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    model.advance(3 * WEEK);
    // Three flips crossed; p1 was the only weight, so it earned everything.
    expect(model.earned("p1")).toBe(model.totals().revenueTotal);
    expect(model.totals().revenueTotal).toBe(10n * BigInt(3 * WEEK - 2 * HOUR));
  });

  it("sends revenue of unweighted pools entirely to dust", () => {
    const model = createEpochModel({
      revenue: constantRevenue({ a: 10n, b: 3n }),
      startTime: T0 + 2 * HOUR,
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    model.advance(WEEK);
    const totals = model.totals();
    expect(totals.revenueDust).toBe(3n * BigInt(WEEK - 2 * HOUR));
  });

  it("claim zeroes the accrual and returns it", () => {
    const model = createEpochModel({
      revenue: constantRevenue({ a: 10n }),
      startTime: T0 + 2 * HOUR,
    });
    model.addPosition("p1", WAD);
    model.submitAllocation("p1", wholeTo("a"));
    model.advance(WEEK);
    const earned = model.earned("p1");
    expect(earned > 0n).toBe(true);
    expect(model.claim("p1")).toBe(earned);
    expect(model.earned("p1")).toBe(0n);
  });

  it("emissionShares reflect weight shares", () => {
    const model = createEpochModel({
      revenue: constantRevenue({ a: 1n, b: 1n }),
      startTime: T0 + 2 * HOUR,
    });
    model.addPosition("p1", 4n);
    model.submitAllocation("p1", new Map([["a", WAD / 2n], ["b", WAD / 2n]]));
    model.setCrowdWeights(new Map([["a", 2n]]));
    const shares = model.emissionShares();
    expect(shares.get("a")).toBe(mulDiv(WAD, 4n, 6n));
    expect(shares.get("b")).toBe(mulDiv(WAD, 2n, 6n));
  });
});
