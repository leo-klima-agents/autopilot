#!/usr/bin/env node
/**
 * aero-keeper, mechanical, guardrail-bounded execution (P6): the keeper converges
 * tranches toward the strategist's stored target as cooldowns unlock. It has no
 * discretion; a compromised keeper costs liveness only.
 *
 * Commands:
 *   status              print tranches, cooldowns, current target, strategyRef
 *   rotate              rotate every tranche whose vault+protocol cooldowns have elapsed
 *   harvest             claim fees/bribes/rebase for every tranche (v2 claim payload via env/flags)
 *   watch               loop: status → rotate-when-ready → alerts (OPERATIONS.md §3)
 *
 * Env: BASE_RPC_URL, DIAMOND_ADDRESS, KEEPER_PRIVATE_KEY (mutating commands),
 *      ALERT_WEBHOOK_URL (optional), WATCH_INTERVAL_SEC (default 300).
 */
import { encodeAbiParameters, type Address } from "viem";
import { contextFromEnv, diamondAbi, type KeeperContext } from "./diamond.js";
import { raise } from "./alerts.js";

const WEEK = 7n * 24n * 3600n;

async function trancheIds(ctx: KeeperContext): Promise<bigint[]> {
  return (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "trancheIds",
  })) as bigint[];
}

interface TrancheStatus {
  trancheId: bigint;
  positionTokenId: bigint;
  vaultCooldown: bigint;
  protocolCooldown: bigint;
  ready: boolean;
}

async function trancheStatus(ctx: KeeperContext, trancheId: bigint): Promise<TrancheStatus> {
  const [positionTokenId] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "tranche",
    args: [trancheId],
  })) as [bigint, bigint, boolean];
  const vaultCooldown = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "vaultCooldownRemaining",
    args: [trancheId],
  })) as bigint;
  const protocolCooldown = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "cooldownRemaining",
    args: [positionTokenId],
  })) as bigint;
  return {
    trancheId,
    positionTokenId,
    vaultCooldown,
    protocolCooldown,
    ready: vaultCooldown === 0n && protocolCooldown === 0n,
  };
}

async function status(ctx: KeeperContext): Promise<TrancheStatus[]> {
  const ids = await trancheIds(ctx);
  const statuses = await Promise.all(ids.map((id) => trancheStatus(ctx, id)));
  const [pools, weights] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "targets",
  })) as [Address[], bigint[]];
  const [ref, submittedAt] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "strategyRef",
  })) as [`0x${string}`, bigint];

  console.log(`diamond ${ctx.diamond}`);
  console.log(`target (${pools.length} pools, strategyRef ${ref}, submitted ${new Date(Number(submittedAt) * 1000).toISOString()}):`);
  pools.forEach((p, i) => console.log(`  ${p}  ${(Number(weights[i]) / 1e18).toFixed(4)}`));
  for (const s of statuses) {
    console.log(
      `tranche #${s.trancheId} position=${s.positionTokenId} vaultCooldown=${s.vaultCooldown}s protocolCooldown=${s.protocolCooldown}s ${s.ready ? "READY" : ""}`,
    );
  }

  // staleness alert: target older than 2× the vault rotation cooldown
  const [, , rotationCooldown] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "guardrails",
  })) as [bigint, bigint, bigint, Address];
  const age = BigInt(Math.floor(Date.now() / 1000)) - submittedAt;
  if (submittedAt > 0n && age > 2n * rotationCooldown) {
    await raise("target-stale", `strategist target is ${age}s old (cooldown ${rotationCooldown}s)`);
  }
  return statuses;
}

async function rotateReady(ctx: KeeperContext): Promise<void> {
  if (!ctx.walletClient || !ctx.account) throw new Error("KEEPER_PRIVATE_KEY is not set");
  const statuses = await Promise.all((await trancheIds(ctx)).map((id) => trancheStatus(ctx, id)));
  for (const s of statuses) {
    if (!s.ready) continue;
    try {
      const hash = await ctx.walletClient.writeContract({
        address: ctx.diamond,
        abi: diamondAbi,
        functionName: "rotate",
        args: [s.trancheId],
        chain: ctx.walletClient.chain,
        account: ctx.account,
      });
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
      console.log(`rotate #${s.trancheId}: ${receipt.status} (${hash})`);
      if (receipt.status !== "success") await raise("tx-failed", `rotate #${s.trancheId} reverted: ${hash}`);
    } catch (err) {
      await raise("tx-failed", `rotate #${s.trancheId}: ${String(err)}`);
    }
  }
}

/** v2 claim payload, the keeper composes it off-chain (P1). Reward contract discovery
 *  (gaugeToBribe/gaugeToFees per voted pool) is read from the Voter by the operator and
 *  passed via HARVEST_BRIBES/HARVEST_FEES env (comma-separated), or left empty for the
 *  rebase-only claim. */
function claimData(): `0x${string}` {
  const bribes = (process.env.HARVEST_BRIBES ?? "").split(",").filter(Boolean) as Address[];
  const fees = (process.env.HARVEST_FEES ?? "").split(",").filter(Boolean) as Address[];
  const tokens = (process.env.HARVEST_TOKENS ?? "").split(",").filter(Boolean) as Address[];
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "bribes", type: "address[]" },
          { name: "bribeTokens", type: "address[][]" },
          { name: "fees", type: "address[]" },
          { name: "feeTokens", type: "address[][]" },
          { name: "claimRebase", type: "bool" },
        ],
      },
    ],
    [
      {
        bribes,
        bribeTokens: bribes.map(() => tokens),
        fees,
        feeTokens: fees.map(() => tokens),
        claimRebase: true,
      },
    ],
  );
}

async function harvestAll(ctx: KeeperContext): Promise<void> {
  if (!ctx.walletClient || !ctx.account) throw new Error("KEEPER_PRIVATE_KEY is not set");
  const data = claimData();
  for (const id of await trancheIds(ctx)) {
    try {
      const hash = await ctx.walletClient.writeContract({
        address: ctx.diamond,
        abi: diamondAbi,
        functionName: "harvest",
        args: [id, data],
        chain: ctx.walletClient.chain,
        account: ctx.account,
      });
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
      console.log(`harvest #${id}: ${receipt.status} (${hash})`);
      if (receipt.status !== "success") await raise("tx-failed", `harvest #${id} reverted: ${hash}`);
    } catch (err) {
      await raise("tx-failed", `harvest #${id}: ${String(err)}`);
    }
  }
}

/** page on ANY DiamondCut event, no legitimate unscheduled cut exists (OPERATIONS.md §3) */
function watchDiamondCut(ctx: KeeperContext): void {
  ctx.publicClient.watchContractEvent({
    address: ctx.diamond,
    abi: diamondAbi,
    eventName: "DiamondCut",
    onLogs: (logs) => {
      void raise("diamond-cut-observed", `DiamondCut observed in tx ${logs[0]?.transactionHash}`);
    },
    onError: (err) => {
      void raise("rpc-failure", `event watch: ${err.message}`);
    },
  });
}

/** v2 epoch awareness: alert if no tranche has voted this epoch and <12h remain (A1–A4) */
async function lateEpochVoteCheck(ctx: KeeperContext): Promise<void> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const epochEnd = now - (now % WEEK) + WEEK;
  if (epochEnd - now > 12n * 3600n) return;
  const statuses = await Promise.all((await trancheIds(ctx)).map((id) => trancheStatus(ctx, id)));
  // a tranche that voted this epoch reports a protocol cooldown reaching past the flip
  const unvoted = statuses.filter((s) => s.protocolCooldown === 0n);
  if (unvoted.length > 0) {
    await raise(
      "no-vote-late-epoch",
      `${unvoted.length} tranche(s) have not voted with <12h left in the epoch: ${unvoted.map((s) => s.trancheId).join(", ")}`,
    );
  }
}

async function watch(ctx: KeeperContext): Promise<never> {
  const interval = Number(process.env.WATCH_INTERVAL_SEC ?? "300") * 1000;
  watchDiamondCut(ctx);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await status(ctx);
      await rotateReady(ctx);
      await lateEpochVoteCheck(ctx);
    } catch (err) {
      await raise("rpc-failure", String(err));
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

const command = process.argv[2];
const ctx = contextFromEnv();
switch (command) {
  case "status":
    await status(ctx);
    break;
  case "rotate":
    await rotateReady(ctx);
    break;
  case "harvest":
    await harvestAll(ctx);
    break;
  case "watch":
    await watch(ctx);
    break;
  default:
    console.error("usage: aero-keeper <status|rotate|harvest|watch>");
    process.exit(1);
}
