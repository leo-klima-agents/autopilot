/**
 * Sugar indexer client (Base). Minimal hand-written viem ABIs for exactly
 * the functions/structs we use, with struct field order copied EXACTLY from
 * the Vyper sources (Vyper struct returns map to ABI tuples):
 * - RewardsSugar.epochsByAddress(limit, offset, pool) -> LpEpoch[]
 *   (contracts/RewardsSugar.vy @ velodrome-finance/sugar main)
 * - LpSugar.all(limit, offset, filter) -> Lp[]
 *   (contracts/LpSugar.vy @ main; `filter` 0 = every pool category)
 *
 * RPC comes from process.env.BASE_RPC_URL. Never commit secrets.
 */

import {
  createPublicClient,
  http,
  type Address,
  type PublicClient,
  type Transport,
} from "viem";
import { base } from "viem/chains";
import { WEEK } from "../model/types.js";
import type { EpochRecord, TokenAmount } from "./schema.js";

/**
 * LpSugar on Base (A11; re-verify on chain before funds move).
 *
 * This is the NEWER deployment (also used by ldeso/aerodrome). The older
 * 0x69dD9db6d8f8E7d83887A704f447b1a584b599A1 does NOT index Slipstream CL
 * pools at all (verified on chain: its list has no `type > 0` rows and CL
 * addresses revert). This one was verified on chain 2026-07-18: `all()`
 * decodes with the 32-field Lp ABI below and enumerates 34,330 pools —
 * v2 first, CL pools from roughly offset 28,000 (6,101 CL, 449 alive gauges).
 */
export const BASE_LP_SUGAR_ADDRESS: Address = "0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe";
/** RewardsSugar on Base (A11). */
export const BASE_REWARDS_SUGAR_ADDRESS: Address = "0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678";

const lpEpochRewardComponents = [
  { name: "token", type: "address" },
  { name: "amount", type: "uint256" },
] as const;

const lpEpochComponents = [
  { name: "ts", type: "uint256" },
  { name: "lp", type: "address" },
  { name: "votes", type: "uint256" },
  { name: "emissions", type: "uint256" },
  { name: "bribes", type: "tuple[]", components: lpEpochRewardComponents },
  { name: "fees", type: "tuple[]", components: lpEpochRewardComponents },
] as const;

/** Minimal RewardsSugar ABI (epochsByAddress + epochsLatest). */
export const rewardsSugarAbi = [
  {
    type: "function",
    name: "epochsByAddress",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_address", type: "address" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: lpEpochComponents }],
  },
  {
    type: "function",
    name: "epochsLatest",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: lpEpochComponents }],
  },
] as const;

// Field order copied exactly from LpSugar.vy `struct Lp` (main).
const lpComponents = [
  { name: "lp", type: "address" },
  { name: "symbol", type: "string" },
  { name: "decimals", type: "uint8" },
  { name: "liquidity", type: "uint256" },
  { name: "type", type: "int24" },
  { name: "tick", type: "int24" },
  { name: "sqrt_ratio", type: "uint160" },
  { name: "token0", type: "address" },
  { name: "reserve0", type: "uint256" },
  { name: "staked0", type: "uint256" },
  { name: "token1", type: "address" },
  { name: "reserve1", type: "uint256" },
  { name: "staked1", type: "uint256" },
  { name: "gauge", type: "address" },
  { name: "gauge_liquidity", type: "uint256" },
  { name: "gauge_alive", type: "bool" },
  { name: "fee", type: "address" },
  { name: "bribe", type: "address" },
  { name: "factory", type: "address" },
  { name: "emissions", type: "uint256" },
  { name: "emissions_token", type: "address" },
  { name: "emissions_cap", type: "uint256" },
  { name: "pool_fee", type: "uint256" },
  { name: "unstaked_fee", type: "uint256" },
  { name: "token0_fees", type: "uint256" },
  { name: "token1_fees", type: "uint256" },
  { name: "locked", type: "uint256" },
  { name: "emerging", type: "uint256" },
  { name: "created_at", type: "uint32" },
  { name: "nfpm", type: "address" },
  { name: "alm", type: "address" },
  { name: "root", type: "address" },
] as const;

/** Minimal LpSugar ABI (`all` only — the one entry point we call). */
export const lpSugarAbi = [
  {
    type: "function",
    name: "all",
    stateMutability: "view",
    inputs: [
      { name: "_limit", type: "uint256" },
      { name: "_offset", type: "uint256" },
      { name: "_filter", type: "uint256" },
    ],
    outputs: [{ name: "", type: "tuple[]", components: lpComponents }],
  },
] as const;

/** Decoded LpSugar.Lp struct (the fields this package consumes). */
export interface SugarLp {
  lp: Address;
  symbol: string;
  /** Tick spacing on CL; 0/-1 for stable/volatile on v2. */
  type: number;
  token0: Address;
  token1: Address;
  gauge_alive: boolean;
  liquidity: bigint;
  emissions: bigint;
}

/** Decoded RewardsSugar.LpEpoch struct. */
export interface SugarLpEpoch {
  ts: bigint;
  lp: Address;
  votes: bigint;
  emissions: bigint;
  bribes: readonly { token: Address; amount: bigint }[];
  fees: readonly { token: Address; amount: bigint }[];
}

/** viem public client bound to Base (avoids PublicClient variance issues). */
export type SugarClient = PublicClient<Transport, typeof base>;

/** Creates a viem public client for Base from BASE_RPC_URL. */
export function createSugarClient(rpcUrl?: string): SugarClient {
  const url = rpcUrl ?? process.env.BASE_RPC_URL;
  if (!url) throw new Error("BASE_RPC_URL is not set");
  return createPublicClient({ chain: base, transport: http(url) });
}

/** One page of LpSugar.all. `filter` 0 = all pool categories. */
export async function fetchLpPage(
  client: SugarClient,
  { limit, offset, filter = 0n }: { limit: bigint; offset: bigint; filter?: bigint },
): Promise<SugarLp[]> {
  const raw = await client.readContract({
    address: BASE_LP_SUGAR_ADDRESS,
    abi: lpSugarAbi,
    functionName: "all",
    args: [limit, offset, filter],
  });
  return raw.map((lp) => ({
    lp: lp.lp,
    symbol: lp.symbol,
    type: lp.type,
    token0: lp.token0,
    token1: lp.token1,
    gauge_alive: lp.gauge_alive,
    liquidity: lp.liquidity,
    emissions: lp.emissions,
  }));
}

/**
 * Pages LpSugar.all until the pool list truly ends (first short page).
 * The full list is LONG — 34,330 pools as of 2026-07, with all Slipstream CL
 * pools sitting past offset ~28,000 — so `maxPages` is only a runaway
 * backstop, never an expected stop: stopping early silently drops every CL
 * pool from the universe.
 */
export async function fetchAllLps(
  client: SugarClient,
  { pageSize = 500n, maxPages = 400 }: { pageSize?: bigint; maxPages?: number } = {},
): Promise<SugarLp[]> {
  const all: SugarLp[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const batch = await fetchLpPage(client, {
      limit: pageSize,
      offset: pageSize * BigInt(page),
    });
    all.push(...batch);
    if (batch.length < Number(pageSize)) break;
  }
  return all;
}

/**
 * FALLBACK ranking: top pools by current gauge emission rate (descending;
 * ties by address), dead gauges excluded. Empirically this surfaces only
 * vAMM/sAMM pools and misses the Slipstream CL pools that dominate fees —
 * prefer the two-stage vote/USD selection in cli.ts (selectVoteCandidates +
 * rankPoolsByUsdRevenue). Kept for offline use and comparison.
 */
export async function fetchTopPools(
  client: SugarClient,
  {
    count = 30,
    ...paging
  }: { count?: number; pageSize?: bigint; maxPages?: number } = {},
): Promise<SugarLp[]> {
  const all = await fetchAllLps(client, paging);
  return all
    .filter((lp) => lp.gauge_alive)
    .sort((a, b) => {
      if (a.emissions !== b.emissions) return a.emissions > b.emissions ? -1 : 1;
      return a.lp < b.lp ? -1 : 1;
    })
    .slice(0, count);
}

/**
 * Pages RewardsSugar.epochsLatest — the CURRENT epoch of every gauged pool.
 * The offset walks the POOL list and pools without a live gauge yield no row,
 * so the contract returns SHORT PAGES MID-STREAM: pagination must run
 * ceil(totalPools / pageSize) pages and never stop early on a short page
 * (confirmed against ldeso/aerodrome's fetcher, which hit the same trap).
 */
export async function fetchLatestEpochs(
  client: SugarClient,
  totalPools: number,
  { pageSize = 100n }: { pageSize?: bigint } = {},
): Promise<SugarLpEpoch[]> {
  const epochs: SugarLpEpoch[] = [];
  for (let offset = 0n; offset < BigInt(totalPools); offset += pageSize) {
    const raw = await client.readContract({
      address: BASE_REWARDS_SUGAR_ADDRESS,
      abi: rewardsSugarAbi,
      functionName: "epochsLatest",
      args: [pageSize, offset],
    });
    epochs.push(
      ...raw.map((e) => ({
        ts: e.ts,
        lp: e.lp,
        votes: e.votes,
        emissions: e.emissions,
        bribes: e.bribes.map((r) => ({ token: r.token, amount: r.amount })),
        fees: e.fees.map((r) => ({ token: r.token, amount: r.amount })),
      })),
    );
  }
  return epochs;
}

/**
 * Stage-1 candidate selection: top `count` alive-gauge pools by CURRENT-epoch
 * votes (descending; ties by address). Votes are the crowd's own live estimate
 * of where the revenue is, and they naturally include Slipstream CL pools.
 * Pure — unit-tested against faked inputs. (Stage 2, in cli.ts, re-ranks the
 * candidates by trailing USD revenue once epochs are priced.)
 */
export function selectVoteCandidates(
  lps: readonly SugarLp[],
  latest: readonly SugarLpEpoch[],
  count: number,
): SugarLp[] {
  const byAddress = new Map(lps.map((lp) => [lp.lp.toLowerCase(), lp]));
  const rows: { lp: SugarLp; votes: bigint }[] = [];
  for (const epoch of latest) {
    const lp = byAddress.get(epoch.lp.toLowerCase());
    if (!lp || !lp.gauge_alive) continue;
    rows.push({ lp, votes: epoch.votes });
  }
  rows.sort((a, b) => {
    if (a.votes !== b.votes) return a.votes > b.votes ? -1 : 1;
    return a.lp.lp < b.lp.lp ? -1 : 1;
  });
  return rows.slice(0, count).map((r) => r.lp);
}

/** Pages RewardsSugar.epochsByAddress until `maxEpochs` or history ends. */
export async function fetchPoolEpochs(
  client: SugarClient,
  pool: Address,
  { maxEpochs = 200, pageSize = 25n }: { maxEpochs?: number; pageSize?: bigint } = {},
): Promise<SugarLpEpoch[]> {
  const epochs: SugarLpEpoch[] = [];
  let offset = 0n;
  while (epochs.length < maxEpochs) {
    const raw = await client.readContract({
      address: BASE_REWARDS_SUGAR_ADDRESS,
      abi: rewardsSugarAbi,
      functionName: "epochsByAddress",
      args: [pageSize, offset, pool],
    });
    epochs.push(
      ...raw.map((e) => ({
        ts: e.ts,
        lp: e.lp,
        votes: e.votes,
        emissions: e.emissions,
        bribes: e.bribes.map((r) => ({ token: r.token, amount: r.amount })),
        fees: e.fees.map((r) => ({ token: r.token, amount: r.amount })),
      })),
    );
    if (raw.length < Number(pageSize)) break;
    offset += pageSize;
  }
  return epochs.slice(0, maxEpochs);
}

/** Maps a decoded sugar epoch to the dataset schema (pure, unit-tested). */
export function sugarEpochToRecord(epoch: SugarLpEpoch): EpochRecord {
  const mapRewards = (rewards: readonly { token: Address; amount: bigint }[]): TokenAmount[] =>
    rewards.map((r) => ({ token: r.token, amount: r.amount.toString() }));
  return {
    ts: Number(epoch.ts),
    votes: epoch.votes.toString(),
    emissions: epoch.emissions.toString(),
    bribes: mapRewards(epoch.bribes),
    fees: mapRewards(epoch.fees),
  };
}

/** Number of weekly epochs covering roughly `months` months. */
export function epochsForMonths(months: number): number {
  return Math.ceil((months * 30.44 * 86_400) / WEEK);
}
