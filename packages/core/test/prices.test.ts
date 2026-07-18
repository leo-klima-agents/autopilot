/**
 * Price module tests: exact Wad parsing, the epoch price-date convention,
 * and fetchHistoricalPrices with injected fetch/sleep (chunking, incremental
 * cache, unpriceable sentinel, retry, disk round-trip).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  emptyPriceCache,
  fetchHistoricalPrices,
  loadPriceCache,
  parseUsdToWad,
  priceDateForEpoch,
  priceWadAt,
  savePriceCache,
  type PriceCacheV1,
} from "../src/data/prices.js";
import { sleep, withRetry } from "../src/data/retry.js";

const WAD = 10n ** 18n;
// Thu 2025-07-17 00:00:00 UTC (a real epoch flip)
const THURSDAY = 1_752_710_400;
const WEEK = 604_800;

const noSleep = () => Promise.resolve();
const quiet = () => {};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("parseUsdToWad", () => {
  it("parses integers and decimals exactly", () => {
    expect(parseUsdToWad("1")).toBe(WAD);
    expect(parseUsdToWad("0.5")).toBe(WAD / 2n);
    expect(parseUsdToWad("3245.1234")).toBe(3_245_123_400_000_000_000_000n);
  });

  it("keeps all 18 decimal places exactly", () => {
    expect(parseUsdToWad("0.000000000000000001")).toBe(1n);
    expect(parseUsdToWad("0.123456789012345678")).toBe(123456789012345678n);
  });

  it("floors digits beyond 18 decimals", () => {
    expect(parseUsdToWad("0.1234567890123456789")).toBe(123456789012345678n);
  });

  it("falls back to Number only for scientific notation", () => {
    expect(parseUsdToWad("1e-6")).toBe(BigInt(Math.floor(1e-6 * 1e18)));
  });

  it("rejects non-numeric input", () => {
    expect(() => parseUsdToWad("abc")).toThrow(/invalid price/);
    expect(() => parseUsdToWad("-1")).toThrow(/invalid price/);
  });
});

describe("priceDateForEpoch", () => {
  it("returns the UTC Thursday date of the epoch start", () => {
    expect(priceDateForEpoch(THURSDAY)).toBe("2025-07-17");
    expect(priceDateForEpoch(THURSDAY + WEEK)).toBe("2025-07-24");
  });
});

describe("priceWadAt", () => {
  it("returns exact hits and undefined for gaps/unpriceable", () => {
    const cache: PriceCacheV1 = {
      schemaVersion: 1,
      prices: { "0xaaa": { "2025-07-17": "500000000000000000" } },
      unpriceable: { "0xbbb": "2025-07-17T00:00:00Z" },
    };
    expect(priceWadAt(cache, "0xAAA", "2025-07-17")).toBe(WAD / 2n);
    expect(priceWadAt(cache, "0xaaa", "2025-07-24")).toBeUndefined();
    expect(priceWadAt(cache, "0xbbb", "2025-07-17")).toBeUndefined();
  });
});

describe("withRetry", () => {
  it("retries transient failures then succeeds", async () => {
    let calls = 0;
    const result = await withRetry(
      "flaky",
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { log: quiet, sleepFn: noSleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws the last error after exhaustion", async () => {
    await expect(
      withRetry("dead", async () => Promise.reject(new Error("always")), { log: quiet, sleepFn: noSleep, retries: 2 }),
    ).rejects.toThrow("always");
  });
});

describe("fetchHistoricalPrices", () => {
  let tempDir: string | null = null;
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it("fetches daily points, chunks long ranges, stores Wad strings", async () => {
    const requests: { address: string; startTime: string; endTime: string }[] = [];
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { address: string; startTime: string; endTime: string };
      requests.push(body);
      return jsonResponse({ data: [{ value: "2.5", timestamp: `${body.startTime.slice(0, 10)}T00:00:00Z` }] });
    }) as typeof fetch;

    // 70 weeks > 364 days -> exactly 2 chunks
    const cache = await fetchHistoricalPrices(
      ["0xAAA"],
      { startTs: THURSDAY, endTs: THURSDAY + 70 * WEEK },
      { apiKey: "k", fetchFn, log: quiet, sleepFn: noSleep },
    );
    expect(requests.length).toBe(2);
    expect(requests.every((r) => r.address === "0xaaa")).toBe(true);
    const spanMs = Date.parse(requests[0]!.endTime) - Date.parse(requests[0]!.startTime);
    expect(spanMs).toBeLessThanOrEqual(364 * 86_400 * 1000);
    expect(cache.prices["0xaaa"]?.["2025-07-17"]).toBe((WAD * 5n / 2n).toString());
  });

  it("is incremental: a warm cache makes zero fetches", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "prices-"));
    const cachePath = join(tempDir, "prices.json");
    const warm = emptyPriceCache();
    warm.prices["0xaaa"] = {};
    for (let i = 0; i <= 12; i += 1) {
      warm.prices["0xaaa"]![priceDateForEpoch(THURSDAY + i * WEEK)] = "1000000000000000000";
    }
    savePriceCache(cachePath, warm);

    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return jsonResponse({ data: [] });
    }) as typeof fetch;
    await fetchHistoricalPrices(
      ["0xAAA"],
      { startTs: THURSDAY, endTs: THURSDAY + 12 * WEEK },
      { apiKey: "k", cachePath, fetchFn, log: quiet, sleepFn: noSleep },
    );
    expect(calls).toBe(0);
  });

  it("records the unpriceable sentinel on HTTP 400 and honors it on re-run", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "prices-"));
    const cachePath = join(tempDir, "prices.json");
    let calls = 0;
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const body = JSON.parse(String(init?.body)) as { address: string; startTime: string; endTime: string };
      if (body.address === "0xbad") return jsonResponse({ error: "no price" }, 400);
      // answer every day in the requested span so the cache is complete
      const data: { value: string; timestamp: string }[] = [];
      for (let t = Date.parse(body.startTime); t <= Date.parse(body.endTime); t += 86_400_000) {
        data.push({ value: "1", timestamp: new Date(t).toISOString() });
      }
      return jsonResponse({ data });
    }) as typeof fetch;

    const opts = { apiKey: "k", cachePath, fetchFn, log: quiet, sleepFn: noSleep };
    const range = { startTs: THURSDAY, endTs: THURSDAY + WEEK };
    const cache = await fetchHistoricalPrices(["0xBAD", "0xAAA"], range, opts);
    expect(cache.unpriceable["0xbad"]).toBeDefined();
    expect(cache.prices["0xbad"]).toBeUndefined();
    expect(cache.prices["0xaaa"]?.["2025-07-17"]).toBe(WAD.toString());

    // re-run: sentinel honored, 0xaaa cached -> zero calls
    const before = calls;
    const reloaded = await fetchHistoricalPrices(["0xBAD", "0xAAA"], range, opts);
    expect(calls).toBe(before);
    expect(reloaded.unpriceable["0xbad"]).toBeDefined();
  });

  it("retries 5xx then succeeds", async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({}, 500);
      return jsonResponse({ data: [{ value: "4", timestamp: "2025-07-17T00:00:00Z" }] });
    }) as typeof fetch;
    const cache = await fetchHistoricalPrices(
      ["0xAAA"],
      { startTs: THURSDAY, endTs: THURSDAY + WEEK },
      { apiKey: "k", fetchFn, log: quiet, sleepFn: noSleep },
    );
    expect(calls).toBe(2);
    expect(cache.prices["0xaaa"]?.["2025-07-17"]).toBe((4n * WAD).toString());
  });

  it("round-trips the cache through disk", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "prices-"));
    const cachePath = join(tempDir, "prices.json");
    const cache = emptyPriceCache();
    cache.prices["0xaaa"] = { "2025-07-17": "42" };
    cache.unpriceable["0xbbb"] = "2025-07-17T00:00:00Z";
    savePriceCache(cachePath, cache);
    expect(loadPriceCache(cachePath)).toEqual(cache);
    expect(loadPriceCache(join(tempDir, "missing.json"))).toEqual(emptyPriceCache());
  });
});

describe("sleep", () => {
  it("resolves", async () => {
    await sleep(1);
  });
});
