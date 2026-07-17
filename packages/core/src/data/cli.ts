/**
 * `pnpm data` entry point: builds data/aerodrome-epochs.v1.json (12+ months
 * of weekly epochs for the top ~30 pools by emission rate) and refreshes
 * data/tokens.json. Batched, retried, rate limited, idempotent — safe to
 * re-run. Requires BASE_RPC_URL (and optionally ALCHEMY_API_KEY) in the
 * environment. This module is import-safe: nothing runs unless executed
 * directly.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DatasetV1, PoolRecord } from "./schema.js";
import {
  createSugarClient,
  epochsForMonths,
  fetchPoolEpochs,
  fetchTopPools,
  sugarEpochToRecord,
  type SugarLp,
} from "./sugar.js";
import { composeDisplayName, resolveTokens, type TokenCacheV1 } from "./tokens.js";

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repo-root data/ directory (packages/core/src/data -> ../../../../data). */
const DATA_DIR = resolve(HERE, "../../../../data");

const RETRIES = 3;
const RATE_LIMIT_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const backoff = 1_000 * 2 ** (attempt - 1);
      console.warn(`  retry ${attempt}/${RETRIES} for ${label} in ${backoff}ms: ${String(err)}`);
      await sleep(backoff);
    }
  }
  throw lastError;
}

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
  const record: PoolRecord = {
    address: lp.lp,
    symbol: lp.symbol,
    displayName: composeDisplayName(shape, symbol0, symbol1),
    token0: lp.token0,
    token1: lp.token1,
    stable: shape.stable,
    gaugeAlive: lp.gauge_alive,
    epochs,
  };
  if (isCl) record.tickSpacing = lp.type;
  return record;
}

/** Builds the dataset and token cache. Exported for orchestration/testing. */
export async function buildDataset({
  months = 12,
  topN = 30,
}: { months?: number; topN?: number } = {}): Promise<void> {
  const client = createSugarClient(); // throws when BASE_RPC_URL is unset
  const maxEpochs = Math.min(200, epochsForMonths(months));
  console.log(`data: fetching top ${topN} pools by emission rate...`);
  const pools = await withRetry("fetchTopPools", () => fetchTopPools(client, { count: topN }));
  console.log(`data: ${pools.length} pools selected`);

  console.log("data: resolving token metadata...");
  const tokenAddresses = pools.flatMap((p) => [p.token0, p.token1]);
  const cachePath = resolve(DATA_DIR, "tokens.json");
  const resolveOpts: Parameters<typeof resolveTokens>[1] = { client, cachePath };
  if (process.env.ALCHEMY_API_KEY) resolveOpts.alchemyApiKey = process.env.ALCHEMY_API_KEY;
  else console.log("data: ALCHEMY_API_KEY not set — on-chain metadata only, no logos");
  const tokenCache = await resolveTokens(tokenAddresses, resolveOpts);
  console.log(`data: token cache holds ${Object.keys(tokenCache.tokens).length} tokens`);

  const records: PoolRecord[] = [];
  for (const [i, lp] of pools.entries()) {
    console.log(`data: [${i + 1}/${pools.length}] epochs for ${lp.symbol} (${lp.lp})`);
    const epochs = await withRetry(`epochsByAddress(${lp.lp})`, () =>
      fetchPoolEpochs(client, lp.lp, { maxEpochs }),
    );
    if (epochs.length === 0) {
      // A12: killed gauges / pre-gauge history return no epoch data.
      console.warn(`  no epoch data for ${lp.symbol} — recorded with empty history`);
    }
    records.push(poolRecordFromSugar(lp, epochs.map(sugarEpochToRecord), tokenCache));
    await sleep(RATE_LIMIT_MS);
  }

  const dataset: DatasetV1 = {
    schemaVersion: 1,
    chainId: 8453,
    generatedAt: new Date().toISOString(),
    source: "sugar",
    pools: records,
  };
  const outPath = resolve(DATA_DIR, "aerodrome-epochs.v1.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");
  console.log(`data: wrote ${outPath} (${records.length} pools, <=${maxEpochs} epochs each)`);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  buildDataset().catch((err: unknown) => {
    console.error(`data: failed: ${String(err)}`);
    process.exitCode = 1;
  });
}
