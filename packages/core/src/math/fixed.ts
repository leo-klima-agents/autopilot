/**
 * 1e18 fixed-point ("WAD") bigint arithmetic with Solidity-identical floor
 * semantics. Everything here is fixture-relevant (P2): unsigned, exact,
 * no floating point. All functions throw on negative inputs so rounding is
 * always a plain floor, exactly matching Solidity's unsigned division.
 */

/** The 1e18 fixed-point unit. */
export const WAD = 10n ** 18n;

/** Error thrown when a fixed-point invariant is violated. */
export class FixedPointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixedPointError";
  }
}

/** Throws if any argument is negative. Keeps every path unsigned. */
export function assertNonNegative(...values: readonly bigint[]): void {
  for (const v of values) {
    if (v < 0n) throw new FixedPointError(`negative value: ${v}`);
  }
}

/**
 * floor(a * b / denominator), exact over bigints.
 * Throws on a zero denominator or any negative input.
 * This is the single rounding primitive every fixture-relevant path uses;
 * the Solidity twin must implement the identical floor semantics.
 */
export function mulDiv(a: bigint, b: bigint, denominator: bigint): bigint {
  assertNonNegative(a, b, denominator);
  if (denominator === 0n) throw new FixedPointError("mulDiv: division by zero");
  return (a * b) / denominator;
}

/** floor(a * b / WAD). */
export function mulWad(a: bigint, b: bigint): bigint {
  return mulDiv(a, b, WAD);
}

/** floor(a * WAD / b). Throws when b is zero. */
export function divWad(a: bigint, b: bigint): bigint {
  return mulDiv(a, WAD, b);
}

/** Minimum of two bigints. */
export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

/** Maximum of two bigints. */
export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Clamps `x` into `[lo, hi]`. Throws if lo > hi. */
export function clampBig(x: bigint, lo: bigint, hi: bigint): bigint {
  if (lo > hi) throw new FixedPointError(`clamp: lo ${lo} > hi ${hi}`);
  return x < lo ? lo : x > hi ? hi : x;
}

/** Exact sum of a bigint array. */
export function sumBig(values: readonly bigint[]): bigint {
  let acc = 0n;
  for (const v of values) acc += v;
  return acc;
}

/** |a - b| without ever going negative. */
export function absDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/**
 * Exact integer square root: the largest `r` with `r * r <= n`.
 * Newton's method on bigints; throws on negative input.
 * Fixture-relevant (used by the water-filling allocator).
 */
export function isqrt(n: bigint): bigint {
  assertNonNegative(n);
  if (n < 2n) return n;
  // Initial guess: 2^(ceil(bitLength/2)) >= sqrt(n).
  let x = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

/** Number of bits needed to represent `n` (bitLength(0) === 0). */
export function bitLength(n: bigint): number {
  assertNonNegative(n);
  let bits = 0;
  while (n > 0n) {
    n >>= 1n;
    bits += 1;
  }
  return bits;
}
