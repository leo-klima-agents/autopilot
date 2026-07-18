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
});
