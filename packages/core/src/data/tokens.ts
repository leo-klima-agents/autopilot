/**
 * Token metadata resolution with an on-disk cache
 * (data/tokens.json, schemaVersion 1). On-chain symbol()/name()/decimals()
 * via viem is preferred; Alchemy's alchemy_getTokenMetadata fills gaps
 * (logo, missing on-chain strings). Conflicts are logged, on-chain wins.
 *
 * SANITIZATION: token strings are attacker-controlled. Control characters
 * are stripped, symbols clamped to 32 chars and names to 64; never trust
 * these strings anywhere else either. ALCHEMY_API_KEY comes from
 * process.env — never commit secrets.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { erc20Abi, type Address } from "viem";

/** Cached metadata for one token. */
export interface TokenMetadata {
  name: string;
  symbol: string;
  decimals: number;
  logo: string | null;
}

/** tokens.json shape. */
export interface TokenCacheV1 {
  schemaVersion: 1;
  tokens: Record<string, TokenMetadata>;
}

/** Max sanitized symbol length. */
export const MAX_SYMBOL_LENGTH = 32;
/** Max sanitized name length. */
export const MAX_NAME_LENGTH = 64;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e]/g;

function sanitize(raw: string, maxLength: number): string {
  return raw.replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

/** Strips control/bidi chars and clamps to 32 chars. */
export function sanitizeSymbol(raw: string): string {
  return sanitize(raw, MAX_SYMBOL_LENGTH);
}

/** Strips control/bidi chars and clamps to 64 chars. */
export function sanitizeName(raw: string): string {
  return sanitize(raw, MAX_NAME_LENGTH);
}

/**
 * Display name composition: `vAMM-`/`sAMM-` from the pool's `stable` flag
 * (v2) or `CL{tickSpacing}-` (Slipstream), plus `symbol0/symbol1`.
 */
export function composeDisplayName(
  pool: { stable: boolean; tickSpacing?: number | undefined },
  symbol0: string,
  symbol1: string,
): string {
  const prefix =
    pool.tickSpacing !== undefined
      ? `CL${pool.tickSpacing}-`
      : pool.stable
        ? "sAMM-"
        : "vAMM-";
  return `${prefix}${sanitizeSymbol(symbol0)}/${sanitizeSymbol(symbol1)}`;
}

/** Loads tokens.json, returning an empty cache when absent or invalid. */
export function loadTokenCache(path: string): TokenCacheV1 {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { schemaVersion?: unknown }).schemaVersion === 1 &&
      typeof (parsed as { tokens?: unknown }).tokens === "object"
    ) {
      return parsed as TokenCacheV1;
    }
  } catch {
    // missing or malformed — start fresh
  }
  return { schemaVersion: 1, tokens: {} };
}

/** Writes tokens.json (creating parent directories). */
export function saveTokenCache(path: string, cache: TokenCacheV1): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
}

/**
 * Minimal contract-reader surface (any viem PublicClient satisfies it);
 * structural on purpose to sidestep viem's chain-typed client variance.
 */
export interface Erc20Reader {
  readContract(args: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: "symbol" | "name" | "decimals";
  }): Promise<unknown>;
}

interface AlchemyTokenMetadata {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logo: string | null;
}

/** Fetches alchemy_getTokenMetadata for one address. */
export async function fetchAlchemyMetadata(
  address: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<AlchemyTokenMetadata | null> {
  const res = await fetchFn(`https://base-mainnet.g.alchemy.com/v2/${apiKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "alchemy_getTokenMetadata",
      params: [address],
    }),
  });
  if (!res.ok) throw new Error(`alchemy_getTokenMetadata HTTP ${res.status}`);
  const body = (await res.json()) as { result?: AlchemyTokenMetadata; error?: { message: string } };
  if (body.error) throw new Error(`alchemy_getTokenMetadata: ${body.error.message}`);
  return body.result ?? null;
}

async function readOnchain(
  client: Erc20Reader,
  address: Address,
): Promise<{ symbol?: string; name?: string; decimals?: number }> {
  const out: { symbol?: string; name?: string; decimals?: number } = {};
  const tryRead = async <T>(functionName: "symbol" | "name" | "decimals"): Promise<T | undefined> => {
    try {
      return (await client.readContract({ address, abi: erc20Abi, functionName })) as T;
    } catch {
      return undefined; // non-standard token (bytes32 symbol, missing fn, ...)
    }
  };
  const symbol = await tryRead<string>("symbol");
  const name = await tryRead<string>("name");
  const decimals = await tryRead<number>("decimals");
  if (symbol !== undefined) out.symbol = symbol;
  if (name !== undefined) out.name = name;
  if (decimals !== undefined) out.decimals = decimals;
  return out;
}

/** Options for `resolveTokens`. */
export interface ResolveTokensOptions {
  /** viem client for on-chain reads; omit to skip on-chain resolution. */
  client?: Erc20Reader;
  /** Alchemy API key (from process.env.ALCHEMY_API_KEY); omit to skip. */
  alchemyApiKey?: string;
  /** tokens.json path; omit to skip persistence. */
  cachePath?: string;
  /** Log sink (conflicts, progress). Default console. */
  log?: (message: string) => void;
}

/**
 * Resolves metadata for every unseen address (cache hits are skipped),
 * preferring on-chain symbol()/name()/decimals() and filling gaps from
 * Alchemy. On-chain vs Alchemy conflicts are logged; on-chain wins.
 * Returns the updated cache and persists it when `cachePath` is set.
 */
export async function resolveTokens(
  addresses: readonly string[],
  options: ResolveTokensOptions = {},
): Promise<TokenCacheV1> {
  const log = options.log ?? ((m: string) => console.log(m));
  const cache: TokenCacheV1 = options.cachePath
    ? loadTokenCache(options.cachePath)
    : { schemaVersion: 1, tokens: {} };

  const unseen = [...new Set(addresses.map((a) => a.toLowerCase()))].filter(
    (a) => cache.tokens[a] === undefined,
  );
  for (const address of unseen) {
    const onchain = options.client
      ? await readOnchain(options.client, address as Address)
      : {};
    let alchemy: AlchemyTokenMetadata | null = null;
    const needsFill =
      onchain.symbol === undefined || onchain.name === undefined || onchain.decimals === undefined;
    if (options.alchemyApiKey && needsFill) {
      try {
        alchemy = await fetchAlchemyMetadata(address, options.alchemyApiKey);
      } catch (err) {
        log(`tokens: alchemy lookup failed for ${address}: ${String(err)}`);
      }
    }
    if (
      onchain.symbol !== undefined &&
      alchemy?.symbol != null &&
      sanitizeSymbol(onchain.symbol) !== sanitizeSymbol(alchemy.symbol)
    ) {
      log(
        `tokens: symbol conflict for ${address}: onchain=${sanitizeSymbol(onchain.symbol)} alchemy=${sanitizeSymbol(alchemy.symbol)} (using onchain)`,
      );
    }
    cache.tokens[address] = {
      symbol: sanitizeSymbol(onchain.symbol ?? alchemy?.symbol ?? "UNKNOWN"),
      name: sanitizeName(onchain.name ?? alchemy?.name ?? "Unknown Token"),
      decimals: onchain.decimals ?? alchemy?.decimals ?? 18,
      logo: alchemy?.logo ?? null,
    };
  }

  if (options.cachePath) saveTokenCache(options.cachePath, cache);
  return cache;
}
