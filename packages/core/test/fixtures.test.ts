import { describe, expect, it } from "vitest";
import { sumBig } from "../src/math/fixed.js";
import { plan } from "../src/scheduler/scheduler.js";
import {
  buildCapBurnFixtures,
  buildProRataFixtures,
  buildSchedulerFixtures,
  buildWaterFillingFixtures,
} from "../src/fixtures/generators.js";
import { buildAllFixtureFiles, FIXTURE_SEEDS } from "../src/fixtures/emit.js";
import { stringifyFixtureFile, toJsonValue } from "../src/fixtures/serialize.js";

describe("fixture generators", () => {
  it("every family has 50-200 cases", () => {
    for (const { file } of buildAllFixtureFiles()) {
      expect(file.cases.length).toBeGreaterThanOrEqual(50);
      expect(file.cases.length).toBeLessThanOrEqual(200);
    }
  });

  it("is byte-for-byte deterministic", () => {
    const a = buildAllFixtureFiles().map(({ file }) => stringifyFixtureFile(file));
    const b = buildAllFixtureFiles().map(({ file }) => stringifyFixtureFile(file));
    expect(a).toEqual(b);
  });

  it("pro-rata cases conserve: sum(payouts) + dust === poolReward", () => {
    const { cases } = buildProRataFixtures(FIXTURE_SEEDS.proRata);
    for (const c of cases) {
      expect(sumBig(c.expected.payouts) + c.expected.dust).toBe(c.inputs.poolReward);
      expect(c.expected.dust >= 0n).toBe(true);
      for (const p of c.expected.payouts) expect(p >= 0n).toBe(true);
    }
    // Named adversarial edges exist.
    const names = cases.map((c) => c.name);
    expect(names).toContain("zero-total-weight");
    expect(names).toContain("max-magnitude");
  });

  it("cap-burn cases conserve: streamed + burned === emitted", () => {
    const { cases } = buildCapBurnFixtures(FIXTURE_SEEDS.capBurn);
    for (const c of cases) {
      expect(c.expected.streamed + c.expected.burned).toBe(c.expected.emitted);
      expect(c.expected.effectiveRate <= c.inputs.allocatedRatePerSec).toBe(true);
      expect(c.expected.effectiveRate <= c.expected.capRate).toBe(true);
    }
  });

  it("water-filling cases conserve the budget", () => {
    const { cases } = buildWaterFillingFixtures(FIXTURE_SEEDS.waterFilling);
    for (const c of cases) {
      expect(sumBig(c.expected.weights)).toBe(c.inputs.budget);
      expect(c.expected.weights).toHaveLength(c.inputs.R.length);
    }
  });

  it("scheduler cases replay through plan() exactly", () => {
    const { cases } = buildSchedulerFixtures(FIXTURE_SEEDS.scheduler);
    for (const c of cases) {
      const actions = plan(
        c.inputs.tranches.map((t) => ({ ...t, allocation: new Map(t.allocation) })),
        new Map(c.inputs.target),
        c.inputs.now,
        c.inputs.cooldownSec,
      );
      expect(toJsonValue(actions)).toEqual(toJsonValue(c.expected.actions));
    }
  });
});

describe("fixture serialization", () => {
  it("converts bigints to decimal strings and Maps to sorted objects", () => {
    const value = {
      big: 123n,
      map: new Map([
        ["b", 2n],
        ["a", 1n],
      ]),
      nested: [{ x: 0n }],
    };
    expect(toJsonValue(value)).toEqual({
      big: "123",
      map: { a: "1", b: "2" },
      nested: [{ x: "0" }],
    });
    const json = stringifyFixtureFile({ name: "t", cases: [value] });
    expect(JSON.stringify(JSON.parse(json))).toBe(JSON.stringify(toJsonValue({ name: "t", cases: [value] })));
    expect(json.indexOf('"a"')).toBeLessThan(json.indexOf('"b"'));
  });
});
