# ARCHITECTURE.md: Aero Autopilot PoC

**Status:** [M0](BRIEF.md#13-milestones) baseline, written 2026-07-17 from Tier 1/2 reading. This document is the
project's working memory across the Aug 3 code drop: every v3 fact the build depends on is
tabled in §2 with a source and confidence marker, and §3 lists where the design breaks if a
fact is wrong. Diff each Aero code batch against §2 and log deltas in §4.

Confidence markers:

- **[code]**, verified in published, deployed code (Aerodrome v2 on Base).
- **[faq]**, stated in an official aero.xyz FAQ/article; authoritative for intent, not binding.
- **[spec-draft]**, from `dromos-labs/metadex-specs` Idea Drafts; explicitly pre-technical-design.
- **[inference]**; our own conclusion; must be re-checked against published code.

---

## 1. The v3 model: restated

### 1.1 Vocabulary

Aero renames the ve(3,3) machinery: veAERO/veNFT → **sAERO/sTOKEN** (still an ERC-721 NFT,
*not* fungible), lock → **stake**, voting power → **staking weight**, vote → **allocate**,
voting rewards → **exchange revenue**. The fungible per-chain emission receipt is a separate
thing called xTOKEN, do not confuse it with sTOKEN.

### 1.2 Allocation (the Voter, continuous)

The weekly epoch model is gone: **no epochs, no distribute window, no weekly cadence**.
An sTOKEN holder allocates staking weight across pools at any time, subject to a **cooldown**:
at launch, a minimum of **48 hours per sAERO position** (per-position, not a global epoch
clock, the FAQ is explicit). Allocations **persist** until changed. Positions **cannot be
split** by holders (no plan for it); sTOKENs **are transferable**. Stale allocations
**decay**: the Voter stores weight plus a decay schedule and resolves decay lazily on the
next state change, so an untouched allocation loses influence over time, permanent stakes
have constant staking weight (no ve-balance decay), but their *allocations* still decay
per the Voter's schedule. The architecture is federated (root Voter tracks chains;
per-chain LeafVoters track gauges), which this PoC treats as an implementation detail
behind the protocol facet.

### 1.3 Revenue (continuous streaming)

In return for allocating, the position earns the pool's exchange revenue (swap fees, MEV
auction proceeds, incentives) **streamed continuously, pro-rata by allocated weight**, no
lump-sum weekly settlement. Both directions stream concurrently: AERO rewards stream to
pools, revenue streams to allocators.

### 1.4 Emissions (the AER Engine)

The Minter runs a **per-second global emission rate** with mint-on-claim accounting (tokens
that are never claimed are never minted). The rate is **computed off-chain by an authorized
operator** (multiplier × observed fees) and set on-chain within governance bounds: max
percentage change per update (initially 20%) and a minimum cooldown between updates. The
global cap at launch is expected at 20% annualized inflation; realized inflation expected
at 8–12%.

### 1.5 Gauge Caps

Each gauge's emission rate is capped: effective rate = min(allocated rate, cap). Caps are
held at a fixed ratio of the pool's projected revenue, the published "global multiplier
goal" is **"e.g., 1.2×" aggregated pool fee + incentive revenue** (explicitly an example,
not a commitment), and are expected to be **re-evaluated every 48 hours**. Mechanically
(spec-draft): a gauge factory stores a `defaultCap` plus per-gauge overrides; a
governance-designated **cap operator** (intended to be an automation contract reading the
fee-to-emissions signal) adjusts per-gauge caps within a governance-set range and cannot
zero a cap; **cap = 0 is the gauge deactivation mechanism** reserved for governance /
emergency council.

### 1.6 Overage

Emissions above a cap accumulate per-chain as **unused emissions**
(`unusedDelta = (allocatedRate − effectiveRate) × elapsed`, plus early-unstake forfeits).
The root Voter can **Claim** them (mint to treasury, reducing the chain ceiling) or
**Burn** them (reduce the ceiling without minting, "never minted" and "burned" are the
same mechanism described two ways across the articles). Our simulator models this as
burn-by-default.

### 1.7 Relays / Autopilot

**Managed veNFTs are removed in v3.** The escrow spec expects relays to be rebuilt as an
**external composition layer** over two new role-gated operations: `withdraw-to-NFT`
(dual-gated: dedicated role **and** source-owner approval) and `deposit-into-NFT`. Stake
creation accepts a **permanent-stake opt-in flag**, "useful for frontends, relays, and
contracts that always want non-decaying staking weight from the moment of creation." The
MetaRouter names batched `CLAIM_REWARDS → SWAP → ADD_LIQUIDITY → STAKE` as "particularly
useful for relay compounding." The official Autopilot product ships at launch with
allocation automation, USDC conversion, and compounding; this PoC is an independent
implementation of the same category.

### 1.8 Predictive Allocation (why this project exists)

Aero's published backtests: a two-week-old signal (status-quo weekly voting) allocates
on-target (±2pp) only **48%** of the time; a 24h trailing-fee signal revoted every 48h
reaches **64%**; adding gauge caps reaches **70%** with off-target (>5pp) falling
31%→15%→8% and 5.1% of emissions burned by caps. The earliest cbBTC allocators would have
earned **43% higher fees** than expected from past performance. Forecast-driven,
cooldown-aware allocation is therefore the product; this PoC's backtester reproduces the
on-target-% methodology as its calibration test.

---

## 2. Fact table (every v3/v2 fact this build depends on)

### v3, protocol model

| # | Fact | Source | Confidence |
|---|------|--------|------------|
| F1 | Allocation cooldown at launch: minimum 48h before changing an allocation | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq], duration absent from specs |
| F2 | Cooldown is **per sAERO position**, not global | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq], spec-draft is silent on granularity; only says duration is set on root Voter, globally uniform across chains ([voter.md §9](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voter/voter.md)) |
| F3 | Positions cannot be split by holders ("no plan") | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq]; spec replaces split with role-gated `withdraw-to-NFT` ([voting-escrow.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voting-escrow/voting-escrow.md)) |
| F4 | Allocations persist if not changed | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq] |
| F5 | Allocation weights **decay** when stale; resolved lazily on next allocate/reset | [voter.md §1](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voter/voter.md) | [spec-draft] |
| F6 | sTOKEN is an ERC-721 NFT, transferable; ERC-721 behavior unchanged | [voting-escrow.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voting-escrow/voting-escrow.md); [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [spec-draft] + [faq] |
| F7 | Managed NFTs removed; relays rebuilt externally over `withdraw-to-NFT`/`deposit-into-NFT` (dual-gated: role + owner approval) | [voting-escrow.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voting-escrow/voting-escrow.md) | [spec-draft] |
| F8 | Creation-time **permanent stake opt-in flag** (constant weight, no decay), "useful for frontends, relays, and contracts" | [voting-escrow.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voting-escrow/voting-escrow.md) | [spec-draft] |
| F9 | Continuous model: no epochs, no distribute window; allocate any time subject to cooldown | [voter.md §7](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voter/voter.md); [overview.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/overview.md) | [spec-draft] |
| F10 | Revenue streams continuously, pro-rata by allocated weight | [AER Engine article](https://aero.xyz/articles/the-aer-engine-and-the-aero-economy/); [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq] |
| F11 | Minter: per-second rate, mint-on-claim, rate set off-chain by operator within bounds (max Δ 20%/update, min cooldown between updates) | [minter.md §2](https://github.com/dromos-labs/metadex-specs/blob/main/docs/minter/minter.md) | [spec-draft] |
| F12 | Global minter cap ≈ 20% annualized at launch; realized 8–12% expected | [AER FAQ](https://aero.xyz/articles/aero-the-aer-engine-faq/) | [faq] |
| F13 | Gauge cap: effective rate = min(allocated rate, factory cap); `defaultCap` + per-gauge override; cap operator bounded, cannot zero; cap 0 = deactivation | [gauge-factory.md §3–4](https://github.com/dromos-labs/metadex-specs/blob/main/docs/gauge/gauge-factory.md) | [spec-draft] |
| F14 | Cap multiplier "global multiplier goal (e.g., **1.2×** pool fee + incentive revenue)"; caps re-evaluated every **48h** at launch | [AER FAQ](https://aero.xyz/articles/aero-the-aer-engine-faq/); [AER Engine article](https://aero.xyz/articles/the-aer-engine-and-the-aero-economy/) | [faq], **1.2 is an example value ("e.g."), not published-final. Our κ default 1.2 is a placeholder.** |
| F15 | Overage = per-chain unused-emissions accumulator; governance Claims (mint to treasury, ceiling reduced) or Burns (ceiling reduced, nothing minted) | [leaf-voter.md §10](https://github.com/dromos-labs/metadex-specs/blob/main/docs/leaf-voter/leaf-voter.md), [voter.md §5](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voter/voter.md) | [spec-draft]; "never minted" ([AER FAQ](https://aero.xyz/articles/aero-the-aer-engine-faq/)) and "burned" ([economic case](https://aero.xyz/articles/aero-economic-case/)) describe this same mechanism |
| F16 | MetaRouter batches `CLAIM_REWARDS → SWAP → ADD_LIQUIDITY → STAKE`; "particularly useful for relay compounding"; operator commands enforce `owner == msg.sender` | [metarouter.md §7, §9](https://github.com/dromos-labs/metadex-specs/blob/main/docs/metarouter/metarouter.md) | [spec-draft] |
| F17 | Stake creation/extension in integer **weeks**; minimum stake amount (anti-dust); minimum allocation weight (anti-griefing) | [voting-escrow.md](https://github.com/dromos-labs/metadex-specs/blob/main/docs/voting-escrow/voting-escrow.md) | [spec-draft] |
| F18 | Migration: all AERO/veAERO/VELO/veVELO upgrade to new AERO/sAERO; **new token and NFT ids minted**; AERO migrates 1:1; single-epoch migration event, **no deadline**; supply split 94.5%/5.5% | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/); [economic case](https://aero.xyz/articles/aero-economic-case/) | [faq] |
| F19 | Official Autopilot ships at launch (allocation automation, USDC conversion, compounding) | [PA FAQ](https://aero.xyz/articles/aero-predictive-allocation-faq/) | [faq] |
| F20 | Timeline: code publishes in batches from **Aug 3**; final audit through **Aug 21**; public contest **Aug 24 – Sep 11** ($400k pot); launch **September** | [horizon article](https://aero.xyz/articles/aero-is-on-the-horizon/) (checked 2026-07-17) | [faq], **re-check at M2 and M4; dates have moved before** |
| F21 | Backtest methodology: on-target = within 2pp, off-target = >5pp; 48%→64%→70% progression; 24h trailing-fee signal, 48h revote; 5.1% burned by caps; earliest cbBTC allocators +43% fees | [economic case](https://aero.xyz/articles/aero-economic-case/) | [faq], exact cbBTC window/dataset unpublished; calibration is to the published aggregates only |
| F22 | Allocation pseudo-interface: root `vote(tokenId, pools-on-chains, calldata per chain)`; leaf `vote(tokenId, pools[], weights[], power, decay, data)`; `reset(tokenId)`; gauge `getReward(account)`; no read functions for weights/cooldowns specified anywhere | [voter.md / leaf-voter.md / gauge.md mermaid](https://github.com/dromos-labs/metadex-specs) | [spec-draft], signatures WILL change; quarantined behind `IProtocolFacet` (P8) |

### v2, Aerodrome on Base (live integration)

| # | Fact | Source | Confidence |
|---|------|--------|------------|
| A1 | Epoch = 1 week starting Thursday 00:00 UTC; `epochStart = ts − (ts % WEEK)` | [ProtocolTimeLibrary.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/libraries/ProtocolTimeLibrary.sol) | [code] |
| A2 | Distribute window = **first 1 hour** of epoch (`epochVoteStart = epochStart + 1h`); voting in it reverts `DistributeWindow` | Voter.sol `onlyNewEpoch` + ProtocolTimeLibrary | [code], assert in fork test, do not trust this doc |
| A3 | Last 1 hour of epoch: only whitelisted NFTs may vote (`NotWhitelistedNFT`) | Voter.sol / SPECIFICATION.md | [code] |
| A4 | One vote per epoch: `epochStart(now) <= lastVoted[tokenId]` reverts `AlreadyVotedOrDeposited`; `reset()` carries the same gate; `lastVoted` is never reset, the check passes once a new epoch begins | [Voter.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/Voter.sol) lines 100–105 | [code], assert in fork test |
| A5 | `poke(tokenId)` is permissionless, repeatable, blocked only in the distribute window; re-applies existing votes at current balance (reward checkpoints do not auto-update on decay) | Voter.sol lines 194–198 | [code] |
| A6 | `vote(uint256 tokenId, address[] poolVote, uint256[] weights)`, `reset(uint256)`, `claimBribes(address[] bribes, address[][] tokens, uint256 tokenId)`, `claimFees(...)` (claims not epoch-gated) | Voter.sol | [code] |
| A7 | **Permanent locks exist in v2**: `lockPermanent(tokenId)` / `unlockPermanent(tokenId)` (unlock blocked while `voted`); `createLock(value, duration)`, MAXTIME = 4y; `increaseAmount`, `depositFor` (permissionless for normal NFTs) | [VotingEscrow.sol](https://github.com/aerodrome-finance/contracts/blob/main/contracts/VotingEscrow.sol) | [code], enables identical tranche discipline in v2 (permanent stakes, no decay) |
| A8 | Rebase: `RewardsDistributor.claim(tokenId)` permissionless; reverts `UpdatePeriod` until minter poked post-flip; auto-compounds via `depositFor` for unexpired/permanent locks | RewardsDistributor.sol | [code] |
| A9 | veNFT transfers are standard ERC-721 (only LOCKED escrow type blocked); `voted` does not block transfer | VotingEscrow.sol `_transferFrom` | [code] |
| A10 | Base addresses, Voter `0x16613524e02ad97eDfeF371bC883F2F5d6C480A5`, VotingEscrow `0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4`, AERO `0x940181a94A35A4569E4529A3CDfB74e38FD98631`, RewardsDistributor `0x227f65131A261548b057215bB1D5Ab2997964C7d`, Router `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43`, Minter `0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5` | [contracts README deployment table](https://github.com/aerodrome-finance/contracts); Voter + RewardsDistributor cross-checked vs [sugar deployments/base.env](https://github.com/velodrome-finance/sugar/blob/main/deployments/base.env) | [code], re-verify on chain before any funds move |
| A11 | Sugar on Base: LpSugar `0x3058f92ebf83e2536f2084f20f7c0357d7d3ccfe` (newer deployment; enumerates all 34k+ pools **including Slipstream CL**, the `deployments/base.env` address `0x69dD9db6d8f8E7d83887A704f447b1a584b599A1` does NOT index CL pools and must not be used), RewardsSugar `0x1b121EfDaF4ABb8785a315C51D29BCE0552A7678`, VeSugar `0x4d6A741cEE6A8cC5632B2d948C050303F6246D24` | verified on chain 2026-07-18 (`all()` decodes with the 32-field Lp tuple, 34,330 pools, CL from ~offset 28,000); cross-referenced with [ldeso/aerodrome](https://github.com/ldeso/aerodrome); RewardsSugar/VeSugar per [sugar deployments/base.env](https://github.com/velodrome-finance/sugar/blob/main/deployments/base.env) | [code] |
| A12 | `RewardsSugar.epochsByAddress(limit, offset, pool)` walks **up to 200 past epochs** per pool returning `{ts, lp, votes, emissions, bribes[], fees[]}` from genuine on-chain historical records (bribe supply checkpoints, `rewardRateByEpoch`, `tokenRewardsPerEpoch`). Caveats: iteration breaks at pre-gauge history; **killed gauges return no epoch data** | [RewardsSugar.vy](https://github.com/velodrome-finance/sugar/blob/main/contracts/RewardsSugar.vy) | [code] |
| A13 | Relay (prior art): roles admin/keeper/allowed-caller/public; keepers act from 1h post-flip; public callers act in last 24h of epoch (guaranteed compounding without active keepers); admin sweep only first 24h post-epoch and only non-high-liquidity tokens; public caller bounty = "minimum of either 1% of VELO converted or the team-set constant" (wording ambiguous, min vs max unresolved without reading AutoCompounder source); relay has no vote-withdrawal, deposit/withdraw-managed mutually exclusive with voting per epoch | [velodrome-finance/relay README](https://github.com/velodrome-finance/relay) (aerodrome relay README is the identical doc) | [code]/[faq] |
| A14 | v2 managed-NFT creation requires the **AllowedManager** role; this PoC deliberately does NOT use managed NFTs (P6 single-owner custody; also removed in v3) | [PERMISSIONS.md](https://github.com/aerodrome-finance/contracts/blob/main/PERMISSIONS.md) | [code] |

### Simulator parameter defaults derived from the above

| Parameter | Default | Basis |
|---|---|---|
| v3 cooldown | 48h, per position | F1, F2 |
| Cap multiplier κ | 1.2 | F14, **placeholder, "e.g." value; re-check at Aug 3 drop** |
| Cap recalibration interval | 48h | F14 |
| Overage handling | burn | F15 |
| Allocation decay | on, lazy resolution | F5 (rate unpublished, parameterized) |
| v2 epoch | 604800s, Thu 00:00 UTC flip, vote window [+1h, −1h] | A1–A3 |

---

## 3. Where the design breaks if a fact is wrong

Ordered by blast radius.

1. **F2 (per-position cooldown).** The entire tranche architecture, N separate permanent
   stakes with staggered `lastActionAt`, exists to pipeline reallocation through a
   per-position cooldown. If the published code makes the cooldown per-account or global,
   tranches collapse to a single position and `TrancheFacet`/`scheduler` degenerate;
   strategies 3–5 lose their staggering logic. *Mitigation:* cooldown granularity is a
   `MockAeroFacet` parameter and a `ContinuousModel` config field, so the simulator can
   answer "what if" the day the code drops.
2. **F6 (sTOKEN is an ERC-721).** `CustodyFacet` (`onERC721Received`), `TrancheFacet`
   (`trancheId → positionTokenId`) and the rescue path all assume NFT positions. If launch
   code ships fungible positions, custody and tranche registries need a redesign; this is
   a §4.1 facet rewrite, not a redeploy (the diamond address survives; P4 pays off here).
3. **F3 (no split).** Tranche structure must exist at stake time. If splitting ships after
   all, tranche creation gets *easier* (design still valid, just conservative).
4. **F8 (creation-time permanent stakes).** We stake permanent from day one to avoid decay
   accounting. If the flag doesn't survive to launch code, `createStake` becomes
   create-then-lock-permanent (two calls, v2 already works this way, A7) or tranches carry
   decay accounting (larger change: TS models + facet weight math).
5. **F22 (interface shapes).** Guaranteed to change, specs publish no real signatures.
   All spec-derived calls are quarantined behind `IProtocolFacet` (P8); the `AeroFacet`
   rewrite against published code is budgeted (M2 draft, M5 final). If the *semantic
   surface* changes (e.g. allocation requires per-chain calldata we can't construct
   on-chain), the keeper composes it off-chain and the facet validates+forwards, P1
   already points this way.
6. **F5 (decay).** If allocation decay is absent or radically different, `poke`-analog
   maintenance disappears and stale-allocation strategies improve; simulator flag `decay:
   off` covers it. If decay is *faster* than modeled, PersistenceCarry's haircut constants
   recalibrate, config, not code.
7. **F14 (κ = 1.2).** Explicitly an example value. Everything consuming κ reads it from
   config; the backtester's cap-sensitivity sweep exists precisely because this number is
   soft.
8. **F11 (minter bounds).** If the operator model or bounds change, only `ContinuousModel`
   emission ceilings move; no contract surface depends on it.
9. **F18 (migration mechanics).** New NFT ids on migration are assumed by the September
   runbook (exit → migrate → re-stake fresh tranches → cut `AeroFacet`). If migration
   preserves ids or migrates in place, the runbook simplifies; if it adds deadlines
   (currently "no deadline"), the runbook gains a hard date, operational, not structural.
10. **F1 (48h).** If launch cooldown differs (e.g. 24h), configs change; the strategy grid
    already spans 1h–7d.
11. **A10/A11 (addresses).** Read from README/env files, cross-checked, but **must be
    re-verified against the chain (bytecode + a view-call probe) in the deploy script and
    before any funds move**, never trusted from this doc (Non-negotiable #2).
12. **F20 (timeline).** If Aug 3 slips, M2's "diff each drop" loop starts later and the
    spec-draft `AeroFacet` stays authoritative longer; if launch slips past September, the
    canary stays in v2 longer (its principal is committed through migration, §12 of the
    brief).

## 4. Spec-delta log (append-only from Aug 3)

| Date | Source (batch/commit) | Fact affected | Delta | Action taken |
|---|---|---|---|---|
|  |  |  |  |  |

## 5. Decisions taken at M0

- **Indexer: sugar-first.** `RewardsSugar.epochsByAddress` (A12) provides exactly the
  per-epoch, per-pool `{votes, emissions, bribes[], fees[]}` history the backtester needs,
  up to 200 epochs back, in one view call per pool page. The custom-log indexer is not
  built. Token metadata comes from Alchemy at build time (§6 of the brief). Killed-gauge
  caveat (A12) is logged per pool in the dataset manifest.
- **Pool selection: two-stage, USD-ranked** (revised 2026-07-18; methodology inspired by
  [ldeso/aerodrome](https://github.com/ldeso/aerodrome)). The original ranking by current
  gauge emission rate empirically surfaced zero Slipstream CL pools, which dominate real
  fee revenue. Two causes: the ranking itself, and the `base.env` LpSugar deployment not
  indexing CL pools at all (fixed by the newer deployment, A11). Stage 1: top ~80
  alive-gauge pools by CURRENT-epoch votes (`RewardsSugar.epochsLatest`; CL pools included
  naturally). Stage 2: top 40 of those by trailing 30-month USD revenue (revised
  2026-07-21: 40 pools match the published methodology — the accuracy study runs over the
  top 40 pools — and the window must contain the cbBTC early-allocator episode of
  Sep 2024 – Feb 2025, which sits outside any 12-month window; 30 rather than 24 months
  keeps that episode inside the trailing window for another year of weekly refreshes,
  and the cbBTC-backtest preset pins absolute dates and fails loudly once it finally
  ages out). Known survivorship limitation: stage 1 selects by votes as-of-today, so
  pools that died before the snapshot never enter the universe. `fetchTopPools`
  (emission ranking) is kept only as the no-key fallback.
- **Revenue is USD-priced** (revised 2026-07-18). Per-epoch `feesUsd`/`bribesUsd` are
  computed at index time from the Alchemy Prices API (daily history,
  `api.g.alchemy.com/prices/v1`): each reward amount × that token's price at the epoch's
  Thursday-start date, bigint floor per amount. Prices cache incrementally in
  `data/prices.json`; tokens Alchemy cannot price carry a sentinel and their amounts are
  skipped and counted (`PoolRecord.pricing` coverage). Raw token amounts remain in the
  dataset; the unpriced sum fallback survives only for synthetic single-quote-token data.
- **v2 tranches stake permanent locks** (A7 `lockPermanent`) mirroring the v3 permanent
  opt-in (F8), so tranche accounting is decay-free in both protocol models and the same
  scheduler drives both.
- **Diamond vendored from `mudgen/diamond-1-hardhat`** (MIT) unmodified: `Diamond.sol`,
  `LibDiamond.sol`, cut/loupe facets; our own `DiamondInit`. OZ v5.6.1 utilities vendored
  (pinned), only storage-layout-free libraries are used as-is (P5).
- **Repo layout note:** the GitHub repository is `leo-klima-agents/autopilot`; the brief's
  `aero-autopilot/` root maps to the repository root.
