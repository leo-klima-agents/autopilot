import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { WAD } from "../src/math/fixed.js";
import { WEEK } from "../src/model/types.js";
import { parseAmount, validateDataset, type DatasetV1 } from "../src/data/schema.js";
import { epochRevenueWad, revenueProcessFromDataset } from "../src/data/revenue.js";
import {
  generateSyntheticDataset,
  GROWTH_POOL_INDEX,
  GROWTH_RAMP_EPOCHS,
  GROWTH_RAMP_START,
  TOTAL_VEAERO_WAD,
  WEEKLY_EMISSIONS_WAD,
} from "../src/data/synthetic.js";
import {
  epochsForMonths,
  fetchLatestEpochs,
  selectVoteCandidates,
  sugarEpochToRecord,
  type SugarClient,
  type SugarLp,
  type SugarLpEpoch,
} from "../src/data/sugar.js";
import { computeEpochUsd, usdWadOf } from "../src/data/usd.js";
import { fetchHistoricalPrices, loadPriceCache, savePriceCache } from "../src/data/prices.js";
import { rankPoolsByUsdRevenue } from "../src/data/cli.js";
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

  it("emits schema-valid datasets for all four process kinds", () => {
    for (const kind of ["persistent", "bursty", "regime", "mixed"] as const) {
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

  it("rejects an unknown process kind", () => {
    expect(() =>
      generateSyntheticDataset({
        seed: 1n,
        poolCount: 1,
        epochCount: 1,
        kind: "chaotic" as never,
      }),
    ).toThrow(/unknown kind/);
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

  it("names pools like the real venue (CL/vAMM/sAMM, tickSpacing, stable)", () => {
    const dataset = generateSyntheticDataset({
      seed: 3n,
      poolCount: 30,
      epochCount: 2,
      kind: "mixed",
      startTs: T0,
    });
    for (const pool of dataset.pools) {
      expect(pool.displayName).toMatch(/^(CL\d+|vAMM|sAMM)-[^/]+\/.+$/);
      if (pool.displayName.startsWith("CL")) {
        expect(pool.tickSpacing).toBeGreaterThan(0);
        expect(pool.stable).toBe(false);
      } else {
        expect(pool.tickSpacing).toBeUndefined();
        expect(pool.stable).toBe(pool.displayName.startsWith("sAMM"));
      }
    }
    // the roster reaches past its fixed entries into the deterministic tail
    expect(dataset.pools.at(-1)!.displayName).toMatch(/^vAMM-SIM\d+\/USDC$/);
    // realistic headline: the largest pool is the CL100 WETH/USDC book
    expect(dataset.pools[0]!.displayName).toBe("CL100-WETH/USDC");
  });

  it("populates bribes, with bribe-dominant archetypes exceeding their fees", () => {
    // 24 pools reaches the sAMM bribe-farm entries at the roster tail.
    const dataset = generateSyntheticDataset({
      seed: 4n,
      poolCount: 24,
      epochCount: 6,
      kind: "mixed",
      startTs: T0,
    });
    const bribed = dataset.pools.filter((p) =>
      p.epochs.some((e) => parseAmount(e.bribesUsd ?? "0") > 0n),
    );
    expect(bribed.length).toBeGreaterThan(5);
    const sammFarm = dataset.pools.find((p) => p.displayName === "sAMM-WETH/msETH")!;
    for (const epoch of sammFarm.epochs) {
      expect(parseAmount(epoch.bribesUsd!) > parseAmount(epoch.feesUsd!)).toBe(true);
      expect(epoch.bribes).toHaveLength(1);
    }
    // headline pools are effectively unbribed, like the real book
    const top = dataset.pools[0]!;
    for (const epoch of top.epochs) {
      expect(parseAmount(epoch.bribesUsd ?? "0") < parseAmount(epoch.feesUsd!) / 100n).toBe(true);
    }
  });

  it("splits votes and emissions exactly across the universe at real scale", () => {
    const poolCount = 8;
    const dataset = generateSyntheticDataset({
      seed: 6n,
      poolCount,
      epochCount: 3,
      kind: "mixed",
      startTs: T0,
    });
    for (let e = 0; e < 3; e += 1) {
      let votes = 0n;
      let emissionsPerSec = 0n;
      for (const pool of dataset.pools) {
        votes += parseAmount(pool.epochs[e]!.votes);
        emissionsPerSec += parseAmount(pool.epochs[e]!.emissions);
      }
      // votes split the veAERO total exactly
      expect(votes).toBe(TOTAL_VEAERO_WAD);
      // per-second emission rates integrate to the weekly budget, up to the
      // per-pool floor when converting weekly amounts to rates
      const weekly = emissionsPerSec * BigInt(WEEK);
      expect(weekly <= WEEKLY_EMISSIONS_WAD).toBe(true);
      expect(weekly > WEEKLY_EMISSIONS_WAD - BigInt(poolCount) * BigInt(WEEK)).toBe(true);
    }
  });

  it("keeps existing pools' fee paths bit-identical when poolCount grows", () => {
    const small = generateSyntheticDataset({
      seed: 8n,
      poolCount: 4,
      epochCount: 6,
      kind: "mixed",
      startTs: T0,
    });
    const large = generateSyntheticDataset({
      seed: 8n,
      poolCount: 9,
      epochCount: 6,
      kind: "mixed",
      startTs: T0,
    });
    for (let p = 0; p < 4; p += 1) {
      expect(large.pools[p]!.epochs.map((e) => e.feesUsd)).toEqual(
        small.pools[p]!.epochs.map((e) => e.feesUsd),
      );
      expect(large.pools[p]!.epochs.map((e) => e.bribesUsd)).toEqual(
        small.pools[p]!.epochs.map((e) => e.bribesUsd),
      );
    }
  });

  it("ramps the growth pool through the adoption window (mixed only)", () => {
    const epochCount = GROWTH_RAMP_START + GROWTH_RAMP_EPOCHS + 2;
    const mixed = generateSyntheticDataset({
      seed: 5n,
      poolCount: 6,
      epochCount,
      kind: "mixed",
      startTs: T0,
    });
    const growth = mixed.pools[GROWTH_POOL_INDEX]!;
    expect(growth.displayName).toContain("cbBTC");
    const pre = parseAmount(growth.epochs[GROWTH_RAMP_START - 1]!.feesUsd!);
    const post = parseAmount(growth.epochs[GROWTH_RAMP_START + GROWTH_RAMP_EPOCHS]!.feesUsd!);
    expect(post > 8n * pre).toBe(true);
    // legacy kinds keep the pool flat (one global process, no ramp)
    const flat = generateSyntheticDataset({
      seed: 5n,
      poolCount: 6,
      epochCount,
      kind: "persistent",
      startTs: T0,
    });
    const flatPool = flat.pools[GROWTH_POOL_INDEX]!;
    const flatPre = parseAmount(flatPool.epochs[GROWTH_RAMP_START - 1]!.feesUsd!);
    const flatPost = parseAmount(
      flatPool.epochs[GROWTH_RAMP_START + GROWTH_RAMP_EPOCHS]!.feesUsd!,
    );
    expect(flatPost < 4n * flatPre).toBe(true);
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

// ---------------------------------------------------------------------------
// USD pricing pipeline (ldeso-inspired): computeEpochUsd, schema extensions,
// combined revenue branch, vote-candidate selection, USD ranking
// ---------------------------------------------------------------------------

describe("computeEpochUsd", () => {
  // Thu 2025-07-17 00:00 UTC
  const TS = 1_752_710_400;
  const USDC = "0x00000000000000000000000000000000000000c1";
  const WETH = "0x00000000000000000000000000000000000000c2";
  const JUNK = "0x00000000000000000000000000000000000000c3";
  const decimals = new Map([
    [USDC, 6],
    [WETH, 18],
  ]);
  const prices = new Map([
    [`${USDC}|2025-07-17`, WAD], // $1
    [`${WETH}|2025-07-17`, 3_000n * WAD], // $3000
  ]);
  const deps = {
    decimalsOf: (addr: string) => decimals.get(addr),
    priceWadAt: (addr: string, date: string) => prices.get(`${addr}|${date}`),
  };

  it("prices mixed-decimal fees and bribes into separate buckets, exactly", () => {
    const result = computeEpochUsd(
      {
        ts: TS,
        votes: "0",
        emissions: "0",
        fees: [
          { token: USDC, amount: "20184366214" }, // 20,184.366214 USDC
          { token: WETH, amount: "1500000000000000000" }, // 1.5 WETH
        ],
        bribes: [{ token: WETH, amount: "250000000000000000" }], // 0.25 WETH
      },
      deps,
    );
    expect(result.feesUsd).toBe(20_184_366_214n * WAD / 1_000_000n + 4_500n * WAD);
    expect(result.bribesUsd).toBe(750n * WAD);
    expect(result.pricedAmounts).toBe(3);
    expect(result.totalAmounts).toBe(3);
  });

  it("floors indivisible conversions (per-amount floor, order-independent)", () => {
    // 1 wei of an 18-dec token at $1 -> floor(1 * 1e18 / 1e18) = 1 wei-USD
    expect(usdWadOf(1n, WAD, 18)).toBe(1n);
    // 1 raw unit of a 6-dec token at $0.000001999... floors
    expect(usdWadOf(1n, 1_999_999_999_999n, 6)).toBe(1_999_999n);
  });

  it("skips and counts unpriced or unknown-decimals tokens", () => {
    const result = computeEpochUsd(
      {
        ts: TS,
        votes: "0",
        emissions: "0",
        fees: [{ token: USDC, amount: "1000000" }],
        bribes: [{ token: JUNK, amount: "5" }],
      },
      deps,
    );
    expect(result.feesUsd).toBe(WAD);
    expect(result.bribesUsd).toBe(0n);
    expect(result.pricedAmounts).toBe(1);
    expect(result.totalAmounts).toBe(2);
  });

  it("ignores zero amounts entirely", () => {
    const result = computeEpochUsd(
      { ts: TS, votes: "0", emissions: "0", fees: [{ token: USDC, amount: "0" }], bribes: [] },
      deps,
    );
    expect(result.totalAmounts).toBe(0);
  });
});

describe("schema: USD fields", () => {
  const priced: DatasetV1 = {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: "2026-07-18T00:00:00Z",
    source: "sugar",
    pricedAt: "2026-07-18T00:00:00Z",
    pools: [
      {
        address: "0xpool",
        symbol: "s",
        displayName: "CL100-WETH/USDC",
        token0: "0x1",
        token1: "0x2",
        stable: false,
        tickSpacing: 100,
        gaugeAlive: true,
        pricing: { pricedAmounts: 3, totalAmounts: 4 },
        epochs: [
          {
            ts: 1_752_710_400,
            votes: "1",
            emissions: "2",
            feesUsd: "3000000000000000000",
            bribesUsd: "1000000000000000000",
            bribes: [],
            fees: [],
          },
        ],
      },
    ],
  };

  it("round-trips bribesUsd, pricing, and pricedAt", () => {
    expect(validateDataset(JSON.parse(JSON.stringify(priced)))).toEqual(priced);
  });

  it("rejects malformed bribesUsd and negative pricing counts", () => {
    const bad1 = JSON.parse(JSON.stringify(priced)) as DatasetV1;
    bad1.pools[0]!.epochs[0]!.bribesUsd = "1.5";
    expect(() => validateDataset(bad1)).toThrow(/bribesUsd/);

    const bad2 = JSON.parse(JSON.stringify(priced)) as DatasetV1;
    bad2.pools[0]!.pricing = { pricedAmounts: -1, totalAmounts: 4 };
    expect(() => validateDataset(bad2)).toThrow(/pricing/);
  });

  it("epochRevenueWad sums feesUsd + bribesUsd when priced", () => {
    expect(epochRevenueWad(priced.pools[0]!.epochs[0]!)).toBe(4n * WAD);
    // bribesUsd-only edge
    expect(
      epochRevenueWad({ ts: 0, votes: "0", emissions: "0", bribesUsd: "7", bribes: [], fees: [] }),
    ).toBe(7n);
  });
});

describe("pool selection", () => {
  const mkLp = (lp: string, type: number, alive = true): SugarLp => ({
    lp: lp as SugarLp["lp"],
    symbol: lp,
    type,
    token0: "0x1" as SugarLp["token0"],
    token1: "0x2" as SugarLp["token1"],
    gauge_alive: alive,
    liquidity: 0n,
    emissions: 0n,
  });
  const mkLatest = (lp: string, votes: bigint): SugarLpEpoch => ({
    ts: 1n,
    lp: lp as SugarLpEpoch["lp"],
    votes,
    emissions: 0n,
    bribes: [],
    fees: [],
  });

  it("selectVoteCandidates: votes-desc, CL included, dead gauges excluded, address tie-break", () => {
    const lps = [mkLp("0xa", -1), mkLp("0xb", 100), mkLp("0xc", 0, false), mkLp("0xd", 50)];
    const latest = [
      mkLatest("0xa", 5n),
      mkLatest("0xb", 9n), // CL pool, most votes
      mkLatest("0xc", 100n), // dead gauge, excluded despite votes
      mkLatest("0xd", 5n), // ties 0xa, address order
      mkLatest("0xe", 3n), // not in the Lp map, ignored
    ];
    const picked = selectVoteCandidates(lps, latest, 3);
    expect(picked.map((p) => p.lp)).toEqual(["0xb", "0xa", "0xd"]);
    expect(picked[0]!.type).toBe(100); // the CL pool made it
  });

  it("rankPoolsByUsdRevenue: USD-desc, unpriced pools last, deterministic ties", () => {
    const mkPool = (address: string, feesUsd?: string, bribesUsd?: string) => ({
      address,
      symbol: "s",
      displayName: address,
      token0: "0x1",
      token1: "0x2",
      stable: false,
      gaugeAlive: true,
      epochs: [
        {
          ts: 1_752_710_400,
          votes: "0",
          emissions: "0",
          ...(feesUsd !== undefined ? { feesUsd } : {}),
          ...(bribesUsd !== undefined ? { bribesUsd } : {}),
          bribes: [],
          fees: [],
        },
      ],
    });
    const ranked = rankPoolsByUsdRevenue(
      [mkPool("0xa", "5"), mkPool("0xb", "3", "4"), mkPool("0xc"), mkPool("0xd")],
      3,
    );
    expect(ranked.map((p) => p.address)).toEqual(["0xb", "0xa", "0xc"]);
  });
});

describe("fetchLatestEpochs pagination", () => {
  it("never stops on short mid-stream pages (gaugeless pools yield no row)", async () => {
    // 250 pools, pageSize 100: page offsets 0/100/200; the FIRST page is short
    // (only 10 rows, most pools in it have no gauge), later pages still have data.
    const pages: Record<string, number> = { "0": 10, "100": 90, "200": 50 };
    const calls: bigint[] = [];
    const fake = {
      readContract: ({ args }: { args: readonly [bigint, bigint] }) => {
        calls.push(args[1]);
        const n = pages[String(args[1])] ?? 0;
        return Promise.resolve(
          Array.from({ length: n }, (_, i) => ({
            ts: 1n,
            lp: `0x${String(args[1])}-${i}`,
            votes: 1n,
            emissions: 0n,
            bribes: [],
            fees: [],
          })),
        );
      },
    } as unknown as SugarClient;
    const epochs = await fetchLatestEpochs(fake, 250, { pageSize: 100n });
    expect(calls).toEqual([0n, 100n, 200n]);
    expect(epochs.length).toBe(150);
  });
});

describe("cache hardening (malformed input, transient failures)", () => {
  it("loadTokenCache treats null/array tokens as an empty cache", () => {
    const path = join(tempDir(), "tokens.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: null }));
    expect(loadTokenCache(path).tokens).toEqual({});
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, tokens: [] }));
    expect(loadTokenCache(path).tokens).toEqual({});
  });

  it("loadPriceCache treats null/array maps as an empty cache", () => {
    const path = join(tempDir(), "prices.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, prices: null, unpriceable: {} }));
    expect(loadPriceCache(path).prices).toEqual({});
  });

  it("normalizes an out-of-range on-chain decimals to 18, keeps a valid one", async () => {
    const reader = (decimals: unknown): Erc20Reader => ({
      readContract: async ({ functionName }) => {
        if (functionName === "symbol") return "TKN";
        if (functionName === "name") return "Token";
        return decimals;
      },
    });
    const bad = await resolveTokens(["0x2222222222222222222222222222222222222222"], {
      client: reader(-3),
    });
    expect(bad.tokens["0x2222222222222222222222222222222222222222"]!.decimals).toBe(18);
    const good = await resolveTokens(["0x3333333333333333333333333333333333333333"], {
      client: reader(6),
    });
    expect(good.tokens["0x3333333333333333333333333333333333333333"]!.decimals).toBe(6);
  });

  it("a 400 records the skip sentinel without wiping previously cached prices", async () => {
    const path = join(tempDir(), "prices.json");
    const token = "0x1111111111111111111111111111111111111111";
    savePriceCache(path, {
      schemaVersion: 1,
      prices: { [token]: { "2020-01-02": "1500000000000000000" } },
      unpriceable: {},
    });
    const badFetch = (async () => ({
      status: 400,
      ok: false,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await fetchHistoricalPrices(
      [token],
      { startTs: T0, endTs: T0 + 2 * WEEK },
      { apiKey: "k", cachePath: path, fetchFn: badFetch, sleepFn: async () => {} },
    );
    const after = loadPriceCache(path);
    expect(after.prices[token]?.["2020-01-02"]).toBe("1500000000000000000");
    expect(after.unpriceable[token]).toBeDefined();
  });
});
