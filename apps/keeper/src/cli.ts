#!/usr/bin/env node
/**
 * aero-keeper, mechanical, guardrail-bounded execution (P6): the keeper converges
 * tranches toward the strategist's stored target as cooldowns unlock. It has no
 * discretion; a compromised keeper costs liveness only.
 *
 * Protocol-agnostic: everything protocol-specific (the claim payload shape, whether
 * there is a weekly epoch) is dispatched on the diamond's `protocolId()` /
 * `allocationWindow()`, so the September protocol swap (AerodromeFacet → AeroFacet)
 * is a single diamondCut with no keeper change (P8).
 *
 * Commands:
 *   status              print tranches, cooldowns, current target, strategyRef
 *   rotate              rotate every tranche that is cooldown-ready AND stale vs the target
 *   harvest             claim fees/bribes/rebase for every tranche (payload per protocol)
 *   watch               loop: status → rotate-when-ready → alerts (OPERATIONS.md §3)
 *
 * Env: BASE_RPC_URL, DIAMOND_ADDRESS, KEEPER_PRIVATE_KEY (mutating commands),
 *      ALERT_WEBHOOK_URL (optional), WATCH_INTERVAL_SEC (default 300),
 *      EXPECTED_STRATEGY_REF (optional: page if the on-chain ref drifts from the
 *      approved config hash), HARVEST_* (claim payload inputs, see claimData).
 */
import { encodeAbiParameters, keccak256, stringToBytes, type Address } from "viem";
import { contextFromEnv, diamondAbi, type KeeperContext } from "./diamond.js";
import { raise } from "./alerts.js";

/** protocolId() tags: keccak of each protocol facet's identifier string (IProtocolFacet). */
const PROTOCOL = {
  aerodromeV2: keccak256(stringToBytes("aerodrome-v2")),
  aeroV3Draft: keccak256(stringToBytes("aero-v3-draft")),
  mockAeroV3: keccak256(stringToBytes("mock-aero-v3")),
} as const;

/** type(uint64).max: allocationWindow.closesAt for a continuous protocol (no epoch close). */
const NO_WINDOW_CLOSE = 2n ** 64n - 1n;

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
  /** vault-level last rotate/creation timestamp (0 = never rotated). */
  lastActionAt: bigint;
  vaultCooldown: bigint;
  protocolCooldown: bigint;
  ready: boolean;
}

async function trancheStatus(ctx: KeeperContext, trancheId: bigint): Promise<TrancheStatus> {
  const [positionTokenId, lastActionAt] = (await ctx.publicClient.readContract({
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
    lastActionAt,
    vaultCooldown,
    protocolCooldown,
    ready: vaultCooldown === 0n && protocolCooldown === 0n,
  };
}

/** One round-trip per tranche, fetched once per tick and shared by every consumer
 *  (status, rotate, late-epoch), so a watch loop makes ~N reads, not ~3N. */
async function allStatuses(ctx: KeeperContext): Promise<TrancheStatus[]> {
  const ids = await trancheIds(ctx);
  return Promise.all(ids.map((id) => trancheStatus(ctx, id)));
}

async function strategyRef(ctx: KeeperContext): Promise<{ ref: `0x${string}`; submittedAt: bigint }> {
  const [ref, submittedAt] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "strategyRef",
  })) as [`0x${string}`, bigint];
  return { ref, submittedAt };
}

/** Send a keeper tx and route the receipt/exception through the alert sink. Shared by
 *  every mutating command so tx handling (receipt check, failure paging) lives once. */
async function sendTx(
  ctx: KeeperContext,
  label: string,
  functionName: "rotate" | "harvest",
  args: readonly unknown[],
): Promise<void> {
  if (!ctx.walletClient || !ctx.account) throw new Error("KEEPER_PRIVATE_KEY is not set");
  try {
    const hash = await ctx.walletClient.writeContract({
      address: ctx.diamond,
      abi: diamondAbi,
      functionName,
      args,
      chain: ctx.walletClient.chain,
      account: ctx.account,
    } as Parameters<typeof ctx.walletClient.writeContract>[0]);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`${label}: ${receipt.status} (${hash})`);
    if (receipt.status !== "success") await raise("tx-failed", `${label} reverted: ${hash}`);
  } catch (err) {
    await raise("tx-failed", `${label}: ${String(err)}`);
  }
}

async function status(ctx: KeeperContext, statuses?: TrancheStatus[]): Promise<TrancheStatus[]> {
  const rows = statuses ?? (await allStatuses(ctx));
  const [pools, weights] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "targets",
  })) as [Address[], bigint[]];
  const { ref, submittedAt } = await strategyRef(ctx);

  console.log(`diamond ${ctx.diamond}`);
  console.log(`target (${pools.length} pools, strategyRef ${ref}, submitted ${new Date(Number(submittedAt) * 1000).toISOString()}):`);
  pools.forEach((p, i) => console.log(`  ${p}  ${(Number(weights[i]) / 1e18).toFixed(4)}`));
  for (const s of rows) {
    console.log(
      `tranche #${s.trancheId} position=${s.positionTokenId} vaultCooldown=${s.vaultCooldown}s protocolCooldown=${s.protocolCooldown}s ${s.ready ? "READY" : ""}`,
    );
  }

  // strategyRef mismatch: the on-chain ref must equal the keccak of the approved
  // strategy config. A drift means the strategist submitted a target from the wrong
  // config, invisible otherwise because the contracts are strategy-blind (OPERATIONS §3).
  const expectedRef = process.env.EXPECTED_STRATEGY_REF?.toLowerCase();
  if (expectedRef && submittedAt > 0n && ref.toLowerCase() !== expectedRef) {
    await raise("strategy-ref-mismatch", `on-chain strategyRef ${ref} != approved ${expectedRef}`);
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
  return rows;
}

async function rotateReady(ctx: KeeperContext, statuses?: TrancheStatus[]): Promise<void> {
  const { submittedAt } = await strategyRef(ctx);
  if (submittedAt === 0n) return; // no target queued: rotate would revert NoTargetSet
  const rows = statuses ?? (await allStatuses(ctx));
  for (const s of rows) {
    if (!s.ready) continue;
    // Skip tranches already converged on the current target: a tranche whose last
    // rotation is at/after the target submission already reflects it, and re-voting
    // it wastes the cooldown/epoch vote and collapses the staggered-tranche design.
    // (Mirrors the core scheduler, which skips zero-distance tranches.)
    if (s.lastActionAt >= submittedAt) continue;
    await sendTx(ctx, `rotate #${s.trancheId}`, "rotate", [s.trancheId]);
  }
}

/** Claim payload, composed off-chain (P1), dispatched on the live protocol so the same
 *  keeper works before and after the September diamondCut. Reward-contract discovery is
 *  read from the chain by the operator and passed via env (comma-separated). */
function claimData(protocolId: `0x${string}`): `0x${string}` {
  const id = protocolId.toLowerCase();
  if (id === PROTOCOL.aerodromeV2.toLowerCase()) {
    // v2 AerodromeFacet.ClaimData: bribes/bribeTokens/fees/feeTokens/claimRebase
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
  if (id === PROTOCOL.aeroV3Draft.toLowerCase()) {
    // v3 AeroFacet.ClaimData: reward contracts to pull from
    const rewardContracts = (process.env.HARVEST_REWARD_CONTRACTS ?? "")
      .split(",")
      .filter(Boolean) as Address[];
    return encodeAbiParameters(
      [{ type: "tuple", components: [{ name: "rewardContracts", type: "address[]" }] }],
      [{ rewardContracts }],
    );
  }
  if (id === PROTOCOL.mockAeroV3.toLowerCase()) {
    return "0x"; // mock ignores the claim payload
  }
  throw new Error(`unknown protocolId ${protocolId}: refusing to compose a claim payload`);
}

async function protocolId(ctx: KeeperContext): Promise<`0x${string}`> {
  return (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "protocolId",
  })) as `0x${string}`;
}

async function harvestAll(ctx: KeeperContext): Promise<void> {
  const data = claimData(await protocolId(ctx));
  for (const id of await trancheIds(ctx)) {
    await sendTx(ctx, `harvest #${id}`, "harvest", [id, data]);
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

/**
 * Epoch-deadline awareness, protocol-agnostic: uses allocationWindow() rather than a
 * hardcoded weekly grid, so it self-disables on continuous (v3) protocols (closesAt =
 * type(uint64).max) instead of paging every tick after the September cut. On an
 * epoch-based protocol it alerts if a tranche is unvoted with <12h until the window closes.
 */
async function lateEpochVoteCheck(ctx: KeeperContext, statuses?: TrancheStatus[]): Promise<void> {
  const [, closesAt] = (await ctx.publicClient.readContract({
    address: ctx.diamond,
    abi: diamondAbi,
    functionName: "allocationWindow",
  })) as [bigint, bigint];
  if (closesAt >= NO_WINDOW_CLOSE) return; // continuous protocol: no epoch deadline
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (closesAt <= now || closesAt - now > 12n * 3600n) return;
  const rows = statuses ?? (await allStatuses(ctx));
  // a tranche that voted this epoch reports a protocol cooldown reaching past the flip
  const unvoted = rows.filter((s) => s.protocolCooldown === 0n);
  if (unvoted.length > 0) {
    await raise(
      "no-vote-late-epoch",
      `${unvoted.length} tranche(s) have not voted with <12h to the window close: ${unvoted.map((s) => s.trancheId).join(", ")}`,
    );
  }
}

async function watch(ctx: KeeperContext): Promise<never> {
  const interval = Number(process.env.WATCH_INTERVAL_SEC ?? "300") * 1000;
  watchDiamondCut(ctx);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // one status fetch per tick, shared by all three consumers
      const statuses = await allStatuses(ctx);
      await status(ctx, statuses);
      await rotateReady(ctx, statuses);
      await lateEpochVoteCheck(ctx, statuses);
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
