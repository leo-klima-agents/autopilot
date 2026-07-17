import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WAD } from "../src/math/fixed.js";
import { WEEK } from "../src/model/types.js";
import { parseAmount, validateDataset, type DatasetV1 } from "../src/data/schema.js";
import { epochRevenueWad, revenueProcessFromDataset } from "../src/data/revenue.js";
import { generateSyntheticDataset } from "../src/data/synthetic.js";
import { epochsForMonths, sugarEpochToRecord } from "../src/data/sugar.js";
import {
  composeDisplayName,
  loadTokenCache,
  resolveTokens,
  sanitizeName,
  sanitizeSymbol,
  saveTokenCache,
  type Erc20Reader,
} from "../src/data/tokens.js";
import { T0 } from "./helpers.js";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "core-data-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("dataset schema", () => {
  const valid: DatasetV1 = {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: "2026-07-17T00:00:00.000Z",
    source: "sugar",
    pools: [
      {
        address: "0xpool",
        symbol: "vAMM-A/B",
        displayName: "vAMM-A/B",
        token0: "0xa",
        token1: "0xb",
        stable: false,
        gaugeAlive: true,
        epochs: [
          {
            ts: T0,
            votes: "100",
            emissions: "5",
            feesUsd: "1000000000000000000",
            bribes: [{ token: "0xa", amount: "7" }],
            fees: [{ token: "0xb", amount: "9" }],
          },
        ],
      },
    ],
  };

  it("accepts a valid dataset (round-trips through JSON)", () => {
    expect(validateDataset(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it("rejects structural violations with a path", () => {
    expect(() => validateDataset({})).toThrow(/schemaVersion/);
    expect(() => validateDataset({ ...valid, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validateDataset({ ...valid, source: "other" })).toThrow(/\$\.source/);
    const badAmount = JSON.parse(JSON.stringify(valid)) as Record<string, unknown>;
    (badAmount as DatasetV1).pools[0]!.epochs[0]!.votes = "1.5";
    expect(() => validateDataset(badAmount)).toThrow(/pools\[0\]\.epochs\[0\]/);
  });

  it("parseAmount is strict decimal", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    expect(() => parseAmount("-1")).toThrow(/invalid/);
    expect(() => parseAmount("1e5")).toThrow(/invalid/);
    expect(() => parseAmount("")).toThrow(/invalid/);
  });

  it("epochRevenueWad prefers feesUsd, else sums fees + bribes", () => {
    expect(epochRevenueWad(valid.pools[0]!.epochs[0]!)).toBe(WAD);
    const { feesUsd: _drop, ...rest } = valid.pools[0]!.epochs[0]!;
    expect(epochRevenueWad(rest)).toBe(16n);
  });
});

describe("revenueProcessFromDataset", () => {
  const dataset = generateSyntheticDataset({
    seed: 1n,
    poolCount: 2,
    epochCount: 3,
    kind: "persistent",
    startTs: T0,
  });
  const process = revenueProcessFromDataset(dataset);
  const pool = dataset.pools[0]!.address;

  it("is additive on integer-second boundaries", () => {
    const whole = process.revenueBetween(pool, T0, T0 + 2 * WEEK);
    const split =
      process.revenueBetween(pool, T0, T0 + 12_345) +
      process.revenueBetween(pool, T0 + 12_345, T0 + 2 * WEEK);
    expect(whole).toBe(split);
  });

  it("integrates each epoch to floor(revenue/WEEK) * WEEK", () => {
    const epoch = dataset.pools[0]!.epochs[0]!;
    const revenue = epochRevenueWad(epoch);
    expect(process.revenueBetween(pool, epoch.ts, epoch.ts + WEEK)).toBe(
      (revenue / BigInt(WEEK)) * BigInt(WEEK),
    );
  });

  it("is zero outside recorded epochs and for unknown pools", () => {
    expect(process.revenueBetween(pool, T0 - WEEK, T0)).toBe(0n);
    expect(process.revenueBetween("nope", T0, T0 + WEEK)).toBe(0n);
    expect(process.revenueBetween(pool, T0 + 100, T0 + 100)).toBe(0n);
  });
});

describe("generateSyntheticDataset", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const cfg = { poolCount: 3, epochCount: 5, kind: "bursty" as const, startTs: T0 };
    expect(generateSyntheticDataset({ seed: 9n, ...cfg })).toEqual(
      generateSyntheticDataset({ seed: 9n, ...cfg }),
    );
    expect(generateSyntheticDataset({ seed: 9n, ...cfg })).not.toEqual(
      generateSyntheticDataset({ seed: 10n, ...cfg }),
    );
  });

  it("emits schema-valid datasets for all three process kinds", () => {
    for (const kind of ["persistent", "bursty", "regime"] as const) {
      const dataset = generateSyntheticDataset({
        seed: 5n,
        poolCount: 2,
        epochCount: 4,
        kind,
        startTs: T0,
      });
      const validated = validateDataset(JSON.parse(JSON.stringify(dataset)));
      expect(validated.source).toBe("synthetic");
      expect(validated.pools).toHaveLength(2);
      for (const pool of validated.pools) {
        expect(pool.epochs).toHaveLength(4);
        for (const [i, epoch] of pool.epochs.entries()) {
          expect(epoch.ts).toBe(T0 + i * WEEK);
          expect(parseAmount(epoch.feesUsd!) > 0n).toBe(true);
        }
      }
    }
  });

  it("week-aligns the start timestamp", () => {
    const dataset = generateSyntheticDataset({
      seed: 2n,
      poolCount: 1,
      epochCount: 1,
      kind: "persistent",
      startTs: T0 + 12_345,
    });
    expect(dataset.pools[0]!.epochs[0]!.ts).toBe(T0);
  });
});

describe("sugar mapping helpers", () => {
  it("sugarEpochToRecord maps the LpEpoch tuple to the schema", () => {
    const record = sugarEpochToRecord({
      ts: BigInt(T0),
      lp: "0x0000000000000000000000000000000000000001",
      votes: 100n,
      emissions: 7n,
      bribes: [{ token: "0x0000000000000000000000000000000000000002", amount: 3n }],
      fees: [],
    });
    expect(record).toEqual({
      ts: T0,
      votes: "100",
      emissions: "7",
      bribes: [{ token: "0x0000000000000000000000000000000000000002", amount: "3" }],
      fees: [],
    });
  });

  it("epochsForMonths covers 12 months with ~52 epochs", () => {
    expect(epochsForMonths(12)).toBeGreaterThanOrEqual(52);
    expect(epochsForMonths(12)).toBeLessThanOrEqual(54);
  });
});

describe("token sanitization and display names", () => {
  it("strips control characters and clamps lengths", () => {
    expect(sanitizeSymbol("WE\u0000TH")).toBe("WETH");
    expect(sanitizeSymbol("\u202eEVIL")).toBe("EVIL");
    expect(sanitizeSymbol("X".repeat(100))).toHaveLength(32);
    expect(sanitizeName("N\u0007ame".repeat(30))).toHaveLength(64);
    expect(sanitizeSymbol("  padded  ")).toBe("padded");
  });

  it("composes v2 and Slipstream display names", () => {
    expect(composeDisplayName({ stable: false }, "WETH", "USDC")).toBe("vAMM-WETH/USDC");
    expect(composeDisplayName({ stable: true }, "USDC", "USDbC")).toBe("sAMM-USDC/USDbC");
    expect(composeDisplayName({ stable: false, tickSpacing: 100 }, "WETH", "USDC")).toBe(
      "CL100-WETH/USDC",
    );
  });

  it("token cache round-trips through disk", () => {
    const path = join(tempDir(), "tokens.json");
    expect(loadTokenCache(path)).toEqual({ schemaVersion: 1, tokens: {} });
    const cache = {
      schemaVersion: 1 as const,
      tokens: { "0xa": { name: "A", symbol: "A", decimals: 18, logo: null } },
    };
    saveTokenCache(path, cache);
    expect(loadTokenCache(path)).toEqual(cache);
    expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
  });
});

describe("resolveTokens (offline, injected clients)", () => {
  const onchainReader = (symbol: string): Erc20Reader => ({
    readContract: ({ functionName }) =>
      Promise.resolve(
        functionName === "symbol" ? symbol : functionName === "name" ? `${symbol} Token` : 18,
      ),
  });

  it("prefers on-chain metadata and persists the cache", async () => {
    const path = join(tempDir(), "tokens.json");
    const cache = await resolveTokens(["0xAA"], {
      client: onchainReader("WETH"),
      cachePath: path,
      log: () => {},
    });
    expect(cache.tokens["0xaa"]).toEqual({
      name: "WETH Token",
      symbol: "WETH",
      decimals: 18,
      logo: null,
    });
    expect(loadTokenCache(path).tokens["0xaa"]).toBeDefined();
  });

  it("skips cached addresses (idempotent) and never re-reads them", async () => {
    const path = join(tempDir(), "tokens.json");
    let reads = 0;
    const counting: Erc20Reader = {
      readContract: (args) => {
        reads += 1;
        return onchainReader("X").readContract(args);
      },
    };
    await resolveTokens(["0xbb"], { client: counting, cachePath: path, log: () => {} });
    const readsAfterFirst = reads;
    await resolveTokens(["0xbb"], { client: counting, cachePath: path, log: () => {} });
    expect(reads).toBe(readsAfterFirst);
  });

  it("fills gaps from Alchemy and logs conflicts", async () => {
    const logs: string[] = [];
    const failingReader: Erc20Reader = {
      readContract: ({ functionName }) =>
        functionName === "symbol"
          ? Promise.resolve("ONCHAIN")
          : Promise.reject(new Error("no fn")),
    };
    const fakeFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { name: "Alchemy Name", symbol: "ALCH", decimals: 6, logo: "https://x/y.png" },
          }),
        ),
      )) as typeof fetch;
    // Patch global fetch for this call.
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch;
    try {
      const cache = await resolveTokens(["0xcc"], {
        client: failingReader,
        alchemyApiKey: "test-key",
        log: (m) => logs.push(m),
      });
      expect(cache.tokens["0xcc"]).toEqual({
        symbol: "ONCHAIN", // on-chain wins
        name: "Alchemy Name", // gap filled
        decimals: 6,
        logo: "https://x/y.png",
      });
      expect(logs.some((l) => l.includes("conflict"))).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("sanitizes hostile metadata", async () => {
    const hostile: Erc20Reader = {
      readContract: ({ functionName }) =>
        Promise.resolve(
          functionName === "symbol"
            ? "\u0000EVIL‮" + "A".repeat(64)
            : functionName === "name"
              ? "bad\u0007name"
              : 18,
        ),
    };
    const cache = await resolveTokens(["0xdd"], { client: hostile, log: () => {} });
    expect(cache.tokens["0xdd"]!.symbol).toHaveLength(32);
    expect(cache.tokens["0xdd"]!.symbol.includes("\u0000")).toBe(false);
    expect(cache.tokens["0xdd"]!.name).toBe("badname");
  });
});
