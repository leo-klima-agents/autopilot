/**
 * `pnpm data` entry point: builds data/aerodrome-epochs.v1.json (30 months of
 * weekly epochs for the top ~40 pools) plus the data/tokens.json and
 * data/prices.json caches. Batched, retried, rate limited, idempotent, safe
 * to re-run. Requires BASE_RPC_URL; ALCHEMY_API_KEY enables USD pricing.
 *
 * The defaults match the published Aero methodology plus headroom: the
 * emissions-accuracy study ran over the top 40 Aerodrome pools, and the
 * cbBTC early-allocator backtest covers Sep 2024 - Feb 2025, which a
 * 12-month window would miss entirely. 30 months (rather than 24) keeps
 * that episode inside the trailing window for another year of weekly
 * refreshes; the cbBTC-backtest preset pins its window to absolute dates
 * and fails loudly once the episode finally ages out.
 *
 * Pool selection is two-stage (methodology inspired by ldeso/aerodrome):
 *   stage 1, top `candidateN` alive-gauge pools by CURRENT-epoch votes
 *             (RewardsSugar.epochsLatest; includes Slipstream CL pools);
 *   stage 2, top `topN` of those by trailing USD revenue (fees + bribes,
 *             Alchemy-priced at each epoch's Thursday start date).
 * Without ALCHEMY_API_KEY, stage 2 falls back to the vote ranking (unpriced).
 * Known limitation (survivorship): stage 1 selects by votes as-of-today, so
 * a pool that was large historically but whose gauge is dead or unvoted now
 * never enters the universe, whatever the window length.
 *
 * This module is import-safe: nothing runs unless executed directly.
 * Direct runs accept `--months N --topN N --candidateN N` for smoke runs.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { DatasetV1, PoolRecord } from "./schema.js";
import { parseAmount } from "./schema.js";
import {
  createSugarClient,
  epochsForMonths,
  fetchAllLps,
  fetchLatestEpochs,
  fetchPoolEpochs,
  selectVoteCandidates,
  sugarEpochToRecord,
  type SugarLp,
} from "./sugar.js";
import { composeDisplayName, resolveTokens, type TokenCacheV1 } from "./tokens.js";
import { fetchHistoricalPrices, priceWadAt, type PriceCacheV1 } from "./prices.js";
import { computeEpochUsd } from "./usd.js";
import { sleep, withRetry } from "./retry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo-root data/ directory (packages/core/src/data -> ../../../../data). */
const DATA_DIR = resolve(HERE, "../../../../data");

const RATE_LIMIT_MS = 250;

function poolRecordFromSugar(
  lp: SugarLp,
  epochs: PoolRecord["epochs"],
  tokenCache: TokenCacheV1,
): PoolRecord {
  const isCl = lp.type > 0;
  const symbol0 = tokenCache.tokens[lp.token0.toLowerCase()]?.symbol ?? "?";
  const symbol1 = tokenCache.tokens[lp.token1.toLowerCase()]?.symbol ?? "?";
  const stable = lp.type === 0; // v2: 0 = stable, -1 = volatile; CL pools are never sAMM
  const shape = isCl ? { stable: false, tickSpacing: lp.type } : { stable };
  const displayName = composeDisplayName(shape, symbol0, symbol1);
  const record: PoolRecord = {
    address: lp.lp,
    // LpSugar returns an empty `symbol` for Slipstream CL pools, fall back
    // to the composed display name so the schema's non-empty invariant holds.
    symbol: lp.symbol === "" ? displayName : lp.symbol,
    displayName,
    token0: lp.token0,
    token1: lp.token1,
    stable: shape.stable,
    gaugeAlive: lp.gauge_alive,
    epochs,
  };
  if (isCl) record.tickSpacing = lp.type;
  return record;
}

/** Trailing USD revenue (feesUsd + bribesUsd across all epochs) of a pool. */
function poolUsdRevenue(pool: PoolRecord): bigint {
  let total = 0n;
  for (const epoch of pool.epochs) {
    total += parseAmount(epoch.feesUsd ?? "0") + parseAmount(epoch.bribesUsd ?? "0");
  }
  return total;
}

/** Stage-2 ranking: top pools by trailing USD revenue (desc; ties by address).
 *  Pure, exported for tests. Unpriced pools sum to 0 and rank last. */
export function rankPoolsByUsdRevenue(records: readonly PoolRecord[], topN: number): PoolRecord[] {
  return [...records]
    .sort((a, b) => {
      const ra = poolUsdRevenue(a);
      const rb = poolUsdRevenue(b);
      if (ra !== rb) return ra > rb ? -1 : 1;
      return a.address < b.address ? -1 : 1;
    })
    .slice(0, topN);
}

/** Builds the dataset plus token/price caches. Exported for orchestration. */
export async function buildDataset({
  months = 30,
  topN = 40,
  candidateN = 80,
}: { months?: number; topN?: number; candidateN?: number } = {}): Promise<void> {
  const client = createSugarClient(); // throws when BASE_RPC_URL is unset
  const apiKey = process.env.ALCHEMY_API_KEY;
  const maxEpochs = Math.min(200, epochsForMonths(months));

  // -- stage 1: candidates by current-epoch votes ----------------------------
  console.log("data: fetching pool list + current-epoch votes...");
  const lps = await withRetry("fetchAllLps", () => fetchAllLps(client));
  console.log(`data: ${lps.length} pools listed`);
  const latest = await withRetry("fetchLatestEpochs", () => fetchLatestEpochs(client, lps.length));
  console.log(`data: ${latest.length} current-epoch rows`);
  const wantCandidates = apiKey ? candidateN : topN;
  const candidates = selectVoteCandidates(lps, latest, wantCandidates);
  const clCount = candidates.filter((lp) => lp.type > 0).length;
  console.log(
    `data: ${candidates.length} candidates by current votes (${clCount} CL, ${candidates.length - clCount} v2)`,
  );
  if (!apiKey) {
    console.log("data: ALCHEMY_API_KEY not set, vote ranking only, no USD pricing");
  }

  // -- epochs per candidate ---------------------------------------------------
  const perPool: { lp: SugarLp; epochs: PoolRecord["epochs"] }[] = [];
  for (const [i, lp] of candidates.entries()) {
    console.log(`data: [${i + 1}/${candidates.length}] epochs for ${lp.symbol} (${lp.lp})`);
    const epochs = await withRetry(`epochsByAddress(${lp.lp})`, () =>
      fetchPoolEpochs(client, lp.lp, { maxEpochs }),
    );
    if (epochs.length === 0) {
      // A12: killed gauges / pre-gauge history return no epoch data.
      console.warn(`  no epoch data for ${lp.symbol}, recorded with empty history`);
    }
    perPool.push({ lp, epochs: epochs.map(sugarEpochToRecord) });
    await sleep(RATE_LIMIT_MS);
  }

  // -- token metadata (pool tokens + every reward token) ----------------------
  console.log("data: resolving token metadata...");
  const tokenAddresses = new Set<string>();
  for (const { lp, epochs } of perPool) {
    tokenAddresses.add(lp.token0);
    tokenAddresses.add(lp.token1);
    for (const epoch of epochs) {
      for (const entry of [...epoch.fees, ...epoch.bribes]) tokenAddresses.add(entry.token);
    }
  }
  const cachePath = resolve(DATA_DIR, "tokens.json");
  const resolveOpts: Parameters<typeof resolveTokens>[1] = { client, cachePath };
  if (apiKey) resolveOpts.alchemyApiKey = apiKey;
  const tokenCache = await resolveTokens([...tokenAddresses], resolveOpts);
  console.log(`data: token cache holds ${Object.keys(tokenCache.tokens).length} tokens`);

  // -- USD pricing -------------------------------------------------------------
  let priceCache: PriceCacheV1 | null = null;
  let pricedAt: string | undefined;
  if (apiKey) {
    const allTs = perPool.flatMap((p) => p.epochs.map((e) => e.ts));
    if (allTs.length > 0) {
      console.log(`data: fetching daily USD prices for ${tokenAddresses.size} tokens...`);
      priceCache = await fetchHistoricalPrices(
        [...tokenAddresses],
        { startTs: Math.min(...allTs), endTs: Math.max(...allTs) + 86_400 },
        { apiKey, cachePath: resolve(DATA_DIR, "prices.json"), log: console.log },
      );
      pricedAt = new Date().toISOString();
      const unpriceable = Object.keys(priceCache.unpriceable).length;
      if (unpriceable > 0) console.log(`data: ${unpriceable} tokens not priceable by Alchemy`);
    }
  }

  // -- records (+ per-epoch USD when priced) ----------------------------------
  const records: PoolRecord[] = [];
  for (const { lp, epochs } of perPool) {
    const record = poolRecordFromSugar(lp, epochs, tokenCache);
    if (priceCache !== null) {
      const cache = priceCache;
      let priced = 0;
      let total = 0;
      for (const epoch of record.epochs) {
        const usd = computeEpochUsd(epoch, {
          decimalsOf: (addr) => tokenCache.tokens[addr]?.decimals,
          priceWadAt: (addr, date) => priceWadAt(cache, addr, date),
        });
        epoch.feesUsd = usd.feesUsd.toString();
        epoch.bribesUsd = usd.bribesUsd.toString();
        priced += usd.pricedAmounts;
        total += usd.totalAmounts;
      }
      record.pricing = { pricedAmounts: priced, totalAmounts: total };
      if (total > 0 && priced < total) {
        console.log(
          `data: ${record.displayName}: priced ${priced}/${total} reward amounts (${((100 * priced) / total).toFixed(1)}%)`,
        );
      }
    }
    records.push(record);
  }

  // -- stage 2: final universe by trailing USD revenue -------------------------
  const finalRecords = priceCache !== null ? rankPoolsByUsdRevenue(records, topN) : records;
  const finalCl = finalRecords.filter((r) => r.tickSpacing !== undefined).length;
  console.log(`data: final universe ${finalRecords.length} pools (${finalCl} CL)`);

  const dataset: DatasetV1 = {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: new Date().toISOString(),
    source: "sugar",
    pools: finalRecords,
  };
  if (pricedAt !== undefined) dataset.pricedAt = pricedAt;
  const outPath = resolve(DATA_DIR, "aerodrome-epochs.v1.json");
  mkdirSync(dirname(outPath), { recursive: true });
  // Compact on purpose: the site fetches this file, and pretty-printing
  // adds ~70% parse/transfer bytes that only ever served human diffing
  // (which GitHub truncates at this size anyway).
  writeFileSync(outPath, `${JSON.stringify(dataset)}\n`, "utf8");
  console.log(`data: wrote ${outPath} (${finalRecords.length} pools, <=${maxEpochs} epochs each)`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

const CLI_USAGE =
  "usage: pnpm data [-- --months N] [--topN N] [--candidateN N]\n" +
  "  --months      trailing window length in months (default 30)\n" +
  "  --topN        pools kept after USD ranking (default 40)\n" +
  "  --candidateN  vote-ranked candidates fetched (default 80)";

/** Parses `--months N --topN N --candidateN N` overrides for direct runs
 *  (smoke runs against the live chain: `pnpm data -- --months 2 --topN 5`;
 *  `--months=2` works too). Returns null when --help was asked. Throws on
 *  unknown flags or non-positive-integer values. */
export function parseCliArgs(
  argv: readonly string[],
): { months?: number; topN?: number; candidateN?: number } | null {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      months: { type: "string" },
      topN: { type: "string" },
      candidateN: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) return null;
  const out: { months?: number; topN?: number; candidateN?: number } = {};
  for (const key of ["months", "topN", "candidateN"] as const) {
    const raw = values[key];
    if (raw === undefined) continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`--${key} needs a positive integer, got ${JSON.stringify(raw)}`);
    }
    out[key] = value;
  }
  return out;
}

if (isDirectRun) {
  // Async wrapper (top-level await is unavailable: tsx compiles this
  // package as CJS): parseCliArgs throws synchronously on bad flags and
  // buildDataset rejects on runtime failures; both must land in the same
  // catch so every failure prints the friendly message and sets the exit
  // code instead of an uncaught stack trace.
  void (async () => {
    try {
      const overrides = parseCliArgs(process.argv.slice(2));
      if (overrides === null) {
        console.log(CLI_USAGE);
      } else {
        await buildDataset(overrides);
      }
    } catch (err) {
      console.error(`data: failed: ${String(err)}`);
      console.error(CLI_USAGE);
      process.exitCode = 1;
    }
  })();
}
