import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  absDiff,
  bitLength,
  clampBig,
  divWad,
  FixedPointError,
  isqrt,
  maxBig,
  minBig,
  mulDiv,
  mulWad,
  sumBig,
  WAD,
} from "../src/math/fixed.js";
import { splitProportionally } from "../src/math/split.js";

const bigNonNeg = fc.bigInt({ min: 0n, max: 10n ** 30n });
const bigPos = fc.bigInt({ min: 1n, max: 10n ** 30n });

describe("mulDiv", () => {
  it("matches the naive bigint expression exactly (floor)", () => {
    fc.assert(
      fc.property(bigNonNeg, bigNonNeg, bigPos, (a, b, d) => {
        expect(mulDiv(a, b, d)).toBe((a * b) / d);
      }),
    );
  });

  it("floors: mulDiv(a,b,d)*d <= a*b < (mulDiv(a,b,d)+1)*d", () => {
    fc.assert(
      fc.property(bigNonNeg, bigNonNeg, bigPos, (a, b, d) => {
        const q = mulDiv(a, b, d);
        expect(q * d <= a * b).toBe(true);
        expect((q + 1n) * d > a * b).toBe(true);
      }),
    );
  });

  it("is monotone in each argument", () => {
    fc.assert(
      fc.property(bigNonNeg, bigNonNeg, bigNonNeg, bigPos, (a1, a2, b, d) => {
        const [lo, hi] = a1 <= a2 ? [a1, a2] : [a2, a1];
        expect(mulDiv(lo, b, d) <= mulDiv(hi, b, d)).toBe(true);
      }),
    );
  });

  it("has no precision loss for exactly divisible products", () => {
    fc.assert(
      fc.property(bigNonNeg, bigPos, (a, d) => {
        expect(mulDiv(a * d, 1n, d)).toBe(a);
        expect(mulDiv(a, d, d)).toBe(a);
      }),
    );
  });

  it("throws on zero denominator and on negatives", () => {
    expect(() => mulDiv(1n, 1n, 0n)).toThrow(FixedPointError);
    expect(() => mulDiv(-1n, 1n, 1n)).toThrow(FixedPointError);
    expect(() => mulDiv(1n, -1n, 1n)).toThrow(FixedPointError);
    expect(() => mulDiv(1n, 1n, -1n)).toThrow(FixedPointError);
  });
});

describe("mulWad / divWad", () => {
  it("mulWad(divWad(a,b), b) round-trips within floor bounds", () => {
    fc.assert(
      fc.property(bigNonNeg, bigPos, (a, b) => {
        const roundTrip = mulWad(divWad(a, b), b);
        expect(roundTrip <= a).toBe(true);
        // Each floor loses < 1 unit scaled by b/WAD (plus one from mulWad).
        expect(a - roundTrip <= b / WAD + 1n).toBe(true);
      }),
    );
  });

  it("mulWad(x, WAD) === x and divWad(x, WAD) === x", () => {
    fc.assert(
      fc.property(bigNonNeg, (x) => {
        expect(mulWad(x, WAD)).toBe(x);
        expect(divWad(x, WAD)).toBe(x);
      }),
    );
  });
});

describe("min/max/clamp/sum/absDiff", () => {
  it("minBig/maxBig agree with comparison", () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), (a, b) => {
        expect(minBig(a, b)).toBe(a < b ? a : b);
        expect(maxBig(a, b)).toBe(a > b ? a : b);
      }),
    );
  });

  it("clampBig stays in range and throws on inverted bounds", () => {
    fc.assert(
      fc.property(fc.bigInt(), fc.bigInt(), fc.bigInt(), (x, a, b) => {
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const c = clampBig(x, lo, hi);
        expect(c >= lo && c <= hi).toBe(true);
      }),
    );
    expect(() => clampBig(0n, 1n, 0n)).toThrow(FixedPointError);
  });

  it("sumBig sums exactly", () => {
    fc.assert(
      fc.property(fc.array(fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n })), (xs) => {
        expect(sumBig(xs)).toBe(xs.reduce((a, b) => a + b, 0n));
      }),
    );
  });

  it("absDiff is symmetric and non-negative", () => {
    fc.assert(
      fc.property(bigNonNeg, bigNonNeg, (a, b) => {
        expect(absDiff(a, b)).toBe(absDiff(b, a));
        expect(absDiff(a, b) >= 0n).toBe(true);
        expect(absDiff(a, b)).toBe(a >= b ? a - b : b - a);
      }),
    );
  });
});

describe("isqrt", () => {
  it("returns the exact integer square root", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), (n) => {
        const r = isqrt(n);
        expect(r * r <= n).toBe(true);
        expect((r + 1n) * (r + 1n) > n).toBe(true);
      }),
    );
  });

  it("handles perfect squares and small values", () => {
    expect(isqrt(0n)).toBe(0n);
    expect(isqrt(1n)).toBe(1n);
    expect(isqrt(3n)).toBe(1n);
    expect(isqrt(4n)).toBe(2n);
    expect(isqrt(10n ** 36n)).toBe(10n ** 18n);
    expect(() => isqrt(-1n)).toThrow(FixedPointError);
  });
});

describe("bitLength", () => {
  it("matches 2^k boundaries", () => {
    expect(bitLength(0n)).toBe(0);
    expect(bitLength(1n)).toBe(1);
    expect(bitLength(255n)).toBe(8);
    expect(bitLength(256n)).toBe(9);
    fc.assert(
      fc.property(bigPos, (n) => {
        const bits = bitLength(n);
        expect(1n << BigInt(bits - 1) <= n).toBe(true);
        expect(n < 1n << BigInt(bits)).toBe(true);
      }),
    );
  });
});

describe("splitProportionally", () => {
  const scoresArb = fc
    .array(fc.tuple(fc.string({ minLength: 1, maxLength: 6 }), bigNonNeg), {
      minLength: 1,
      maxLength: 10,
    })
    .map((pairs) => new Map(pairs));

  it("always sums exactly to the total", () => {
    fc.assert(
      fc.property(bigNonNeg, scoresArb, (total, scores) => {
        const out = splitProportionally(total, scores);
        expect(sumBig([...out.values()])).toBe(total);
        expect(out.size).toBe(scores.size);
      }),
    );
  });

  it("is independent of map insertion order", () => {
    fc.assert(
      fc.property(bigNonNeg, scoresArb, (total, scores) => {
        const reversed = new Map([...scores.entries()].reverse());
        expect(splitProportionally(total, scores)).toEqual(
          splitProportionally(total, reversed),
        );
      }),
    );
  });

  it("gives remainder to the largest score first, ties by key", () => {
    const out = splitProportionally(10n, new Map([
      ["b", 1n],
      ["a", 1n],
      ["c", 1n],
    ]));
    // 10/3 = 3 each, remainder 1 goes to lexicographically smallest on tie.
    expect(out.get("a")).toBe(4n);
    expect(out.get("b")).toBe(3n);
    expect(out.get("c")).toBe(3n);
  });

  it("splits uniformly when all scores are zero", () => {
    const out = splitProportionally(7n, new Map([["x", 0n], ["y", 0n], ["z", 0n]]));
    expect([...out.values()].sort()).toEqual([2n, 2n, 3n]);
    expect(out.get("x")).toBe(3n); // remainder to smallest keys
  });

  it("throws on empty input or negative values", () => {
    expect(() => splitProportionally(1n, new Map())).toThrow(FixedPointError);
    expect(() => splitProportionally(-1n, new Map([["a", 1n]]))).toThrow(FixedPointError);
    expect(() => splitProportionally(1n, new Map([["a", -1n]]))).toThrow(FixedPointError);
  });
});
