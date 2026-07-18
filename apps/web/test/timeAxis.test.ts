import { describe, expect, it } from "vitest";
import { timeAxisFor } from "../src/lib/timeAxis.js";

// Thu 2025-07-17 00:00:00 UTC — a real epoch flip boundary
const THURSDAY = 1_752_710_400;

describe("time axis labeling", () => {
  it("historical runs show real UTC dates", () => {
    const axis = timeAxisFor({ dataKind: "historical", startTime: THURSDAY });
    expect(axis.tick(THURSDAY)).toBe("17 Jul");
    expect(axis.label(THURSDAY)).toContain("Thu");
    expect(axis.label(THURSDAY)).toContain("2025");
  });

  it("historical labels are timezone-independent (UTC pinned)", () => {
    const axis = timeAxisFor({ dataKind: "historical", startTime: THURSDAY });
    // one second before the Thursday flip must still be Wednesday in every locale
    expect(axis.label(THURSDAY - 1)).toContain("Wed");
  });

  it("synthetic runs keep relative day labels (anchor date is arbitrary)", () => {
    const axis = timeAxisFor({ dataKind: "synthetic", startTime: THURSDAY });
    expect(axis.tick(THURSDAY)).toBe("d0");
    expect(axis.tick(THURSDAY + 7 * 86_400)).toBe("d7");
    expect(axis.label(THURSDAY + 12 * 3_600)).toBe("day 0.5");
  });

  it("historical ticks land exactly on epoch flips (ts % WEEK == 0)", () => {
    const axis = timeAxisFor({ dataKind: "historical", startTime: THURSDAY + 7_200 });
    const ticks = axis.epochTicks(THURSDAY + 7_200, THURSDAY + 12 * 604_800);
    expect(ticks.length).toBeGreaterThan(0);
    for (const ts of ticks) expect(ts % 604_800).toBe(0);
    // every tick labels as a Thursday
    for (const ts of ticks) expect(axis.label(ts)).toContain("Thu");
  });

  it("synthetic ticks land on week multiples of the run start (whole d-labels)", () => {
    const start = THURSDAY + 7_200; // 2h past the flip, like real runs
    const axis = timeAxisFor({ dataKind: "synthetic", startTime: start });
    // maxTicks above the grid size → stride 1, consecutive weeks
    const ticks = axis.epochTicks(start, start + 10 * 604_800, 20);
    for (const [i, ts] of ticks.entries()) {
      expect((ts - start) % 604_800).toBe(0);
      expect(axis.tick(ts)).toBe(`d${i * 7}`);
    }
  });

  it("tick thinning respects maxTicks over long ranges", () => {
    const axis = timeAxisFor({ dataKind: "historical", startTime: THURSDAY });
    const ticks = axis.epochTicks(THURSDAY, THURSDAY + 52 * 604_800, 8);
    expect(ticks.length).toBeLessThanOrEqual(8);
    for (const ts of ticks) expect(ts % 604_800).toBe(0);
  });
});
