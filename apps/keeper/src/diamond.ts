/**
 * Typed viem clients over the diamond's merged ABI (assembled from facets.json by
 * scripts/merged-abi.mjs — the single ABI callers load against the one custody address).
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Address,
  type Abi,
  type PublicClient,
  type WalletClient,
  type Account,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const diamondAbi = JSON.parse(
  readFileSync(join(repoRoot, "contracts", "out-merged-abi.json"), "utf8"),
) as Abi;

export interface KeeperContext {
  publicClient: PublicClient;
  walletClient: WalletClient | undefined;
  account: Account | undefined;
  diamond: Address;
}

/** Secrets come from the environment only (brief §11) — never from argv or files. */
export function contextFromEnv(): KeeperContext {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is not set");
  const diamond = process.env.DIAMOND_ADDRESS as Address | undefined;
  if (!diamond) throw new Error("DIAMOND_ADDRESS is not set");

  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });

  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined;
  const account = pk ? privateKeyToAccount(pk) : undefined;
  const walletClient = account
    ? createWalletClient({ account, chain: base, transport: http(rpcUrl) })
    : undefined;

  return { publicClient, walletClient, account, diamond };
}
