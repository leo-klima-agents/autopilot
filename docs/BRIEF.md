# Aero Autopilot PoC: Build Brief

**For:** the implementing agent · **Date:** 2026-07-17 · **Scope:** Base / Aerodrome only

You are building a proof-of-concept autopilot (relay) for the Aero economy: a diamond-proxy custody vault plus an off-chain strategy engine that manages voting/allocation positions, a differential-tested TypeScript twin of the on-chain logic, and a static site that lets a user replay strategies against historical and simulated data. It runs live against Aerodrome v2 on Base today and absorbs Aero's real interfaces as they publish.

Work through §1–§3 before writing any code. Everything after that is the specification.

---

## 1. Read this first (context, in priority order)

Do not start from this document alone; it compresses conclusions whose reasoning lives in the sources below. Budget half a day. Tier 1 is mandatory before M0; Tier 2 before touching contracts; Tier 3 as reference during the build.

### Tier 1: The protocol you are building for

| Source | Why you need it |
|---|---|
| https://aero.xyz/articles/the-aer-engine-and-the-aero-economy/ | The AER Engine: continuous per-second emissions, Gauge Caps pegged to pool revenue with overage burned, the REV Engine. This is the economic model you will simulate in `ContinuousModel`. |
| https://aero.xyz/articles/aero-economic-case/ | Predictive Allocation, the case for forecasting over hindsight, the cbBTC early-allocator backtest, and the published emissions-accuracy progression (~48% → ~70% as the signal window narrows). Your backtester reproduces this methodology as its calibration test, read the method carefully. |
| https://aero.xyz/articles/aero-predictive-allocation-faq/ | The operationally decisive details: the 48h cooldown is **per sTOKEN position, not a global epoch**; positions **cannot be split**; allocations **persist** if not changed; sTOKEN is transferable; Autopilot ships at launch. Half the tranche design falls out of these four facts. |
| https://aero.xyz/articles/aero-the-aer-engine-faq/ | Migration mechanics and REV Engine specifics. |
| https://aero.xyz/articles/aero-is-on-the-horizon/ | The timeline this plan is phased around: code publishes in batches from **Aug 3**, audits to Aug 21, public contest **Aug 24 – Sep 11**, launch **September**. Re-check this page at M2 and M4, dates have moved once already. |
| https://github.com/dromos-labs/metadex-specs | The v3 design drafts (~24 docs). Read at minimum `docs/voter/voter.md`, `docs/voting-escrow/voting-escrow.md`, `docs/minter/minter.md`, and the MetaRouter doc. **These are Idea Drafts, not final.** Grep the whole repo for `relay` and `cooldown` before designing anything, the escrow doc removes managed NFTs and explicitly expects relays to be rebuilt as an external layer using role-gated `withdraw-to-NFT`, and it adds creation-time permanent stakes "for frontends, relays, and contracts that always want non-decaying weight" (that sentence is why §4.1 stakes permanent positions). The MetaRouter doc names batched `CLAIM_REWARDS → SWAP → ADD_LIQUIDITY → STAKE` as "particularly useful for relay compounding"; that is the `compound()` shape. |

### Tier 2: The protocol you integrate with today, and the prior art

| Source | Why you need it |
|---|---|
| https://github.com/aerodrome-finance/contracts | Live v2 contracts. `SPECIFICATION.md` and `PERMISSIONS.md` first, then `contracts/Voter.sol` and `contracts/VotingEscrow.sol`. Note in `Voter.sol`: `AlreadyVotedOrDeposited` (one vote per epoch, the constraint behind design principle P3) and `DistributeWindow` (voting is blocked at the start of an epoch). Both must be reproduced as fork-test assertions, not assumed from this brief. |
| https://github.com/velodrome-finance/relay and https://github.com/aerodrome-finance/relay | **The single most valuable reference in this list: the official v2 Relay.** A working autocompounder/autoconverter over managed veNFTs, with a role structure (admin / keeper / allowed caller / public), a swap-route optimizer, epoch-timing rules for who may act when, and a documented admin sweep as last resort. Read its README end to end and steal its lessons, the role separation and the "public caller earns a bounty" pattern both belong in this project's v1 thinking. Note what v3 removes: managed NFTs go away, so this exact architecture does not port. |
| https://github.com/velodrome-finance/sugar | On-chain data API ("sugar") for Velodrome/Aerodrome, including per-pool and Relay data. **Evaluate this before writing the indexer from scratch in `packages/core/data`**, if it exposes the per-epoch pool fee/vote/emission history you need, using it saves days. |
| https://github.com/aerodrome-finance/slipstream | Concentrated-liquidity contracts. Skim only; relevant if LP-side automation is ever added. |
| https://github.com/aerodrome-finance/docs | User-facing docs source. Use for concepts and for locating the canonical deployment address list. |

### Tier 3: The architecture and tooling

| Source | Why you need it |
|---|---|
| https://eips.ethereum.org/EIPS/eip-2535 | The diamond standard itself. Read the "Diamond interface", loupe requirements, and the storage sections. |
| https://github.com/mudgen/diamond-1-hardhat | Nick Mudge's reference implementation. Vendor `Diamond.sol`, `LibDiamond.sol`, `DiamondCutFacet.sol`, `DiamondLoupeFacet.sol`, and the `DiamondInit` pattern from here (MIT). It is Hardhat-based, port the contracts, not the scripts; deployment stays Foundry. `https://github.com/mudgen/diamond` indexes other implementations if you want to compare loupe gas trade-offs. |
| https://eips.ethereum.org/EIPS/eip-7201 | Namespaced storage layout. This is the discipline in §4.2 and it is the difference between a working diamond and a bricked one. |
| https://louper.dev | The diamond explorer maintained for EIP-2535. Verify it resolves your deployed diamond on Base; it is the maintainer-facing UI that Basescan cannot provide. |
| https://book.getfoundry.sh | Fork testing (`vm.createSelectFork`, `vm.warp`), invariant testing, `forge verify-contract`, `rpc_endpoints` env interpolation. |
| https://viem.sh | Typed clients for the indexer, keeper, and site. |
| https://sourcify.dev | Keyless verification (§9.6 primary path). |
| https://docs.safe.global | Safe transaction construction and (for the v1 note in §4.1) Safe modules. |

**Search, don't trust, for anything time-sensitive.** Contract addresses, current launch dates, and post-Aug-3 API shapes must come from official sources at the moment you need them. Never take a contract address from this document; it contains none for that reason.

### What to produce from the reading

Before M0 closes, commit `docs/ARCHITECTURE.md` containing: (a) your restatement of the v3 allocation/revenue/cap model in your own words, (b) a table of every v3 fact this build depends on with a link to its source and a confidence marker (spec-draft vs FAQ-confirmed vs your inference), and (c) a list of every place the design would break if a fact is wrong. This document is your working memory across the Aug 3 code drop; you will diff against it.

---

## 2. Non-negotiables (read before touching a keyboard)

1. **Never commit a secret.** `BASE_RPC_URL` and `ALCHEMY_API_KEY` come from the environment (§10). No key ever reaches `apps/web`, git history, or a log line.
2. **Never invent an address, ABI, or selector.** Fetch from the source repo or the chain. If you cannot verify it, stop and flag it.
3. **The specs are drafts.** Where this brief and `metadex-specs` disagree, the specs win and you flag the diff. Where the specs and post-Aug-3 published code disagree, the code wins and you flag the diff.
4. **Tests are the deliverable, not the afterthought.** A green fork test against real Aerodrome is worth more than any amount of prose in a PR description.
5. **Ask rather than assume** on: anything requiring funds, anything requiring an Owner Safe signature, anything that would add a dependency, and any deviation from §3.

---

## 3. Design principles

**P1, Strategy decisions are computed off-chain; they are validated, bounded, and executed on-chain.** Strategies need historical data, forecasting, optimization, and fast iteration, all hostile to the EVM, and every on-chain line is audit surface. The contracts expose a guardrailed target-allocation interface and are strategy-blind: they cannot tell one strategy from another and never originate a decision. The protocol makes the same choice, read `metadex-specs/docs/minter/minter.md`: the emission rate is computed off-chain by an operator and set on-chain within bounded limits.

**P2, One deterministic core, two implementations, differential testing.** The accounting-critical logic (cooldown scheduling, pro-rata revenue math, allocation optimization, cap/burn arithmetic) exists in TypeScript and Solidity. The TypeScript side generates bigint-exact fixture vectors; a Foundry harness replays them through the Solidity implementation and asserts exact equality. TS generates, Solidity verifies.

**P3, Sub-weekly cadence is simulation-only until Aero ships.** Aerodrome v2 permits one vote change per epoch (`Voter.sol`: `AlreadyVotedOrDeposited`), so only the weekly strategy runs live today. The 48h/24h/1h/1-block regimes run in the simulator against a parameterized Aero model. The 1-block case exists to demonstrate its own futility: reactive returns at that cadence converge to the system average minus latency costs.

**P4, Diamond architecture (EIP-2535); custody address is forever, logic is facets.** The vault is a single diamond proxy whose functions are provided by small, replaceable facets. The motivating property: the diamond *owns the position NFTs*, and swapping logic (above all, swapping the protocol integration when Aero's interfaces publish in August and again at September launch) is a `diamondCut`, not a custody migration. Positions, approvals, allowlists, and monitoring integrations keep one address for the life of the project. The cost is well-known diamond complexity (delegatecall, shared storage, selector routing), contained by the rules in §4.2. `diamondCut` authority is the root permission of the system and belongs exclusively to the Owner Safe.

**P5, Few, standard, audited imports.** OpenZeppelin 5.x utility libraries (SafeERC20 and friends), forge-std, and the vendored EIP-2535 reference implementation, nothing else. OZ contracts that assume linear storage layout (stock `AccessControl`, `ReentrancyGuard`) are **not** used as-is; reimplement their logic over namespaced storage (§4.2). No assembly outside the vendored diamond internals, no gas golf; optimize for auditability.

**P6, Single-owner custody; no depositor share token.** Multi-depositor shares over locked-NFT custody would triple the contract surface for zero PoC value. Two Safes on Base: an **Owner Safe** (2/3 minimum, cold-ish signers: `diamondCut`, parameters, rescues, migration) and a **Strategist Safe** (lower threshold, e.g. 1/2 or 2/4 with responsive signers: submits target allocations). The **keeper** is a hot key with mechanical, guardrail-bounded execution and no discretion. Damage ceilings by construction: keeper compromise costs liveness only; Strategist Safe compromise costs bad-but-bounded allocation until the Owner revokes the role; Owner Safe compromise costs everything, hence its higher threshold and coldest signers.

**P7, Secrets never reach the browser.** The site is fully static. Historical datasets are built in CI from repository secrets and published as versioned JSON; the site fetches plain files.

**P8, The v3 integration surface is quarantined in one facet.** Everything spec-derived (cooldown semantics, gauge caps, weight decay) sits behind the `IProtocolFacet` selector set and configuration. Expect to write the Aero protocol facet twice (draft against specs, rewrite against published code) and budget for it. Everything else is a parameter.

**Stack:** pnpm monorepo · Foundry · Node 22, TypeScript 5.x, viem · Vite + React 18 + recharts · vitest + fast-check. **Repo:** private through audit-contest season (~mid-September), then public; MIT `LICENSE` committed from day one so publication is a visibility flip. GitHub premium is available, so GitHub Pages deploys from the private repo from day one, note the site is public even while the repo is private, and shipped strategy configs are readable in the bundle; a PR-checklist item confirms each deploy contains no private alpha.

---

## 4. Smart contracts

### 4.1 The diamond and its facets

One diamond proxy; each facet small (~60–150 lines), single-purpose, independently replaceable:

- **DiamondCutFacet / DiamondLoupeFacet**, vendored from `mudgen/diamond-1-hardhat`, unmodified. Cut authority: Owner Safe only. Loupe is the on-chain source of truth for what code is live; `facets.json` is its off-chain mirror, diffed in CI and in every deployment checklist.
- **AccessFacet**, grant/revoke for `OWNER`, `STRATEGIST` (Strategist Safe), `KEEPER` (hot key), via `LibAccess` over namespaced storage.
- **CustodyFacet** (ERC-721 receipt (`onERC721Received` gated to the escrow contract), owner rescue of any NFT/token) a feature under single-owner custody, not a bug. Custody state never moves: every upgrade is a facet swap around the NFTs, never a transfer of them.
- **TrancheFacet**, registry mapping `trancheId → positionTokenId` with per-tranche `lastActionAt` for cooldown accounting. Positions are created as **separate permanent stakes from the start**: v3 positions cannot be split (Predictive Allocation FAQ) and permanent stakes avoid weight decay (escrow spec), so staggered-cooldown tranche structure must exist at stake time. Same discipline applied to v2.
- **TargetsFacet**, `setTargets(targets, strategyRef)` stores the strategist's allocation as a **queued intent** after guardrail validation: pool allowlist, max per-pool weight fraction, max reallocation delta, per-tranche cooldown check (config: 7d for the v2 grid; 48h/24h/1h for v3 modes), optional min-organic-flow oracle hook (stubbed). One strategist signature drives many keeper executions, so multisig latency costs signal freshness, never liveness, a deliberate speed governor against panicked reallocation. For post-Aero short-cadence operation, a Safe module delegating submission to a bounded hot key is a documented v1 option (guardrails already cap any strategist's damage).
- **ExecutionFacet**, `rotate(trancheId)` (reset + re-allocate toward the stored target), `harvest(trancheId)` (claim fees/bribes/rebase), `compound(trancheId, minOut)` (swap claims to AERO, increase the stake; mirrors the MetaRouter batch flow). Keeper-gated, mechanical, converges tranches as cooldowns unlock.
- **Protocol facets**, `AerodromeFacet` (live v2), `MockAeroFacet` (test-only v3 semantics: per-position rolling cooldown, per-second streaming revenue, gauge caps with overage burn, optional decaying weights, every parameter test-settable), `AeroFacet` (drafted from specs in M2, finalized against published code in M5). All implement the same `IProtocolFacet` selector set (~10 functions: `createStake`, `allocate`, `reset`, `claimable`, `claim`, `positionWeight`, `cooldownRemaining`, epoch/window metadata). **The August and September protocol transitions are a single `diamondCut`** swapping one facet's selectors for another's, custody, tranches, targets, roles, and address untouched.

**Strategy identity.** Per P1 the contracts are strategy-blind. Exactly two traces of strategy identity touch the chain: the cooldown/cadence guardrail parameter (Owner-set (operationally, this is what "switching strategy class" means on-chain), and the opaque `bytes32 strategyRef` on `setTargets`, emitted in the event but never validated) a free attribution tag (keccak of the TS strategy config) linking every target to the config that produced it. Attribution, not enforcement.

Explicitly out of scope (documented in OPERATIONS.md): share token, deposit/withdraw queue, performance fees, withdraw-to-NFT integration (role-gated in v3 (the design must not depend on a role grant), and *verifiable* strategy commitments (publishing config pre-images so third parties can check targets against a committed strategy) a v1 extension already enabled by the `strategyRef` hash).

### 4.2 Storage discipline (the diamond's real risk surface)

All state lives in ERC-7201 namespaced structs in `LibVaultStorage`, one namespace per domain (`aero.autopilot.access`, `.custody`, `.tranches`, `.targets`, `.protocol.config`), each at a keccak-derived slot. Rules, CI-enforced where possible:

1. Structs are **append-only**: never reorder, retype, or delete fields, deprecate by renaming to `__deprecated_*`.
2. No facet declares contract-level state variables (lint rule: zero storage in facets).
3. Every namespace string is registered in one file; CI fails on duplicates or on a struct whose layout hash changed without an append.
4. `DiamondInit` is the only writer during cuts; each cut ships an idempotent init guarded against re-execution.

### 4.3 Standards

Solidity 0.8.2x, custom errors, events on every state change (consumed by keeper, monitoring, and site), NatSpec throughout, `forge fmt` + `slither` in CI (triage the vendored diamond's delegatecall findings once, document, pin).

### 4.4 What the diamond buys, and what it costs

Buys: one immortal custody address; protocol-swap-as-cut for the two hard transitions on a fixed external timeline; small, separately auditable logic units; loupe-based introspection for monitoring. Costs: delegatecall/shared-storage risk (contained by §4.2), selector-collision management (CI-checked against the manifest), harder block-explorer UX (§9.6), and cut power as a single point of catastrophic failure (contained by Owner Safe threshold and the §9.5 runbook). An immutability endgame is available and documented: once final, a cut can remove `diamondCut` itself, freezing the diamond permanently, a v1+ decision, not a PoC one.

---

## 5. Repository layout

```
aero-autopilot/
├── contracts/                  # Foundry project
│   ├── src/
│   │   ├── Diamond.sol             # vendored EIP-2535 proxy, unmodified
│   │   ├── libraries/
│   │   │   ├── LibDiamond.sol          # vendored
│   │   │   ├── LibAccess.sol           # roles over namespaced storage
│   │   │   └── LibVaultStorage.sol     # ERC-7201 namespaced structs (one per domain)
│   │   ├── facets/
│   │   │   ├── DiamondCutFacet.sol     # vendored
│   │   │   ├── DiamondLoupeFacet.sol   # vendored
│   │   │   ├── AccessFacet.sol
│   │   │   ├── CustodyFacet.sol
│   │   │   ├── TrancheFacet.sol
│   │   │   ├── TargetsFacet.sol
│   │   │   ├── ExecutionFacet.sol
│   │   │   └── protocol/
│   │   │       ├── AerodromeFacet.sol      # live v2 integration (Base)
│   │   │       ├── MockAeroFacet.sol       # simulated v3 semantics for tests
│   │   │       └── AeroFacet.sol           # v3 integration (drafted M2, finalized M5)
│   │   ├── interfaces/
│   │   │   ├── IProtocolFacet.sol      # the selector set every protocol facet implements
│   │   │   └── external/               # minimal Aerodrome v2 interfaces
│   │   └── init/DiamondInit.sol
│   ├── facets.json                 # manifest: name → selectors → address (CI-diffed vs loupe)
│   ├── test/{unit,diamond,fork,invariant,differential}/
│   ├── script/{Deploy.s.sol,Cut.s.sol}
│   └── foundry.toml
├── packages/core/              # the TypeScript twin, single source of shared logic
│   └── src/{math,model,strategies,scheduler,backtest,data,fixtures}/
├── apps/web/                   # Vite React static site, imports @aero-autopilot/core
├── apps/keeper/                # CLI: watch → compute targets → submit txs
├── data/                       # versioned JSON datasets built by CI (never secrets)
│   └── tokens.json                 # cached token metadata (Alchemy-resolved, build time)
├── docs/{ARCHITECTURE.md,OPERATIONS.md}
└── .github/workflows/{ci.yml,fork-tests.yml,data.yml,pages.yml}
```

DRY mechanics: the Solidity↔TypeScript boundary is exactly two shared artifacts, JSON fixture vectors and generated ABIs consumed by viem's typed clients (the diamond presents one merged ABI assembled from `facets.json`). No logic is written twice except the deliberately duplicated deterministic core verified under P2.

---

## 6. TypeScript core (`packages/core`)

- **`math/`**, 1e18-bigint fixed-point utilities whose rounding matches Solidity exactly; the foundation that makes differential testing meaningful. No floating point in fixture-relevant paths (floats allowed in analytics/plotting only).
- **`model/`**, two protocol models behind one interface. `EpochModel` (v2): weekly flips, one vote change per epoch, persistent votes, pro-rata lump-sum rewards at epoch end. `ContinuousModel` (v3): per-second revenue streaming pro-rata by weight; per-position cooldown (default 48h); gauge caps `emissions ≤ κ × trailingRevenue` with overage burned (default κ = 1.2, a placeholder, not a published value: mark it as such and re-check at the Aug 3 drop); optional weight decay; crowd models (reactive herd with lag, static, adversarial wash-bait).
- **`data/`**, 12+ months of per-epoch, per-pool fees, bribes, vote weights, and emissions for the top ~30 Aerodrome pools, as schema-versioned JSON. **Evaluate `velodrome-finance/sugar` before building this from raw logs.** Plus a synthetic-scenario generator (persistent / bursty / regime-switching fee processes calibrated to empirical Aerodrome distributions).
- **`data/tokens.ts`, token metadata via Alchemy.** Pools are addresses; humans need `vAMM-WETH/cbBTC`. Use the **Alchemy Token API** (`alchemy_getTokenMetadata` on `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`, or the equivalent SDK call) to resolve each pool's `token0`/`token1` into name, symbol, decimals, and logo, then compose the display name from the pool's own on-chain properties: `vAMM-` / `sAMM-` from the `stable` flag on v2 pools, `CL{tickSpacing}-` for Slipstream pools, followed by `symbol0/symbol1`. Rules:
  - **The chain is the source of truth, Alchemy is the convenience layer.** Pool contracts expose `symbol()` directly; prefer it where present and use Alchemy metadata to fill gaps, resolve `token0`/`token1` for pools that lack a symbol, and supply logos. Where the two disagree, log the conflict rather than silently preferring one.
  - **Resolve at build time, never at render time.** Metadata is baked into the versioned JSON datasets by the CI job and shipped as static files, the site never calls Alchemy, because the site never holds a key (P7).
  - **Cache and pin.** Metadata is near-static: cache by token address in a committed `data/tokens.json` with a schema version, refresh only for unseen addresses, and treat a token that changes symbol as an anomaly worth surfacing. This keeps dataset rebuilds cheap and rate-limit-free.
  - **Sanitize.** Token symbols are attacker-controlled strings. Strip control characters and clamp length before they reach JSON or the DOM; never interpolate a symbol into HTML unescaped. A pool named `<img onerror=...>` is a real thing on a permissionless DEX.
- **`scheduler/`**, the tranche/cooldown state machine used identically by simulator, keeper, and fixture generation: given tranche states and a target, emit the action list.
- **`backtest/`**, runs a strategy against a model + dataset. Metrics: total return; return vs the passive benchmark (global revenue ÷ global weight); max drawdown vs benchmark; turnover; on-target-% reproducing the published methodology from the economic-case article as a calibration check of the whole pipeline.

---

## 7. Strategy suite

All implement `Strategy { propose(state: MarketState, portfolio: Portfolio): TargetAllocation }`, simple → complex:

1. **`FixedGridWeekly`**, one vote per epoch, submitted late in the epoch on a trailing-fee signal. The only live-runnable strategy on Aerodrome today; the baseline.
2. **`FixedGrid{48h,24h,1h}`**, same signal, shorter grid; Aero-model only. Isolates the value of cadence.
3. **`PersistenceCarry`**, persistence-weighted trailing revenue (haircut proportional to revenue volatility), (s,S)-threshold reallocation, lock-timing aware: the optimal reactive strategy under a 48h cooldown.
4. **`WaterFilling`**, size-aware marginal-yield equalizer, `max Σ wᵢRᵢ/(Wᵢ+wᵢ)`; standalone and as the allocator inside strategies 3 and 5.
5. **`ContinuousGreedy`**, event-driven: reallocate any unlocked tranche when the marginal-yield gap exceeds threshold plus costs; cooldown parameter down to one block (the latency-race limit, per P3).

Each strategy ships a config schema (drives the web UI forms) and a golden backtest snapshot asserted in CI, so refactors that change results fail loudly.

---

## 8. Test plan

1. **Unit**, every facet function, guardrail branch, and protocol facet against the mock. Coverage gate ≥95% of `src/` lines.
2. **Diamond suite**, loupe invariants (every manifest selector routes to the expected facet; no orphans); cut access control (only Owner Safe; non-owner cuts revert); selector-collision detection against `facets.json`; storage-namespace collision and layout-hash checks; **upgrade tests**: populate full state, execute a protocol-facet swap via `Cut.s.sol`, assert every namespace byte-identical and all flows functional post-cut; this test *is* the September migration rehearsal in miniature, and it runs in CI on every facet change.
3. **Fork (Base mainnet, pinned block)**, the money path end-to-end against real Aerodrome through the diamond: create lock → vote → warp across the epoch flip → claim fees/bribes/rebase → compound → re-vote. **Assert the v2 constraints empirically rather than trusting this brief**: same-epoch re-vote reverts (`AlreadyVotedOrDeposited`), voting blocked in the distribute window (`DistributeWindow`), zero-reward claims, NFT transfer in/out. Plus a mid-lifecycle facet swap (Aerodrome→Mock→Aerodrome) proving custody and tranche state survive. Nightly + labeled PRs.
4. **Invariant/fuzz (Foundry)**, cooldowns can never be violated by any call sequence; Σ tranche weights ≤ position weight; guardrail bounds hold under fuzzed strategist inputs; mock-v3 conservation (streamed + burned = emitted); the diamond holds no unaccounted tokens after harvest; no call sequence excluding `diamondCut` can alter selector routing.
5. **Differential (P2)**, TS fixture generators emit vectors for cooldown-scheduler transitions, pro-rata revenue accounting, water-filling allocations, and cap/burn math; a Foundry harness replays each and asserts exact equality.
6. **Scenario (MockAeroFacet)**, narrative tests: the early-allocator arc (early weight → outsized revenue share → decay as the crowd arrives); a wash-bait pool rejected by the organic-flow filter; cooldown shortening mid-run; 48h cap recalibration.

`packages/core` carries its own vitest suite with property-based tests (fast-check) over the math and scheduler, the same vectors, approached from the other side.

---

## 9. Web app (`apps/web`)

Static Vite + React with no backend, importing `@aero-autopilot/core` directly, the simulator in the browser is byte-identical to the one CI tested.

- **Data:** versioned JSON from `/data/` for historical Aerodrome; synthetic Aero scenarios generated client-side from seeds, reproducible via URL params.
- **UI:** strategy picker with schema-driven config forms; model picker (v2 epoch / v3 continuous) with cooldown {7d, 48h, 24h, 1h, 1 block}, cap κ, and crowd-lag controls; results as equity curve vs passive benchmark, allocation heat-map over time, turnover and on-target-% panels; preset story scenarios (early-allocator, latency race, wash-bait).
- **Engineering:** heavy runs in a web worker; deterministic seeds so shared links reproduce exactly.
- **Design:** an intentional visual identity, not a dashboard template; the protocol's own engine/flight vocabulary is a natural direction. Read `/mnt/skills/public/frontend-design/SKILL.md` if available in your environment before building UI.
- **Hosting:** `pages.yml` builds on push to `main` → GitHub Pages from day one (P7 keeps live-RPC mode disabled there). The Vite `base` path is switchable, so a later Vercel migration is `vercel.json` plus one config flip, zero code changes.

---

## 10. OPERATIONS.md: governors & maintainers guide (you write this; here are the required contents)

1. **Roles & keys.** The two-Safe + keeper structure of P6, signer and key rotation runbooks, per-compromise damage ceilings, with `diamondCut` called out as the root permission.
2. **Deployment runbook.** Fork rehearsal → Base Sepolia dry run (mock protocol facet) → mainnet canary (§12) → scale. Address book with checksums covering the diamond *and every facet*; post-deploy checklist: roles granted, guardrails set, loupe diffed clean against `facets.json`, init executed exactly once, event emission spot-checked, verification complete (§10.6).
3. **Keeper operations.** Cadence per function (rotation strategy-dependent; harvest/compound daily; nothing protocol-forced in v3, but v2 forces weekly awareness). Alerts: no vote recorded in the final 12h of an Aerodrome epoch; failed transactions; strategist-target staleness; RPC failure; `strategyRef` mismatch (submitted ref ≠ hash of the approved config, catches a strategist running the wrong config, otherwise invisible precisely because the contracts are strategy-blind); **any `DiamondCut` event** (no legitimate unscheduled cut exists, page immediately).
4. **Failure modes & gotchas** (each with detection, impact, response):
   - Missed epoch vote (v2): prior votes persist but weights go stale and new signals go unexecuted, degraded, not zero, returns.
   - Voted too early (v2): locked until the flip while better information arrives; mitigated by the late-vote policy and its boundary-race test.
   - Static-vote decay (v2): ve balance decays while cast weight doesn't auto-update; periodic re-vote ("poke") policy.
   - Unclaimed rebase (v2): compounding drag; covered by weekly harvest.
   - **The migration event (September): the single highest-risk operational moment.** Positions must exit any custody contract before migrating to Aero; migrated positions receive new token/NFT ids; delay costs migration ratio as old-protocol rebases continue. Step-by-step runbook: exit positions from the diamond → migrate → re-stake into fresh tranches → cut `AeroFacet` in. Rehearsed with the canary (§12) and structurally by the CI upgrade test (§8.2). Verify every step against the current Aero migration guidance at the time, not against this brief.
   - Bad cut: wrong selectors, missing init, storage clobber. Prevention: `Cut.s.sol` only, manifest diff, upgrade tests, Sepolia rehearsal of every mainnet cut. Response: cuts are reversible, re-cut the previous facet addresses from the archived manifest (archive every manifest version).
   - Protocol facet mismatch at Aero launch: published ABIs differ from the idea-draft specs; response is rewriting `AeroFacet` behind the frozen `IProtocolFacet` (P8) and fork-testing against published code before any funds move.
   - Data staleness / provider outage: site degrades to last-published JSON with a staleness banner; keeper falls back to a secondary RPC.
   - Secret hygiene: keys only in Actions secrets and the keeper environment; a CI step greps the built site bundle for key patterns and fails the deploy on a hit.
   - Upstream parameter changes: cooldown length and cap κ are protocol-settable; configs mirror them, with documented watch points (governance forum, `dromos-labs` repos, audit-contest findings).
5. **Cut runbook (diamond governance).** Every `diamondCut` follows one ceremony: PR updating facet source + `facets.json` → CI green including upgrade tests → Sepolia rehearsal with loupe diff attached to the PR → Owner Safe signature collection with the exact calldata hash cross-checked by each signer against the PR → execution → post-cut loupe diff and smoke test → manifest archived and re-verification (§10.6). Emergency cuts follow the same steps compressed, never skipped.
6. **Contract verification (Sourcify-first, explorer-second).** Diamonds need deliberate verification or the system is an unreadable black box. No step may require a paid explorer API key:
   - **Primary: Sourcify** (free, keyless). Every facet and the diamond, at deploy time and after every cut: `forge verify-contract --verifier sourcify`. Pin exact compiler version, optimizer runs, and via-IR settings in `foundry.toml`, verification fails on any mismatch, so freeze profiles per release tag. Archive constructor args alongside `facets.json`. Blockscout's Base instance auto-imports Sourcify verifications.
   - **Basescan display, keyless path:** attempt Sourcify import; fall back to manual standard-JSON upload from `forge verify-contract --show-standard-json-input`. If a working free key is later obtained, wire it in as convenience, never as a dependency.
   - Basescan's proxy UI does not resolve EIP-2535 routing, so Read/Write-as-Proxy will not show facet functions against the diamond address. Document two workarounds for maintainers and signers: (a) **louper.dev** pointed at the diamond on Base, linked in the README and in Safe transaction descriptions; (b) the merged-ABI artifact from `facets.json`, published in the repo, loadable into Basescan's "Custom ABI" feature. Neither depends on an explorer API.
   - Acceptance: exact commands in OPERATIONS.md, and the deployment checklist treats "all facets Sourcify-verified + visible on Blockscout + louper resolves the diamond + merged ABI published" as the release gate; Basescan source display is best-effort and tracked as a checklist item, not a gate.
7. **Sunset/emergency.** Pause semantics (keeper stop + strategist revoke leave funds safe: allocations persist and keep earning), full-exit runbook, the immutability endgame (removing `diamondCut` to freeze the system permanently, a v1+ option), and depositor implications if v1 adds shares.

---

## 11. Environment & secrets

**Provisioning:** your local environment comes **pre-provisioned** with `BASE_RPC_URL` (private endpoint, chain reads, fork tests, keeper transactions) and `ALCHEMY_API_KEY` (Alchemy's enhanced APIs: token metadata per §6, and log/receipt queries if the indexer needs them), do not prompt for them, hardcode them, or commit them; read them from the environment everywhere (`process.env` in TS, `vm.envString` in Foundry scripts, `${BASE_RPC_URL}` in `foundry.toml` `rpc_endpoints`). The two are separate on purpose: `BASE_RPC_URL` may point anywhere, so never assume it is an Alchemy endpoint and never construct one by concatenating the key onto it, build Alchemy URLs explicitly from `ALCHEMY_API_KEY`. Your local env does **not** propagate to CI: the same values must be set separately as GitHub Actions repository secrets by a maintainer before `data.yml` and `fork-tests.yml` can go green, flag this at M0 rather than debugging red CI later.

Consumed only by: contract fork tests, the core data indexer and token-metadata resolver, the keeper, deploy/verify scripts, and Actions secrets (`data.yml`, `fork-tests.yml`). Verification is keyless (Sourcify, §10.6); an optional `ETHERSCAN_API_KEY` slot exists in `.env.example` for the convenience path only, nothing in CI or the runbooks requires it. Never referenced in `apps/web`, which is exactly why token metadata is resolved at build time and shipped as static JSON (§6). `.env.example` documents all variables; `.env` is gitignored; CI secret-scans every site build.

---

## 12. Mainnet canary

A small live Aerodrome position (suggested 500–1,000 AERO plus gas float) exercises the real money path before Aero launches, **gated** on: full fork suite green at a pinned block, both Safes deployed with roles verified, Sepolia checklist executed, all facets Sourcify-verified, louper resolving the diamond. If the gate isn't met by ~August 17, stay fork-only until Aero launches. **Funding requires an explicit human go-ahead, never self-authorize.**

**Illiquidity warning:** locked AERO is not withdrawable before lock expiry. The canary's exits are (a) the September migration itself, which is the point: it rehearses the highest-risk runbook with real funds, including the live `AeroFacet` cut, or (b) selling the veNFT on a secondary marketplace. Treat the principal as committed through migration, and choose the shortest lock duration that still earns representative rewards rather than a reflexive max lock.

---

## 13. Milestones

| Phase | Dates (2026) | Deliverables & acceptance criteria |
|---|---|---|
| **M0 Scaffold** | Jul 20–24 | Tier-1 + Tier-2 reading done and `docs/ARCHITECTURE.md` committed per §1; **env preflight passes** (`pnpm preflight`: `BASE_RPC_URL`/`ALCHEMY_API_KEY` present, RPC reachable, chain id = Base, the first command you run); monorepo builds; MIT LICENSE committed; both Safes deployed on Base, addresses recorded; diamond scaffold (vendored cut/loupe + `LibVaultStorage` + manifest CI check) compiling with the diamond suite green on empty facets; `sugar`-vs-custom-indexer decision made and recorded; indexer pulls 12mo of top-30 Aerodrome pools into `data/` with human-readable pool names resolved via Alchemy token metadata (§6). |
| **M1 Core & sim** | Jul 27–Aug 7 | `core` complete: both models, five strategies, backtester reproducing the published on-target-% methodology within tolerance; vitest + property tests green; fixture vectors emitted. |
| **M2 Contracts** | Aug 3–14 | All facets + both protocol facets; unit/diamond/invariant/differential suites green; fork suite green at pinned block including the mid-lifecycle facet swap. **From Aug 3: pull each Aero code drop, diff against `docs/ARCHITECTURE.md`, log every spec delta, draft `AeroFacet`.** |
| **M3 Web** | Aug 10–21 | Site live on Pages from Actions; interactive backtests on historical + synthetic data; URL-reproducible runs; secret-scan enforced. |
| **M4 Ops & v3 readiness** | Aug 24–Sep 11 | OPERATIONS.md complete incl. migration, cut, and verification runbooks; Sepolia dry run incl. a rehearsed cut; canary gate check → funded only on human go-ahead; `AeroFacet` updated against published code; audit-contest findings tracked for spec changes. |
| **M5 Launch week** | Sep (post-contest) | Final `AeroFacet` vs deployed addresses; fork tests vs real Aero; canary migrated through the real flow with the production cut executed per runbook; all facets re-verified; repo flipped public (MIT); go/no-go checklist executed. |

Estimated effort: ~6.5 weeks for one experienced protocol/full-stack engineer. Critical path: M1→M2 differential testing plus the diamond upgrade suite, not the UI.

---

## 14. Definition of done

- `pnpm test` and `forge test` green; fork suite green at the pinned block; coverage gate met.
- Every claim in `docs/ARCHITECTURE.md` carries a source link and a confidence marker; every spec delta since Aug 3 is logged.
- OPERATIONS.md sufficient for someone who never spoke to you to deploy, operate, cut, verify, and migrate the system.
- The site reproduces the published cbBTC early-allocator story as a preset scenario.
- No secret in git history, in `data/`, or in the site bundle, CI proves it.
