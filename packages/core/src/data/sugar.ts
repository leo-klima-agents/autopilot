/**
 * Sugar indexer client (Base). Minimal hand-written viem ABIs for exactly
 * the functions/structs we use, with struct field order copied EXACTLY from
 * the Vyper sources (Vyper struct returns map to ABI tuples):
 * - RewardsSugar.epochsByAddress(limit, offset, pool) -> LpEpoch[]
 *   (contracts/RewardsSugar.vy @ velodrome-finance/sugar main)
 * - LpSugar.all(limit, offset, filter) -> Lp[] and byAddress(pool) -> Lp
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

/** LpSugar on Base (A11; re-verify on chain before funds move). */
export const BASE_LP_SUGAR_ADDRESS: Address = "0x69dD9db6d8f8E7d83887A704f447b1a584b599A1";
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

/** Minimal RewardsSugar ABI (epochsByAddress only). */
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

/** Minimal LpSugar ABI (all + byAddress). */
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
  {
    type: "function",
    name: "byAddress",
    stateMutability: "view",
    inputs: [{ name: "_address", type: "address" }],
    outputs: [{ name: "", type: "tuple", components: lpComponents }],
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
 * Top pools by current gauge emission rate (descending; ties by address).
 * Emission rate is the comparable single-token proxy for TVL/volume rank —
 * USD TVL needs prices the chain does not provide. Dead gauges (A12: killed
 * gauges return no epoch data) are excluded.
 */
export async function fetchTopPools(
  client: SugarClient,
  { count = 30, pageSize = 200n, maxPages = 25 }: { count?: number; pageSize?: bigint; maxPages?: number } = {},
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
  return all
    .filter((lp) => lp.gauge_alive)
    .sort((a, b) => {
      if (a.emissions !== b.emissions) return a.emissions > b.emissions ? -1 : 1;
      return a.lp < b.lp ? -1 : 1;
    })
    .slice(0, count);
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
