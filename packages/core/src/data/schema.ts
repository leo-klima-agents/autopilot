/**
 * Versioned dataset JSON schema (schemaVersion: 1). All amounts are decimal
 * strings of raw wei — JSON has no bigint. `feesUsd` is USD scaled to Wad
 * (1e18) as a decimal integer string so revenue stays bigint-exact.
 */

/** One reward token amount (raw wei as a decimal string). */
export interface TokenAmount {
  token: string;
  amount: string;
}

/** One weekly epoch record for a pool. */
export interface EpochRecord {
  /** Epoch start timestamp (unix seconds, Thursday 00:00 UTC). */
  ts: number;
  /** Total votes on the pool at end of epoch (raw wei string). */
  votes: string;
  /** Gauge emission rate for the epoch (raw wei string). */
  emissions: string;
  /** Pool fees in USD, Wad-scaled decimal integer string. Optional. */
  feesUsd?: string;
  /** Bribe (incentive) amounts by token. */
  bribes: TokenAmount[];
  /** Fee amounts by token. */
  fees: TokenAmount[];
}

/** One pool with its epoch history. */
export interface PoolRecord {
  address: string;
  symbol: string;
  /** Composed display name, e.g. vAMM-WETH/USDC or CL100-WETH/USDC. */
  displayName: string;
  token0: string;
  token1: string;
  stable: boolean;
  /** Present for Slipstream (CL) pools only. */
  tickSpacing?: number;
  gaugeAlive: boolean;
  epochs: EpochRecord[];
}

/** The versioned dataset root. */
export interface DatasetV1 {
  schemaVersion: 1;
  chainId: number;
  /** ISO-8601 generation timestamp. */
  generatedAt: string;
  /** 'sugar' for on-chain datasets; 'synthetic' for generated scenarios. */
  source: "sugar" | "synthetic";
  pools: PoolRecord[];
}

const DECIMAL_RE = /^[0-9]+$/;

/** Parses a decimal integer string into a bigint; throws on anything else. */
export function parseAmount(value: string): bigint {
  if (!DECIMAL_RE.test(value)) throw new Error(`invalid decimal amount: ${JSON.stringify(value)}`);
  return BigInt(value);
}

function fail(path: string, message: string): never {
  throw new Error(`dataset validation failed at ${path}: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateTokenAmount(v: unknown, path: string): TokenAmount {
  if (!isRecord(v)) fail(path, "expected object");
  if (typeof v.token !== "string" || v.token.length === 0) fail(path, "token must be a string");
  if (typeof v.amount !== "string" || !DECIMAL_RE.test(v.amount)) {
    fail(path, "amount must be a decimal string");
  }
  return { token: v.token, amount: v.amount };
}

function validateEpoch(v: unknown, path: string): EpochRecord {
  if (!isRecord(v)) fail(path, "expected object");
  if (!Number.isInteger(v.ts) || (v.ts as number) < 0) fail(path, "ts must be a non-negative integer");
  if (typeof v.votes !== "string" || !DECIMAL_RE.test(v.votes)) fail(path, "votes must be a decimal string");
  if (typeof v.emissions !== "string" || !DECIMAL_RE.test(v.emissions)) {
    fail(path, "emissions must be a decimal string");
  }
  if (v.feesUsd !== undefined && (typeof v.feesUsd !== "string" || !DECIMAL_RE.test(v.feesUsd))) {
    fail(path, "feesUsd must be a decimal string when present");
  }
  if (!Array.isArray(v.bribes) || !Array.isArray(v.fees)) fail(path, "bribes/fees must be arrays");
  const epoch: EpochRecord = {
    ts: v.ts as number,
    votes: v.votes,
    emissions: v.emissions,
    bribes: v.bribes.map((b, i) => validateTokenAmount(b, `${path}.bribes[${i}]`)),
    fees: v.fees.map((f, i) => validateTokenAmount(f, `${path}.fees[${i}]`)),
  };
  if (v.feesUsd !== undefined) epoch.feesUsd = v.feesUsd as string;
  return epoch;
}

function validatePool(v: unknown, path: string): PoolRecord {
  if (!isRecord(v)) fail(path, "expected object");
  for (const key of ["address", "symbol", "displayName", "token0", "token1"] as const) {
    if (typeof v[key] !== "string" || (v[key] as string).length === 0) {
      fail(path, `${key} must be a non-empty string`);
    }
  }
  if (typeof v.stable !== "boolean") fail(path, "stable must be a boolean");
  if (typeof v.gaugeAlive !== "boolean") fail(path, "gaugeAlive must be a boolean");
  if (v.tickSpacing !== undefined && !Number.isInteger(v.tickSpacing)) {
    fail(path, "tickSpacing must be an integer when present");
  }
  if (!Array.isArray(v.epochs)) fail(path, "epochs must be an array");
  const pool: PoolRecord = {
    address: v.address as string,
    symbol: v.symbol as string,
    displayName: v.displayName as string,
    token0: v.token0 as string,
    token1: v.token1 as string,
    stable: v.stable,
    gaugeAlive: v.gaugeAlive,
    epochs: v.epochs.map((e, i) => validateEpoch(e, `${path}.epochs[${i}]`)),
  };
  if (v.tickSpacing !== undefined) pool.tickSpacing = v.tickSpacing as number;
  return pool;
}

/** Validates an unknown JSON value as a DatasetV1, throwing with a path on failure. */
export function validateDataset(value: unknown): DatasetV1 {
  if (!isRecord(value)) fail("$", "expected object");
  if (value.schemaVersion !== 1) fail("$.schemaVersion", `expected 1, got ${String(value.schemaVersion)}`);
  if (!Number.isInteger(value.chainId)) fail("$.chainId", "expected integer");
  if (typeof value.generatedAt !== "string") fail("$.generatedAt", "expected string");
  if (value.source !== "sugar" && value.source !== "synthetic") {
    fail("$.source", "expected 'sugar' or 'synthetic'");
  }
  if (!Array.isArray(value.pools)) fail("$.pools", "expected array");
  return {
    schemaVersion: 1,
    chainId: value.chainId as number,
    generatedAt: value.generatedAt,
    source: value.source,
    pools: value.pools.map((p, i) => validatePool(p, `$.pools[${i}]`)),
  };
}
