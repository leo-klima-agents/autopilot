import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createPrng, splitmix64 } from "../src/math/prng.js";

describe("splitmix64", () => {
  it("reproduces the canonical seed-0 known-answer sequence", () => {
    // Reference values from the canonical C implementation (Vigna).
    const next = splitmix64(0n);
    expect(next()).toBe(0xe220a8397b1dcdafn);
    expect(next()).toBe(0x6e789e6aa1b965f4n);
    expect(next()).toBe(0x06c45d188009454fn);
  });

  it("is deterministic per seed and outputs 64-bit values", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (seed) => {
        const a = splitmix64(seed);
        const b = splitmix64(seed);
        for (let i = 0; i < 8; i += 1) {
          const v = a();
          expect(v).toBe(b());
          expect(v >= 0n && v < 1n << 64n).toBe(true);
        }
      }),
    );
  });
});

describe("createPrng (xoshiro256**)", () => {
  it("is deterministic per seed", () => {
    const a = createPrng(42n);
    const b = createPrng(42n);
    for (let i = 0; i < 32; i += 1) expect(a.nextUint64()).toBe(b.nextUint64());
  });

  it("differs across seeds", () => {
    const a = createPrng(1n);
    const b = createPrng(2n);
    const seqA = Array.from({ length: 4 }, () => a.nextUint64());
    const seqB = Array.from({ length: 4 }, () => b.nextUint64());
    expect(seqA).not.toEqual(seqB);
  });

  it("nextUint64 stays in [0, 2^64)", () => {
    const prng = createPrng(7n);
    for (let i = 0; i < 1000; i += 1) {
      const v = prng.nextUint64();
      expect(v >= 0n && v < 1n << 64n).toBe(true);
    }
  });

  it("nextFloat stays in [0, 1)", () => {
    const prng = createPrng(11n);
    for (let i = 0; i < 1000; i += 1) {
      const f = prng.nextFloat();
      expect(f >= 0 && f < 1).toBe(true);
    }
  });

  it("nextBigintBelow is exact: always < n, covers small ranges", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1n << 64n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        (seed, n) => {
          const prng = createPrng(seed);
          for (let i = 0; i < 16; i += 1) {
            const v = prng.nextBigintBelow(n);
            expect(v >= 0n && v < n).toBe(true);
          }
        },
      ),
    );
    // n = 1 must always return 0.
    const prng = createPrng(3n);
    for (let i = 0; i < 16; i += 1) expect(prng.nextBigintBelow(1n)).toBe(0n);
    // Small range gets full coverage quickly (sanity, deterministic seed).
    const seen = new Set<string>();
    const p2 = createPrng(5n);
    for (let i = 0; i < 200; i += 1) seen.add(p2.nextBigintBelow(4n).toString());
    expect(seen).toEqual(new Set(["0", "1", "2", "3"]));
  });

  it("nextBigintBelow spans multi-word ranges (> 64 bits)", () => {
    const prng = createPrng(9n);
    const n = 1n << 130n;
    let sawLarge = false;
    for (let i = 0; i < 64; i += 1) {
      const v = prng.nextBigintBelow(n);
      expect(v >= 0n && v < n).toBe(true);
      if (v > 1n << 64n) sawLarge = true;
    }
    expect(sawLarge).toBe(true);
  });

  it("throws on non-positive bounds", () => {
    const prng = createPrng(1n);
    expect(() => prng.nextBigintBelow(0n)).toThrow(RangeError);
    expect(() => prng.nextBigintBelow(-5n)).toThrow(RangeError);
    expect(() => prng.nextIntBelow(0)).toThrow(RangeError);
    expect(() => prng.nextIntBelow(1.5)).toThrow(RangeError);
  });
});
