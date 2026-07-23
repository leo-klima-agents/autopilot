# Tranche Pilot: Build Brief

**Product:** an immutable, fully on-chain allocation autopilot for the Aero economy on Base.
**Date:** 2026-07-23 · **Status:** specification, pre-implementation · **Audience:** the implementing engineer/agent, then auditors.

---

## 0. Mission and philosophy

Build a vault that pools users' AERO into staked (sAERO) positions and continuously re-allocates
them toward productive pools, with **no owner, no keeper, no oracle, no upgrade path, and no
off-chain computation**. Every state transition is either user-initiated (deposit) or
permissionless-with-bounty (rebalance, claim, compound). The deployer's keys are worthless the
moment the constructor returns.

The design discipline is borrowed from high-assurance systems (seL4, Qubes OS): make the trusted
computing base so small that it can be audited exhaustively, prove or fuzz every invariant, and
accept *less functionality* as the price of *verifiable correctness*. Concretely:

- **One contract per protocol generation**, target ≤ 700 lines including NatSpec. No proxy, no
  diamond, no library deployment, no inheritance tower.
- **Immutability is the security model, not a limitation.** Bugs are forever, so the assurance
  budget (testing, fuzzing, symbolic checking, audit) dominates the build budget. Improvements
  ship as *new deployments* ("release series"); users migrate voluntarily. There is no in-place
  upgrade, ever.
- **Minimal strategy, honestly framed.** The vault attempts exactly one thing: beat the
  weight-average allocator return ("the market") by being *more reactive* than the crowd. Its
  edge is structural: pooled deposits are large enough to be split across many staggered-cooldown
  tranches, so some fraction of the vault can always act on fresh information while individual
  allocators wait out their full cooldown.
- **Zero fees, zero privileged parties.** The vault takes nothing. Callers of permissionless
  functions earn small in-kind bounties; that is the entire incentive layer.

Two deliverables:

1. **`TranchePilot`** — the Aero v3 vault (buildable only after Aero's code publishes; see §9 timeline).
2. **`EpochPilot`** — a functional proof-of-concept on live Aerodrome v2, deployable now. v2's
   weekly epoch offers no tranche edge (every position may re-vote each epoch, synchronized at
   the flip), so the PoC demonstrates the *machinery* — pooled custody, permissionless operation,
   immutability, reproducible verification — with the honest tracking strategy, at capped size.

---

## 1. Required reading (with links)

Budget one day. Read tier 1 before designing, tier 2 before writing Solidity, tier 3 during the
assurance phase. **Never take a contract address from this document or any article — resolve
addresses on-chain or from official repos at the moment of use.**

### Tier 1 — the protocol

| Source | Why |
|---|---|
| https://aero.xyz/articles/the-aer-engine-and-the-aero-economy/ | The AER Engine: continuous per-second emissions, mint-on-claim, and **Gauge Caps pegged to projected pool revenue** — the caps are the strategy's signal (§4). |
| https://aero.xyz/articles/aero-economic-case/ | Why reactivity pays: published on-target accuracy rises 48% → 64% → 70% as the allocation signal window narrows from weekly voting to a 24h signal with 48h reallocation; earliest cbBTC allocators realized ≈ +43% vs trailing expectation. This is the empirical case for the tranche edge. |
| https://aero.xyz/articles/aero-predictive-allocation-faq/ | The operationally decisive facts: the reallocation cooldown (48h at launch) is **per sAERO position**, positions **cannot be split** by holders, allocations **persist** until changed, sAERO is transferable. The entire tranche design hangs on the first fact — see assumption G1 in §2. |
| https://aero.xyz/articles/aero-the-aer-engine-faq/ | Cap mechanics: caps target a global multiplier of pool revenue (e.g. 1.2×), re-evaluated ~every 48h; cap = 0 is gauge deactivation. Migration mechanics for v2 → v3. |
| https://aero.xyz/articles/aero-is-on-the-horizon/ | Timeline (re-check it; dates have moved): code publishes in batches from **Aug 3, 2026**; audits to Aug 21; public Sherlock contest **Aug 24 – Sep 11** ($400k); launch September. |
| https://github.com/dromos-labs/metadex-specs | The v3 idea drafts (pre-final; the published code wins every disagreement). Read at minimum: `docs/overview.md` (terminology, component map), `docs/voter/voter.md` (continuous allocation, decay, cooldown set on root Voter), `docs/leaf-voter/leaf-voter.md` (per-gauge rates, **effective rate = min(allocated, cap)**, cooldown enforcement lives here), `docs/voting-escrow/voting-escrow.md` (managed NFTs removed; creation-time **permanent-stake flag**; `depositFor`-style top-ups preserved; stake changes do **not** touch allocations), `docs/gauge/gauge-factory.md` (**caps stored on the gauge factory**: default + per-gauge override, bounded cap operator), `docs/minter/minter.md`, `docs/rewards/rewards.md` (staker fee/incentive accrual — what the vault claims), `docs/pool-factory/pool-factory.md` (on-chain pool indexes — candidate enumeration). |

### Tier 2 — the v2 protocol (PoC target) and prior art

| Source | Why |
|---|---|
| https://github.com/aerodrome-finance/contracts | Live v2 on Base. Read `SPECIFICATION.md`, `PERMISSIONS.md`, then `contracts/Voter.sol` (public `weights(pool)`, `totalWeight`, `vote(tokenId, pools[], weights[])` normalizes **relative** weights internally; `onlyNewEpoch` = one vote per epoch; first hour blocked = `DistributeWindow`; last hour whitelist-only; `maxVotingNum` = 30), `contracts/VotingEscrow.sol` (`createLock`, `increaseAmount`, `depositFor`, permanent locks), `contracts/RewardsDistributor.sol` (rebase auto-compounds into unexpired locks via `depositFor`), `contracts/rewards/Reward.sol` (fee/bribe reward contracts the PoC claims from; `Voter.gaugeToFees`/`gaugeToBribe` validate claim targets on-chain). Assert every one of these behaviors in fork tests; do not trust this table. |
| https://github.com/velodrome-finance/relay (and the Aerodrome fork, https://github.com/aerodrome-finance/relay) | The official v2 relay. Steal one idea only: the **public-caller bounty** — in the last 24h of an epoch anyone may execute maintenance and is paid a bounty, guaranteeing liveness without keepers. Tranche Pilot generalizes this to *every* mutating function. Note everything it has that we refuse: admins, sweeps, allowed-caller roles, managed NFTs (removed in v3 anyway). |
| https://github.com/velodrome-finance/sugar | On-chain data API. Not a dependency of the vault (the vault reads protocol state directly); useful for the monitoring dashboard and for validating candidate sets off-chain. |
| https://docs.base.org | Chain parameters (2s blocks, fees). |

### Tier 3 — assurance, verification, tooling

| Source | Why |
|---|---|
| https://book.getfoundry.sh (esp. https://book.getfoundry.sh/forge/invariant-testing) | Build/test/fork/invariant harness. |
| https://github.com/d-xo/weird-erc20 | The reward-token threat catalog: fee-on-transfer, reverting, blocklisted, rebasing tokens. The claim path must survive all of them (§6). |
| https://docs.openzeppelin.com/contracts/5.x/erc4626 | The share-inflation (first-depositor) attack and standard mitigations; the vault is not 4626 but the mint math has the same failure mode. |
| https://github.com/Synthetixio/synthetix/blob/develop/contracts/StakingRewards.sol | The per-share reward accumulator pattern the distributor reimplements minimally. |
| https://github.com/crytic/building-secure-contracts | Threat-modeling and testing checklists; Slither/Echidna guides. |
| https://github.com/crytic/slither · https://github.com/crytic/echidna · https://github.com/a16z/halmos · https://docs.soliditylang.org/en/latest/smtchecker.html · https://github.com/Certora/gambit | Static analysis, property fuzzing, symbolic execution, SMT checking, mutation testing — the assurance stack of §7. |
| https://sourcify.dev · https://basescan.org/verifyContract (docs: https://docs.basescan.org) | Verification: Sourcify (keyless, exact-match) as primary; Basescan standard-JSON as the required public display (§8). |
| https://github.com/Arachnid/deterministic-deployment-proxy | CREATE2 deterministic deployment so the address is derivable from the bytecode alone. |
| https://audits.sherlock.xyz/contests | Aero's public contest (Aug 24 – Sep 11) — monitor findings; each one is a free re-check of our protocol-facing assumptions. |

---

## 2. Load-bearing protocol facts and kill criteria

Every fact below must be re-verified against the **published code** (from Aug 3) and again against
the **deployed contracts** (September) before deployment. Confidence: `faq` = official article,
`spec` = idea draft, `code` = verified in deployed v2 code.

| # | Fact | Source | If wrong |
|---|---|---|---|
| G1 | Reallocation cooldown is enforced **per sAERO position (tokenId)**, not per owner/account/global | faq | **Kill criterion for the edge.** If keyed per owner, all K tranches share one cooldown and the vault degenerates to K=1 (a plain reactive pilot — still shippable, no tranche claim). Verify the exact storage key in published LeafVoter code. |
| G2 | Positions cannot be split by holders; tranche structure must exist at stake time | faq/spec | If splitting ships, tranche creation gets easier; design unaffected. |
| G3 | Creation-time **permanent stake** flag: constant weight, no decay | spec | Fallback: create max-duration stake then lock-permanent in two calls (v2 works this way today). |
| G4 | Stake top-ups (`depositFor`/increase) do **not** reset allocations or the cooldown; increased weight backs existing allocations | spec (voter.md §6) | If top-ups reset cooldowns, deposits must buffer and join only at each tranche's rebalance slot — an accounting change, not an architecture change. Verify explicitly. |
| G5 | Allocations persist until changed; a stopped vault keeps earning | faq | Safety story for "no pause needed"; if false, liveness bounties must be raised. |
| G6 | **Per-gauge emission caps live on the gauge factory** (default + override), readable on-chain, recalibrated ~48h, pegged to projected pool revenue; cap 0 = deactivated gauge | spec + faq | Strategy signal (§4). If caps are unreadable or uniform in practice, fall back to mirror mode (§4.3). |
| G7 | Voter exposes allocation entrypoints taking pools + relative weights; minimum allocation weight (anti-dust) exists | spec | Signatures are provisional; the contract is written against **published** interfaces only. |
| G8 | Exchange revenue (fees + incentives) accrues to allocators in reward contracts, claimable per position, in heterogeneous tokens | spec | Distributor design (§5.4) assumes pull-per-token; if revenue is protocol-converted (e.g. USDC), the distributor simplifies. |
| G9 | v2 (PoC): one vote per epoch per tokenId; vote window is (epochStart+1h, epochStart+WEEK−1h) with the last hour whitelist-only; `Voter.weights(pool)`/`totalWeight` are public; `vote()` normalizes relative weights; `maxVotingNum` = 30 | code | Assert all of it in fork tests against Base mainnet. |
| G10 | v2 (PoC): rebases are claimable permissionlessly per tokenId and auto-compound into unexpired locks | code | Assert in fork tests. |

**Spec-freeze gate:** implementation of `TranchePilot` does not start until G1, G3, G4, G6, G7 are
confirmed in published code. Keep a diff log (published code vs this table) from Aug 3.

---

## 3. Product specification — `TranchePilot` (Aero v3)

### 3.1 Lifecycle

1. **Deploy** (CREATE2, no constructor privileges). All parameters are `immutable`/`constant`
   (§3.5). The deployer has no residual power.
2. **Seeding.** Users `deposit(amount)` AERO; the vault holds it liquid and mints shares 1:1.
   During seeding, `withdrawSeed(shares)` refunds 1:1 — depositors are not committed until the
   vault is.
3. **Activation.** Once total seed ≥ `ACTIVATION_MIN` (sized so every tranche clears the
   protocol's minimum stake with margin), anyone calls `activate()`: the vault creates
   **K permanent sAERO stakes** of equal size (G2/G3) and records their tokenIds. Irreversible.
   Refunds end.
4. **Steady state**, four permissionless operations (§3.4): `deposit`, `rebalance`,
   `claimRevenue`, `compound`.
5. **There is no step 5.** No pause, no sunset, no admin unwind. The vault runs as long as the
   protocol does. If the protocol dies, allocations persist (G5) and shares keep their claim on
   whatever revenue still accrues.

### 3.2 Shares and exit

- Shares are a minimal ERC-20 (18 decimals, transferable), written in-file — no imports.
- Mint: `shares = amount × totalShares / totalPrincipal` (principal = AERO ever staked +
  compounded). First-mint inflation is neutralized by burning `SEED_BURN` shares to
  `address(0xdead)` at activation (see the OZ 4626 note in tier 3).
- Principal is **permanently staked and never withdrawable** — that is what a permanent stake
  means. Exit = transfer or sell shares. This is stated in the README in bold, in the deposit
  function's NatSpec, and in the UI if one exists. Shares are a perpetual claim on the vault's
  revenue stream; their market price is the market's valuation of that stream.
- If governance ever grants the vault's address the v3 `withdraw-to-NFT` role (role-gated in the
  escrow spec), a pre-wired `exitToNFT(shares)` becomes callable, letting a holder withdraw their
  pro-rata stake into their own sTOKEN. The vault must remain fully functional if that grant
  **never happens** — the code path is inert, not load-bearing (assumption isolation).

### 3.3 Tranches and the reactivity edge

- The vault holds **K permanent positions** (deploy-time constant; default **K = 8**).
- Let `C` = the protocol's live reallocation cooldown (read from the protocol at call time — it is
  governance-settable, never hardcode 48h). Slot length `Δ = C / K` (6h at C = 48h, K = 8).
- Tranche `i` may rebalance only in its slot: `floor((t − t_activation) / Δ) mod K == i`, and only
  if the protocol reports its cooldown elapsed. The grid both **staggers** the tranches and
  **rate-limits** each one; staggering is enforced by arithmetic, not by an operator's diligence.
- The edge, quantified honestly: a solo allocator reacts to new information with worst-case
  latency C; the vault reacts with worst-case Δ = C/K using 1/K of its weight, converging fully
  over one cooldown. Against the published accuracy aggregates (48% on-target for stale
  allocation vs 70% for fresh signal + caps), fresher tracking of the cap vector is worth a
  positive expected spread over the weight-average return. It is a probabilistic edge, not a
  guarantee — the only guaranteed strategy is tracking (§4.3) — and it compresses as more weight
  automates. More users → more weight per tranche above protocol minimums → K can be higher in
  later series → finer reactivity.
- New deposits after activation are routed `depositFor`-style into the **smallest tranche**
  (deterministic tie-break: lowest index), keeping tranches near-equal without any rebalancing
  authority (G4).

### 3.4 Permissionless operations and bounties

Every mutating function is callable by anyone; callers earn in-kind bounties (constant
`BOUNTY_BPS`, default 30 bps, of the value they move). No roles exist.

| Function | What it does | Bounty |
|---|---|---|
| `rebalance(uint8 tranche, address[] gauges)` | In-slot only. Validates the candidate set on-chain (§4.2), reads each gauge's cap from the factory (G6), submits the allocation to the Voter with the cap values as relative weights. | `BOUNTY_AERO` flat, paid from the vault's loose (claimed, not yet compounded) AERO; zero if none — depositors are the natural altruistic callers. |
| `claimRevenue(uint8 tranche, address[] rewardContracts)` | Claims exchange revenue. Each target is validated against the protocol's own gauge→reward registry (never a free-form address). Received amounts are measured by **balance delta** (fee-on-transfer safe) and credited to the per-token distributor (§3.5). | `BOUNTY_BPS` of each claimed token, in kind. |
| `compound()` | Stakes the vault's entire loose AERO balance (revenue in AERO, donations) into the smallest tranche; increases `totalPrincipal`, raising share value. | `BOUNTY_BPS` of the amount compounded. |
| `deposit(uint256 amount)` / share transfers / `claimUser(address token)` | User-facing; no bounty. | — |

### 3.5 Revenue distribution

Exchange revenue arrives in arbitrary tokens (G8). The vault **never swaps** — swapping needs
routes and price protection, which need either an oracle or an operator; all three are banned.

- Per-token Synthetix-style accumulator: `accPerShare[token] += claimed × 1e27 / totalShares`;
  users pull with standard reward-debt accounting, updated on every share mint/transfer/burn.
- AERO is special-cased: it is never distributed, it is compounded (§3.4) — no swap needed, and
  it converts revenue into permanent voting weight, the vault's only growth loop.
- Token isolation: a malicious or bricked reward token can make *its own* `claimUser` revert and
  nothing else — no loops over token lists in any state-changing path, no global token registry
  to poison. Claiming is one token per call.

### 3.6 Constants (all immutable at deploy)

| Constant | Default | Rationale |
|---|---|---|
| `K` | 8 | 6h reactivity at C=48h; each tranche must clear protocol minimums at activation. |
| `ACTIVATION_MIN` | sized post-drop | ≥ K × protocol min stake × 10 margin. |
| `SEED_BURN` | 1e3 shares | inflation-attack dead shares. |
| `MIN_DEPOSIT` | 1e18 (1 AERO) | dust and accumulator-precision hygiene. |
| `BOUNTY_BPS` | 30 | Relay-inspired; large enough to cover gas at Base fees for realistic claim sizes. |
| `BOUNTY_AERO` | 1e18 | flat rebalance bounty. |
| `MAX_GAUGES` | 16 | bounds allocation gas and mirrors protocol per-vote limits. |
| `SERIES_CAP` | e.g. 2,000,000 AERO | hard deposit cap per series (§0: immutable release trains; blast-radius bound for any undiscovered bug). |

---

## 4. Strategy specification

### 4.1 Objective

Maximize expected return **relative to the weight-average allocator** (global revenue ÷ global
allocated weight). Nothing else: no USD accounting, no risk model, no hedging, no fees.

### 4.2 Primary signal: the protocol's own revenue projection (gauge caps)

Aero's gauge caps *are* an on-chain revenue oracle: the protocol continuously maintains
`cap_g ≈ κ × projected revenue of pool g`, recalibrated ~every 48h, stored on the gauge factory,
with κ global (G6). Allocating **proportionally to caps** therefore holds the
revenue-proportional portfolio as projected by the protocol itself — the portfolio the published
"on-target" metric measures everyone against — at zero informational cost and with zero on-chain
arithmetic beyond reading the cap values and passing them as the Voter's relative weights (the
Voter normalizes; G7/G9).

Why this beats the average, when it does: the crowd carries stale and slow weight (the published
baseline: only 48% of epoch-voted emissions landed within 2pp of realized fees). A vault that
re-targets the fresh cap vector within Δ hours of each recalibration is systematically closer to
revenue-proportional than the lagging average — that spread is the return. When the crowd is
fully fresh, the edge is ≈ 0, never structurally negative-sum for shareholders beyond rounding.

Candidate-set validation (the subset problem — a caller could submit a self-serving gauge list):

1. Preferred: **full on-chain enumeration**, if the published pool/gauge indexes (pool-factory.md)
   make "top-`MAX_GAUGES` by cap" scannable at acceptable gas on Base. Measure after Aug 3; a
   few-million-gas view loop once per Δ is acceptable on Base.
2. Fallback: **propose-improve**. During the first half of a slot, anyone may propose a candidate
   set; a proposal replaces the standing one only if its total cap is strictly higher. In the
   second half, anyone executes the standing winner (bounty to the executor). Permissionless
   competition converges to the true top set; a lazy round executes the previous set, which is
   merely stale, not unsafe.
3. Every candidate is individually validated on-chain regardless of mode: gauge exists in the
   factory, is active (cap > 0), pool is protocol-registered, no duplicates, count ≤ `MAX_GAUGES`.

### 4.3 Fallback mode: mirror (guaranteed tracking)

If caps turn out unreadable, uniform, or gamed (G6 wrong), the deterministic fallback — chosen at
*series deploy time*, not by an admin switch — is **mirror-ex-self**: allocate proportionally to
every other participant's allocation weights, validated by an on-chain coverage check
(`Σ weight(candidates) ≥ θ × totalWeight`, θ = 80%). Mirroring earns the weight-average return
identically by construction (your share of every pool equals your share of total weight) and
survives being public: it is a fixed point. It cannot beat the market; it is the floor the
project retreats to, not the product.

### 4.4 What is deliberately out of scope

Predictive/forecasting signals (that is where real alpha lives, and it cannot be computed
on-chain without oracles), LP-side automation, USDC conversion, cross-chain allocation (Base
gauges only in series 1), governance participation, MEV protection beyond not swapping at all.

---

## 5. Contract specification

### 5.1 Banned constructs (enforced by CI grep + review)

No proxy or `delegatecall`. No `selfdestruct`. No inline assembly. No external dependencies or
imports — every needed interface is hand-written from published code into `src/interfaces/`, and
the ERC-20 share logic is written in-file (~60 lines). No oracles. No swaps. No `payable`
functions and no `receive()` (the vault never holds ETH). No signatures/permit. No `try/catch`
control flow (fail loudly). No owner, no roles, no pause, no allowlist mutations — **zero
`onlyX` modifiers in the entire codebase**. `onERC721Received` accepts only the escrow
collection.

### 5.2 Repository layout

```
tranche-pilot/
├── src/
│   ├── TranchePilot.sol          # v3 vault, one file, ≤ ~700 lines w/ NatSpec
│   ├── EpochPilot.sol            # v2 PoC,   one file, ≤ ~450 lines w/ NatSpec
│   └── interfaces/               # hand-written minimal external interfaces
├── test/{unit,fuzz,invariant,fork,symbolic}/
├── script/{DeployEpochPilot.s.sol,DeployTranchePilot.s.sol}   # CREATE2, zero post-deploy calls
├── verification/                 # standard-json artifacts, bytecode hashes, addresses
├── audits/
└── foundry.toml                  # pinned solc (exact patch), optimizer runs, evm_version
```

### 5.3 State (complete list)

Shares: `totalShares`, `balanceOf`, `allowance`. Principal: `totalPrincipal`, `activated`,
`tokenIds[K]`, `trancheStaked[K]`. Distributor: `accPerShare[token]`, `rewardDebt[user][token]`,
`looseAero`. Strategy (propose-improve mode only): `standingSet`, `standingScore`, `slotOfSet`.
Nothing else. Every variable's units and invariants are documented at the declaration.

### 5.4 Invariants (the audit contract — each becomes a Foundry invariant test)

1. `Σ balanceOf = totalShares`; shares are only minted in `deposit`/activation and never burned
   except seed refunds and (if enabled) `exitToNFT`.
2. `totalPrincipal` equals the sum of escrow-reported locked amounts of the K tokenIds
   (post-activation) and is non-decreasing.
3. For every token: `Σ user claimable ≤ vault balance of that token` (accumulator no-loss;
   donations only ever increase the right side).
4. No function callable by address A changes the share value or claimable amount of address B,
   except by strictly increasing them (bounties are paid from unaccrued flows, never from
   credited balances).
5. Tranche `i` submits at most one allocation per protocol cooldown, and only in its slot; at all
   times the K tranches' next-eligible times are distinct modulo C (staggering holds).
6. Every allocation ever submitted is proportional to the validated signal vector of its slot;
   every allocated gauge was factory-registered and cap-positive at submission.
7. The contract never holds ETH; the only ERC-20 approval that ever exists is AERO → escrow, set
   transiently per call.

### 5.5 Events

`Deposited`, `SeedWithdrawn`, `Activated(tokenIds)`, `Rebalanced(tranche, gauges, weights, caller)`,
`RevenueClaimed(tranche, token, amount, bounty, caller)`, `Compounded(amount, tranche, caller)`,
`UserClaimed(user, token, amount)`, plus ERC-20 events. Everything a monitoring dashboard needs is
reconstructable from events alone.

---

## 6. Threat model (minimum set to analyze in writing)

| Threat | Mitigation |
|---|---|
| Malicious candidate set (rebalance) | On-chain per-candidate validation + full-scan or propose-improve (§4.2); worst case = stale-but-valid allocation. |
| Malicious/weird reward token (fee-on-transfer, reverting, blocklist, rebasing — see weird-erc20) | Balance-delta accounting; one-token-per-call isolation; no token loops in state-changing paths. |
| Share inflation / first depositor | Seed phase + `SEED_BURN` dead shares + `MIN_DEPOSIT`. |
| Donation manipulation of accumulators | Donations only increase distributable amounts; accumulator uses internal credit, not raw balances, where balances are attacker-inflatable. |
| Reentrancy via token callbacks | Checks-effects-interactions everywhere + a single `nonReentrant` guard (hand-written, transient storage). |
| Bounty draining (claim dust in a loop) | Bounty is proportional (bps of moved value), never fixed per call except `BOUNTY_AERO`, which requires an in-slot rebalance. |
| Cooldown griefing (attacker resets our cooldowns) | Allocation calls require position ownership at the protocol; verify no third-party path (poke-analogs) resets cooldowns — G4. |
| Protocol-side: cap operator compromise or garbage caps | Bounded damage: allocation is still over factory-registered, active gauges; worst case ≈ mis-weighted but real pools. Kill-switch-free by design; series cap bounds absolute exposure. |
| Protocol governance changes (cooldown length, min weights) | Read live values every call; grid arithmetic adapts; nothing is cached. |
| Immutability itself (bug = forever) | TCB size, §7 assurance stack, `SERIES_CAP`, and the series pattern (new deployment supersedes; old one keeps running honestly). |

---

## 7. Assurance plan (the majority of the budget)

1. **Unit + branch coverage 100%** on both contracts (they are small; no excuses).
2. **Fork tests** against live protocol code: every G-fact in §2 asserted empirically (v2 now on
   Base mainnet forks; v3 first against published code on a local deployment, then against the
   real deployment post-launch, before seeding).
3. **Invariant/fuzz**: every §5.4 invariant under a randomized handler (Foundry; plus an Echidna
   campaign with a different corpus).
4. **Symbolic/SMT**: accumulator arithmetic and share mint/burn paths through halmos and solc's
   SMTChecker (they are loop-light and ideal for it).
5. **Mutation testing** (gambit): the test suite must kill ≥ 95% of mutants; survivors are
   triaged in writing.
6. **Static analysis**: Slither clean or findings triaged in `audits/slither.md`.
7. **External review**: one independent audit minimum; align the review window so Aero's own
   Sherlock contest findings (Aug 24 – Sep 11) can be diffed against our G-facts before freeze.
8. **Freeze discipline**: after the audit, only audited commits deploy. Any source change, however
   trivial, restarts step 7 for the touched paths.

---

## 8. Reproducibility and verification (non-negotiable release gate)

- **Pinned toolchain**: exact `solc` patch version, fixed optimizer runs, fixed `evm_version`,
  `bytecode_hash = "ipfs"` recorded; the repo builds byte-identical bytecode from a clean clone
  (CI job proves it on every commit and nightly against the deployed code).
- **Deterministic deployment**: CREATE2 via the canonical deterministic-deployment proxy; the
  address is derivable from (salt, init code hash) published in `verification/`.
- **Verification, in order**: (1) **Sourcify exact-match** (keyless) for both contracts;
  (2) **Basescan** via standard-JSON upload (`forge verify-contract --show-standard-json-input`
  artifact committed to `verification/`) so the code is readable where Base users actually look;
  (3) the repo README links both and documents the one-command local reproduction
  (`forge build && diff <(cast code <addr>) <(local runtime bytecode)`).
- Release gate: contract not seeded until both verifications are live and the bytecode-diff CI is
  green against the deployed address.

---

## 9. `EpochPilot` — the Aerodrome v2 proof of concept (build first, deploy now)

Purpose: demonstrate seriousness with real money on the live protocol — pooled custody,
permissionless operation, bounties, immutability, reproducible verification — before Aero exists.
v2 has no per-position rolling cooldown (one vote per epoch, synchronized weekly flips, G9), so
tranches confer no reactivity and the PoC runs **one position** and the honest strategy for a
machinery demo: **mirror-ex-self** (track the market; §4.3).

Specification deltas from `TranchePilot`:

- **One veNFT, fixed term.** `createLock(seed, TERM)` with `TERM = 26 weeks` (immutable). Not
  permanent — the term is the exit: after expiry, anyone calls `unwind()` (reset → withdraw), and
  shareholders `redeem(shares)` for pro-rata AERO. A full trustless lifecycle — deposit, operate,
  exit — demonstrable within one season. Weight decays over the term; acceptable for a demo and
  refreshed at each weekly re-vote (v2 `vote()` checkpoints current balance).
- **`DEPOSIT_CAP = 10,000 AERO`** (immutable): blast-radius bound; this is a demonstrator.
- **Weekly `revote(address[] pools)`**, permissionless, allowed only inside
  `[flip − 6h, flip − 1h − 1s]` (late-but-safe: after the whole epoch's information, before the
  whitelist-only final hour; enforce both protocol gates from G9). Validation: pools ≤ 30
  (`maxVotingNum`), each pool has a live gauge, and **coverage** `Σ Voter.weights(pool) ≥ 80% ×
  Voter.totalWeight()` — the on-chain check that defeats self-serving subsets. Weights submitted
  = `Voter.weights(pool) − votes(ourTokenId, pool)` (mirror-ex-self; the Voter normalizes).
- **`claimRevenue(bribes[], fees[], tokens[][])`** validated against `Voter.gaugeToBribe` /
  `gaugeToFees`; per-token accumulator identical to §3.5. **`claimRebase()`** permissionless
  (auto-compounds into the lock, G10). **`compound()`** stakes loose AERO via `increaseAmount`.
- Same banned-constructs list, same bounty pattern, same assurance stack (scaled), same
  verification gate. Target ≤ 450 lines.

What the PoC proves publicly: a verified, immutable, admin-free contract voting weekly on
Aerodrome mainnet, distributing real fees/bribes to real shareholders, with every operation
executed by unaffiliated callers for bounties — the exact machinery `TranchePilot` reuses, minus
the tranche grid.

**Explicit non-goal:** the PoC does not migrate to Aero v3. It is immutable; it cannot learn the
migration interface after deployment. It runs out its 26-week term on v2 (old protocol contracts
remain live-but-inactive after Aero launches) and unwinds. The cap and term make this an
acceptable, disclosed cost of demonstrating with real funds.

---

## 10. Milestones (2026)

| Phase | Dates | Deliverables / gates |
|---|---|---|
| **P0 — PoC** | now – Aug 10 | Tier-1/2 reading done; threat model written; `EpochPilot` implemented; fork suite asserting every G9/G10 fact green; assurance stack run (fuzz/invariant/mutation/Slither); Base Sepolia rehearsal; **mainnet deploy + Sourcify/Basescan verification + seed within the cap**. |
| **P1 — spec freeze** | Aug 3 – 24 | Pull each Aero code batch; diff against §2; resolve G1/G3/G4/G6/G7 with code citations; measure candidate-enumeration gas (choose §4.2 mode); freeze `TranchePilot` spec. |
| **P2 — build + assure** | Aug 24 – Sep 30 | `TranchePilot` implemented against published code; full §7 stack; diff Aero's Sherlock findings against our assumptions; external audit booked and completed. |
| **P3 — deploy** | post-launch + soak | Aero live on Base ≥ 2–4 weeks with no protocol emergency; fork tests green against the **deployed** v3 addresses; deploy via CREATE2; verify; open seeding; `activate()` at threshold. Late deployment against an immutable target is a feature: the vault is immutable, so it waits until its dependency has stopped moving. |

---

## 11. Definition of done

- Both contracts deployed on Base, **Sourcify exact-match and Basescan verified**, bytecode
  reproducible from a clean clone by one documented command, addresses CREATE2-derivable.
- Zero admin surface demonstrated: no function in either ABI is caller-restricted except by
  arithmetic (slots, cooldowns, share ownership).
- 100% branch coverage; all §5.4 invariants fuzzed and (where applicable) symbolically checked;
  mutation score ≥ 95%; Slither triage published; external audit report published in `audits/`.
- Every §2 G-fact carries a citation into **published v3 code** (file + line), not specs or
  articles; the diff log from Aug 3 is complete.
- `EpochPilot` has executed at least one full permissionless cycle on mainnet — deposit → mirror
  re-vote → fee/bribe claim by an unaffiliated caller → user revenue claim — before `TranchePilot`
  seeding opens.
- A README that states plainly, above the fold: principal in `TranchePilot` is permanently
  staked; exit is selling shares; the code cannot be changed by anyone, ever.
