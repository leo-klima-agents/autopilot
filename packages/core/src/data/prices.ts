/**
 * Historical USD token prices via the Alchemy Prices API, with an incremental
 * on-disk cache (data/prices.json).
 *
 * PRICE-DATE CONVENTION: an epoch's revenue is priced at the UTC calendar date
 * of its Thursday-00:00 start. Fees accrue across the whole week, so any single
 * date is an approximation; the start date is the reproducible choice, by the
 * time a weekly build runs, that day's price is final, and re-runs price the
 * same epoch identically.
 *
 * FLOAT BOUNDARY: the API returns decimal price strings. `parseUsdToWad`
 * converts them once, exactly, at this ingestion boundary; everything
 * downstream is bigint (P2 allows floats outside fixture paths, and even
 * here a float is only touched for scientific-notation values).
 *
 * Methodology follows github.com/ldeso/aerodrome (fetch.ts): daily interval,
 * ≤1-year request chunks, gentle pacing, HTTP 400 = "Alchemy cannot price
 * this token" recorded as a sentinel so re-runs skip it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { epochStart, WEEK } from "../model/types.js";
import { withRetry, sleep } from "./retry.js";

const WAD_DECIMALS = 18;
const DAY_S = 86_400;
/** Alchemy rejects ranges over one year; chunk below the limit. */
const CHUNK_S = 364 * DAY_S;
const PRICES_URL = "https://api.g.alchemy.com/prices/v1";

/** Incremental price cache (data/prices.json). */
export interface PriceCacheV1 {
  schemaVersion: 1;
  /** addrLower -> "YYYY-MM-DD" (UTC) -> USD price, Wad-scaled decimal integer string. */
  prices: Record<string, Record<string, string>>;
  /**
   * addrLower -> ISO date of the attempt. Presence means Alchemy returned
   * HTTP 400 (token not priceable); re-runs skip it. A separate map, never a
   * magic value inside `prices`, so every price entry is a strict decimal.
   */
  unpriceable: Record<string, string>;
}

export function emptyPriceCache(): PriceCacheV1 {
  return { schemaVersion: 1, prices: {}, unpriceable: {} };
}

/** True for a non-null, non-array object (`typeof x === "object"` also
 *  matches `null` and arrays, which would pass a malformed cache through). */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Loads the cache; a missing or malformed file yields a fresh empty cache. */
export function loadPriceCache(path: string): PriceCacheV1 {
  if (!existsSync(path)) return emptyPriceCache();
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
      isPlainObject((parsed as { prices?: unknown }).prices) &&
      isPlainObject((parsed as { unpriceable?: unknown }).unpriceable)
    ) {
      return parsed as PriceCacheV1;
    }
  } catch {
    // fall through to fresh cache
  }
  return emptyPriceCache();
}

export function savePriceCache(path: string, cache: PriceCacheV1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 1)}\n`, "utf8");
}

/**
 * Parses an Alchemy price value ("3245.1234", "0.000021") to Wad, exactly:
 * split on ".", pad/truncate the fraction to 18 digits (floor). Scientific
 * notation falls back to Number(), the one float touch, at this boundary.
 * Throws on non-numeric input.
 */
export function parseUsdToWad(value: string): bigint {
  if (/^[0-9]+(\.[0-9]+)?$/.test(value)) {
    const [whole = "0", frac = ""] = value.split(".");
    const fracPadded = (frac + "0".repeat(WAD_DECIMALS)).slice(0, WAD_DECIMALS);
    return BigInt(whole) * 10n ** BigInt(WAD_DECIMALS) + BigInt(fracPadded);
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid price value: ${JSON.stringify(value)}`);
  return BigInt(Math.floor(n * 1e18));
}

/** UTC calendar date ("YYYY-MM-DD") of the epoch's Thursday-00:00 start. */
export function priceDateForEpoch(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Exact price lookup: undefined when the date is missing (pre-listing gap)
 *  or the token is unpriceable. No nearest-date fallback, callers skip and
 *  count the amount instead. */
export function priceWadAt(cache: PriceCacheV1, token: string, date: string): bigint | undefined {
  const value = cache.prices[token.toLowerCase()]?.[date];
  return value === undefined ? undefined : BigInt(value);
}

export interface FetchPricesOptions {
  apiKey: string;
  /** Cache file (data/prices.json). Omit for in-memory only (tests). */
  cachePath?: string;
  fetchFn?: typeof fetch;
  log?: (message: string) => void;
  /** Pause between tokens (default 200ms, the pacing Alchemy tolerates). */
  rateLimitMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

interface AlchemyPricePoint {
  value: string;
  timestamp: string;
}

/**
 * Ensures daily prices exist in the cache for every `token` over
 * [startTs, endTs]. Incremental: a token whose needed dates are all cached
 * (or which is marked unpriceable) makes zero HTTP calls. The cache is
 * persisted after each token, so an interrupted run keeps its progress.
 */
export async function fetchHistoricalPrices(
  tokens: readonly string[],
  range: { startTs: number; endTs: number },
  options: FetchPricesOptions,
): Promise<PriceCacheV1> {
  const {
    apiKey,
    cachePath,
    fetchFn = fetch,
    log = console.log,
    rateLimitMs = 200,
    sleepFn = sleep,
  } = options;
  const cache = cachePath ? loadPriceCache(cachePath) : emptyPriceCache();
  const neededDates = epochDatesInRange(range.startTs, range.endTs);

  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].sort();
  let fetched = 0;
  for (const token of unique) {
    if (cache.unpriceable[token] !== undefined) continue;
    const have = cache.prices[token] ?? {};
    const missing = neededDates.filter((d) => have[d] === undefined);
    if (missing.length === 0) continue;

    if (fetched > 0) await sleepFn(rateLimitMs);
    fetched += 1;

    // one span covering all missing dates, chunked to the API's 1-year limit
    const spanStart = Date.parse(`${missing[0]}T00:00:00Z`) / 1000;
    const spanEnd = Date.parse(`${missing.at(-1)}T00:00:00Z`) / 1000 + DAY_S;
    const dateMap = cache.prices[token] ?? {};
    cache.prices[token] = dateMap;
    let unpriceable = false;

    for (let chunkStart = spanStart; chunkStart < spanEnd; chunkStart += CHUNK_S) {
      const chunkEnd = Math.min(chunkStart + CHUNK_S, spanEnd);
      // HTTP 400 is a definitive "cannot price this token", returned as null
      // without burning retries; transient failures go through withRetry.
      const points = await withRetry(
        `prices(${token})`,
        async (): Promise<AlchemyPricePoint[] | null> => {
          const res = await fetchFn(`${PRICES_URL}/${apiKey}/tokens/historical`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              network: "base-mainnet",
              address: token,
              startTime: new Date(chunkStart * 1000).toISOString(),
              endTime: new Date(chunkEnd * 1000).toISOString(),
              interval: "1d",
            }),
          });
          if (res.status === 400) return null;
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { data?: AlchemyPricePoint[] };
          return body.data ?? [];
        },
        { log, retries: 3, sleepFn },
      );
      if (points === null) {
        cache.unpriceable[token] = new Date().toISOString();
        log(`  prices: ${token} not priceable by Alchemy, recorded sentinel`);
        unpriceable = true;
        break;
      }
      for (const pt of points) {
        dateMap[pt.timestamp.slice(0, 10)] = parseUsdToWad(pt.value).toString();
      }
    }
    // A 400 records the skip-fetch sentinel but must NOT discard prices already
    // cached from earlier runs: a transient/edge-case 400 on a token with a long
    // history would otherwise wipe it, silently collapsing its USD revenue to 0
    // and dropping it from the ranked universe. Drop only an empty date map so a
    // never-priced token leaves no stray key.
    if (unpriceable && Object.keys(dateMap).length === 0) delete cache.prices[token];
    if (cachePath) savePriceCache(cachePath, cache);
  }
  if (cachePath) savePriceCache(cachePath, cache);
  return cache;
}

/** Thursday epoch-start dates within [startTs, endTs]. */
function epochDatesInRange(startTs: number, endTs: number): string[] {
  // reuse the single epoch-grid definition (model/types) rather than re-deriving it
  const first = epochStart(startTs);
  const dates: string[] = [];
  for (let ts = first; ts <= endTs; ts += WEEK) {
    if (ts >= startTs - WEEK) dates.push(priceDateForEpoch(ts));
  }
  return dates;
}
