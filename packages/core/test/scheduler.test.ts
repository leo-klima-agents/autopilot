import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WAD } from "../src/math/fixed.js";
import { splitProportionally } from "../src/math/split.js";
import {
  applyRotation,
  l1Distance,
  plan,
  type TrancheState,
} from "../src/scheduler/scheduler.js";

const POOLS = ["pool-a", "pool-b", "pool-c"];

const allocationArb = fc
  .array(fc.bigInt({ min: 0n, max: WAD }), { minLength: POOLS.length, maxLength: POOLS.length })
  .map((scores) =>
    splitProportionally(WAD, new Map(POOLS.map((p, i) => [p, scores[i]!]))),
  );

const trancheArb = (id: string): fc.Arbitrary<TrancheState> =>
  fc
    .record({
      lastActionAt: fc.integer({ min: 0, max: 1_000_000 }),
      allocation: fc.oneof(allocationArb, fc.constant(new Map<string, bigint>())),
    })
    .map(({ lastActionAt, allocation }) => ({
      id,
      positionWeight: WAD,
      lastActionAt,
      allocation,
    }));

const tranchesArb = fc
  .integer({ min: 0, max: 6 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => trancheArb(`t${i}`))));

const scenarioArb = fc.record({
  tranches: tranchesArb,
  target: allocationArb,
  now: fc.integer({ min: 0, max: 2_000_000 }),
  cooldownSec: fc.integer({ min: 0, max: 500_000 }),
});

describe("plan", () => {
  it("never rotates a tranche whose cooldown has not elapsed", () => {
    fc.assert(
      fc.property(scenarioArb, ({ tranches, target, now, cooldownSec }) => {
        const actions = plan(tranches, target, now, cooldownSec);
        for (const action of actions) {
          const tranche = tranches.find((t) => t.id === action.trancheId)!;
          if (action.kind === "rotate") {
            expect(now >= tranche.lastActionAt + cooldownSec).toBe(true);
          } else {
            expect(action.until).toBe(tranche.lastActionAt + cooldownSec);
            expect(now < action.until).toBe(true);
          }
        }
      }),
    );
  });

  it("emits no action for tranches already exactly on target", () => {
    fc.assert(
      fc.property(scenarioArb, ({ tranches, target, now, cooldownSec }) => {
        const onTarget = tranches.map((t) => ({ ...t, allocation: new Map(target) }));
        expect(plan(onTarget, target, now, cooldownSec)).toEqual([]);
      }),
    );
  });

  it("repeated plan+apply converges every tranche to the target", () => {
    fc.assert(
      fc.property(scenarioArb, ({ tranches, target, now, cooldownSec }) => {
        let current = tranches.map((t) => ({ ...t, allocation: new Map(t.allocation) }));
        let t = Math.max(now, ...tranches.map((tr) => tr.lastActionAt));
        for (let round = 0; round < 4 && current.length > 0; round += 1) {
          const actions = plan(current, target, t, cooldownSec);
          for (const action of actions) {
            if (action.kind !== "rotate") continue;
            const idx = current.findIndex((tr) => tr.id === action.trancheId);
            current[idx] = applyRotation(current[idx]!, action.allocation, t);
          }
          t += cooldownSec + 1; // everyone's cooldown elapses before next round
        }
        for (const tranche of current) {
          expect(l1Distance(tranche.allocation, target)).toBe(0n);
        }
      }),
    );
  });

  it("is deterministic under permutation of tranche order and map insertion order", () => {
    fc.assert(
      fc.property(scenarioArb, ({ tranches, target, now, cooldownSec }) => {
        const shuffledTarget = new Map([...target.entries()].reverse());
        const shuffledTranches = [...tranches]
          .reverse()
          .map((t) => ({ ...t, allocation: new Map([...t.allocation.entries()].reverse()) }));
        const a = plan(tranches, target, now, cooldownSec);
        const b = plan(shuffledTranches, shuffledTarget, now, cooldownSec);
        expect(a).toEqual(b);
      }),
    );
  });

  it("orders rotations farthest-first with ties broken by lowest id", () => {
    const target = new Map([["pool-a", WAD]]);
    const half = new Map([
      ["pool-a", WAD / 2n],
      ["pool-b", WAD / 2n],
    ]);
    const tranches: TrancheState[] = [
      { id: "t2", positionWeight: WAD, lastActionAt: 0, allocation: new Map(half) },
      { id: "t1", positionWeight: WAD, lastActionAt: 0, allocation: new Map([["pool-b", WAD]]) },
      { id: "t0", positionWeight: WAD, lastActionAt: 0, allocation: new Map(half) },
    ];
    const actions = plan(tranches, target, 100, 10);
    expect(actions.map((a) => a.trancheId)).toEqual(["t1", "t0", "t2"]);
    expect(actions.every((a) => a.kind === "rotate")).toBe(true);
  });

  it("orders waits by soonest-until then id", () => {
    const target = new Map([["pool-a", WAD]]);
    const tranches: TrancheState[] = [
      { id: "t0", positionWeight: WAD, lastActionAt: 90, allocation: new Map() },
      { id: "t1", positionWeight: WAD, lastActionAt: 50, allocation: new Map() },
      { id: "t2", positionWeight: WAD, lastActionAt: 50, allocation: new Map() },
    ];
    const actions = plan(tranches, target, 100, 100);
    expect(actions).toEqual([
      { kind: "wait", trancheId: "t1", until: 150 },
      { kind: "wait", trancheId: "t2", until: 150 },
      { kind: "wait", trancheId: "t0", until: 190 },
    ]);
  });

  it("rotates exactly at the cooldown boundary (now === lastActionAt + cooldown)", () => {
    const target = new Map([["pool-a", WAD]]);
    const tranche: TrancheState = {
      id: "t0",
      positionWeight: WAD,
      lastActionAt: 0,
      allocation: new Map(),
    };
    expect(plan([tranche], target, 99, 100)[0]!.kind).toBe("wait");
    expect(plan([tranche], target, 100, 100)[0]!.kind).toBe("rotate");
  });

  it("throws on duplicate tranche ids", () => {
    const t: TrancheState = { id: "x", positionWeight: WAD, lastActionAt: 0, allocation: new Map() };
    expect(() => plan([t, { ...t }], new Map([["pool-a", WAD]]), 0, 0)).toThrow(/duplicate/);
  });
});

describe("l1Distance", () => {
  it("is a metric over the union of keys", () => {
    fc.assert(
      fc.property(allocationArb, allocationArb, (a, b) => {
        expect(l1Distance(a, b)).toBe(l1Distance(b, a));
        expect(l1Distance(a, a)).toBe(0n);
      }),
    );
  });

  it("treats missing keys as zero", () => {
    expect(l1Distance(new Map([["a", 5n]]), new Map())).toBe(5n);
    expect(l1Distance(new Map(), new Map([["a", 5n]]))).toBe(5n);
  });
});
