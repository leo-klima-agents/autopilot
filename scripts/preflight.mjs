#!/usr/bin/env node
/**
 * Environment preflight (§11, M0 acceptance).
 * Checks: BASE_RPC_URL and ALCHEMY_API_KEY present, RPC reachable, chain id = Base (8453).
 * Exits non-zero with a specific message on the first failure.
 */

const BASE_CHAIN_ID = 8453n;

function fail(msg) {
  console.error(`preflight FAILED: ${msg}`);
  process.exit(1);
}

const rpcUrl = process.env.BASE_RPC_URL;
if (!rpcUrl) fail("BASE_RPC_URL is not set");
if (!process.env.ALCHEMY_API_KEY) fail("ALCHEMY_API_KEY is not set");

const res = await fetch(rpcUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
}).catch((e) => fail(`RPC unreachable: ${e.message}`));

if (!res.ok) fail(`RPC returned HTTP ${res.status}`);
const body = await res.json().catch(() => fail("RPC returned non-JSON"));
if (!body.result) fail(`RPC error: ${JSON.stringify(body.error ?? body)}`);

const chainId = BigInt(body.result);
if (chainId !== BASE_CHAIN_ID) fail(`chain id ${chainId} != Base (${BASE_CHAIN_ID})`);

console.log(`preflight OK: Base RPC reachable (chain id ${chainId}), ALCHEMY_API_KEY present`);
