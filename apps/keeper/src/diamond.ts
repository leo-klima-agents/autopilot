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

// viem client types are inferred (chain-parameterized generics make the bare
// PublicClient/WalletClient annotations unassignable)
function makePublicClient(rpcUrl: string) {
  return createPublicClient({ chain: base, transport: http(rpcUrl) });
}

function makeWalletClient(rpcUrl: string, account: Account) {
  return createWalletClient({ account, chain: base, transport: http(rpcUrl) });
}

export interface KeeperContext {
  publicClient: ReturnType<typeof makePublicClient>;
  walletClient: ReturnType<typeof makeWalletClient> | undefined;
  account: Account | undefined;
  diamond: Address;
}

/** Secrets come from the environment only (brief §11) — never from argv or files. */
export function contextFromEnv(): KeeperContext {
  const rpcUrl = process.env.BASE_RPC_URL;
  if (!rpcUrl) throw new Error("BASE_RPC_URL is not set");
  const diamond = process.env.DIAMOND_ADDRESS as Address | undefined;
  if (!diamond) throw new Error("DIAMOND_ADDRESS is not set");

  const publicClient = makePublicClient(rpcUrl);

  const pk = process.env.KEEPER_PRIVATE_KEY as `0x${string}` | undefined;
  const account = pk ? privateKeyToAccount(pk) : undefined;
  const walletClient = account ? makeWalletClient(rpcUrl, account) : undefined;

  return { publicClient, walletClient, account, diamond };
}
