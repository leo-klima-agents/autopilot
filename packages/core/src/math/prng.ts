/**
 * Deterministic seeded PRNG: splitmix64 (for seeding / simple streams) and
 * xoshiro256** (main generator). No Math.random anywhere in src/ — every
 * random draw in the package flows through this module so simulations,
 * synthetic datasets and fixture vectors are reproducible from a seed.
 *
 * Raw draws are exact uint64 bigints; `nextFloat` is provided only for
 * analytics/plotting and must never be used on a fixture-relevant path.
 */

const MASK64 = (1n << 64n) - 1n;

/** Rotate-left over 64 bits. */
function rotl64(x: bigint, k: bigint): bigint {
  return ((x << k) | (x >> (64n - k))) & MASK64;
}

/**
 * splitmix64 stream. Returns a function producing successive uint64 values.
 * Reference: Steele, Lea, Flood (2014); same constants as the canonical C.
 */
export function splitmix64(seed: bigint): () => bigint {
  let state = seed & MASK64;
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK64;
    let z = state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
    return (z ^ (z >> 31n)) & MASK64;
  };
}

/** Deterministic pseudo-random number generator. */
export interface Prng {
  /** Next raw uint64 as a bigint in [0, 2^64). Exact. */
  nextUint64(): bigint;
  /**
   * Uniform double in [0, 1) using the top 53 bits.
   * Analytics only — never use in fixture-relevant math.
   */
  nextFloat(): number;
  /**
   * Uniform bigint in [0, n) via rejection sampling — exact, no modulo bias.
   * Throws when n <= 0.
   */
  nextBigintBelow(n: bigint): bigint;
  /** Uniform safe integer in [0, n) (n <= 2^53). Exact (via nextBigintBelow). */
  nextIntBelow(n: number): number;
}

/**
 * Creates a xoshiro256** generator whose 256-bit state is seeded from
 * splitmix64(seed), per the authors' recommendation.
 */
export function createPrng(seed: bigint): Prng {
  const sm = splitmix64(seed);
  let s0 = sm();
  let s1 = sm();
  let s2 = sm();
  let s3 = sm();

  function nextUint64(): bigint {
    const result = (rotl64((s1 * 5n) & MASK64, 7n) * 9n) & MASK64;
    const t = (s1 << 17n) & MASK64;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl64(s3, 45n);
    return result;
  }

  function nextBigintBelow(n: bigint): bigint {
    if (n <= 0n) throw new RangeError(`nextBigintBelow: n must be positive, got ${n}`);
    // Number of bits needed; draw that many bits and reject values >= n.
    let bits = 0n;
    for (let m = n - 1n; m > 0n; m >>= 1n) bits += 1n;
    if (bits === 0n) return 0n; // n === 1
    const words = Number((bits + 63n) / 64n);
    const mask = (1n << bits) - 1n;
    for (;;) {
      let x = 0n;
      for (let i = 0; i < words; i += 1) x = (x << 64n) | nextUint64();
      x &= mask;
      if (x < n) return x;
    }
  }

  return {
    nextUint64,
    nextFloat: () => Number(nextUint64() >> 11n) / 2 ** 53,
    nextBigintBelow,
    nextIntBelow: (n: number) => {
      if (!Number.isSafeInteger(n) || n <= 0) {
        throw new RangeError(`nextIntBelow: n must be a positive safe integer, got ${n}`);
      }
      return Number(nextBigintBelow(BigInt(n)));
    },
  };
}
