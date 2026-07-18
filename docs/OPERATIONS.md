# OPERATIONS.md — Governors & Maintainers Guide

For anyone who must deploy, operate, cut, verify, or migrate this system without ever
having spoken to its authors. Companion to `docs/ARCHITECTURE.md` (protocol facts) and
the build brief. Everything time-sensitive (addresses, launch dates, migration guidance)
must be re-verified against official sources at the moment of use — never from this file.

---

## 1. Roles & keys

One diamond, three authorities (P6), with damage ceilings by construction:

| Authority | Instrument | Threshold | Powers | Compromise costs |
|---|---|---|---|---|
| **Owner Safe** | Safe on Base, 2/3 minimum, cold-ish signers | highest | **`diamondCut` (the root permission of the system)**, role grant/revoke, guardrail parameters, NFT/token rescue, tranche create/retire, migration | **everything** — hence the higher threshold and coldest signers |
| **Strategist Safe** | Safe on Base, responsive signers (1/2 or 2/4) | low-latency | `setTargets` only, inside Owner-set guardrails (allowlist, max pool weight, max delta, cooldown) | bad-but-bounded allocation until the Owner revokes `STRATEGIST_ROLE` |
| **Keeper** | hot key | n/a | `rotate` / `harvest` / `compoundTranche` — mechanical convergence toward the stored target, zero discretion | **liveness only**: it can stop executing, never redirect funds |

`diamondCut` authority is exclusively the Owner Safe (ERC-173 diamond owner). There is no
role that can cut. `OWNER_ROLE` is implicitly held by the diamond owner.

**Rotation runbooks:**

- *Keeper rotation:* generate a new key on the keeper host → Owner Safe: `grantRole(KEEPER_ROLE, new)` → confirm a successful `rotate`/`harvest` from the new key → `revokeRole(KEEPER_ROLE, old)` → destroy the old key. Order matters: grant before revoke, zero liveness gap.
- *Strategist signer rotation:* handled inside the Strategist Safe (owner swap module); the diamond only knows the Safe address. If the Safe itself must be replaced: `grantRole(STRATEGIST_ROLE, newSafe)` → verify a `setTargets` from the new Safe → `revokeRole(STRATEGIST_ROLE, oldSafe)`.
- *Owner Safe signer rotation:* inside the Safe. If the Safe address itself must change (last resort): `transferOwnership(newSafe)` via the old Safe, after a rehearsed dry run on Sepolia. Nothing else in the system references the owner address.
- *Compromise response:* keeper key leaked → revoke `KEEPER_ROLE` (funds were never at risk; positions keep earning, F4). Strategist Safe compromised → revoke `STRATEGIST_ROLE`; the worst already-done damage is a guardrail-bounded reallocation; rotate back at the next cooldown. Owner Safe compromised → race to `transferOwnership`/rescue; this is the catastrophic case the threshold exists to prevent.

## 2. Deployment runbook

Sequence: **fork rehearsal → Base Sepolia dry run (mock protocol facet) → mainnet canary (§12 of the brief) → scale.**

1. `pnpm preflight` (env sanity: RPC reachable, chain id 8453).
2. Fork rehearsal: `forge test --match-path 'test/fork/*'` green at the pinned block.
3. Sepolia dry run: run `script/Deploy.s.sol` against Base Sepolia with `MockAeroFacet` cut in (no live Aerodrome there); execute the deployment checklist below; rehearse one protocol-swap cut via `script/Cut.s.sol`.
4. Mainnet: `forge script script/Deploy.s.sol --rpc-url base --broadcast` with env: `OWNER_SAFE`, `STRATEGIST_SAFE`, `KEEPER_ADDRESS`, `AERODROME_*` addresses (the script probes `voter.ve()` and `escrow.token()` on-chain and refuses mismatches — addresses are never trusted from docs).
5. Record the **address book with checksums** — diamond *and every facet* — in `contracts/facets.json` (`address` field per facet per network) and archive the manifest version.

**Post-deploy checklist** (all must pass before any funds move):

- [ ] roles granted: `hasRole(STRATEGIST_ROLE, strategistSafe)`, `hasRole(KEEPER_ROLE, keeper)`; diamond owner == Owner Safe
- [ ] guardrails set and read back: `guardrails()`, allowlist populated
- [ ] loupe diffed clean against `facets.json` (run the diamond suite pointed at the deployment, or louper.dev visual check)
- [ ] init executed exactly once (re-submission of the init calldata reverts `InitAlreadyExecuted`)
- [ ] event emission spot-checked (a `TargetsSet` and a `Rotated` on dust amounts)
- [ ] verification complete per §6 below
- [ ] GitHub Actions repository secrets `BASE_RPC_URL` + `ALCHEMY_API_KEY` set by a maintainer (local env does not propagate — brief §11). `ALCHEMY_API_KEY` drives token metadata AND historical USD pricing; without it the weekly dataset falls back to unpriced vote ranking. `data/prices.json` is a committed, regenerable build cache (safe to delete; first rebuild ~5-7 min, weekly incremental ~2-3 min).

## 3. Keeper operations

Cadence per function:

| Function | Cadence | Notes |
|---|---|---|
| `rotate` | strategy-dependent: weekly grid on v2 (late-epoch, see §4 "voted too early"); 48h/24h/1h grids post-Aero | never forced by v3 protocol; v2 forces weekly awareness |
| `harvest` | daily | includes weekly rebase claim after each flip (v2: minter `updatePeriod` must have run) |
| `compoundTranche` | daily, after harvest | keeper composes swap routes off-chain; aggregate `minAmountOut` enforced on-chain |
| `poke` (v2, direct on Voter) | after material ve-balance changes | see "static-vote decay" below |

**Alerts (page on):**

- no vote recorded in the final 12h of an Aerodrome epoch (v2 mode)
- failed keeper transactions (any)
- strategist-target staleness: `strategyRef().submittedAt` older than 2× the strategy cadence
- RPC failure / fallback engaged
- `strategyRef` mismatch: submitted ref ≠ keccak of the approved strategy config — catches a strategist running the wrong config, otherwise invisible precisely because the contracts are strategy-blind
- **any `DiamondCut` event. No legitimate unscheduled cut exists — page immediately.**

## 4. Failure modes & gotchas

| Failure | Detection | Impact | Response |
|---|---|---|---|
| Missed epoch vote (v2) | no-vote alert (final 12h) | prior votes persist but weights go stale; new signals unexecuted — degraded, not zero, returns | fix keeper; rotate next epoch; no funds at risk |
| Voted too early (v2) | vote timestamp early in epoch | locked until flip while better information arrives | late-vote policy (submit in the last quarter of the epoch, never inside the final whitelist-only hour); boundary-race covered by fork tests |
| Static-vote decay (v2) | ve balance vs cast weight divergence | non-permanent positions' cast weight overstates decayed balance | tranches are permanent locks (no decay) by design; if any non-permanent position exists, schedule periodic `Voter.poke` |
| Unclaimed rebase (v2) | `RewardsDistributor.claimable > 0` for >1 epoch | compounding drag | weekly harvest covers it; rebase auto-compounds into permanent locks (A8) |
| **The September migration** | — | **the single highest-risk operational moment** | see runbook below |
| Bad cut (wrong selectors, missing init, storage clobber) | CI upgrade tests, Sepolia rehearsal, post-cut loupe diff | can brick routing or clobber state | *Prevention:* `Cut.s.sol` only, manifest diff, upgrade tests, Sepolia rehearsal of every mainnet cut. *Response:* cuts are reversible — re-cut the previous facet addresses from the archived manifest (archive every version) |
| Protocol facet mismatch at Aero launch | published ABIs differ from idea-draft specs (expected — F22) | `AeroFacet` draft unusable as-is | rewrite behind the frozen `IProtocolFacet` (P8); fork-test against published code **before any funds move** |
| Data staleness / provider outage | dataset `generatedAt` age; RPC errors | site shows stale data; keeper blind | site degrades to last-published JSON with a staleness banner; keeper falls back to secondary RPC |
| Secret hygiene breach | CI secret-scan of site bundle; data-job grep | key exposure | rotate the key at the provider immediately; scrub caches; keys exist only in Actions secrets and the keeper environment |
| Upstream parameter changes (cooldown length, cap κ are protocol-settable) | watch points: governance forum, `dromos-labs` repos, audit-contest findings | configs drift from reality | mirror the new values in strategy configs and `MockAeroFacet` params; log in ARCHITECTURE.md §4 |

**Migration runbook (September, rehearse on the canary first):**

Positions must exit any custody contract before migrating; migrated positions receive
**new token/NFT ids** (F18); delay costs migration ratio as old-protocol rebases continue.

1. Freeze: keeper stopped, strategist role revoked (allocations persist and keep earning — pausing is safe, F4).
2. Final v2 harvest + compound; claim rebase after the flip.
3. For each tranche: `retireTranche` → `rescueERC721(votingEscrow, tokenId, OwnerSafe)` — positions exit the diamond.
4. Migrate each position through the official Aero migration flow (**verify every step against the current Aero migration guidance at the time — not against this document**).
5. Re-stake into fresh tranches: transfer new sTOKENs' AERO into the diamond → `createTranche` per tranche (new NFT ids — F18).
6. Cut `AeroFacet` in via `script/Cut.s.sol` (§5 ceremony), init `initProtocolSwap` with the published v3 addresses (probe them on-chain first).
7. Re-grant strategist, restart keeper, verify a full rotate/harvest cycle on dust before scaling.

Rehearsed structurally by the CI upgrade test (§8.2 of the brief) and live by the canary.

## 5. Cut runbook (diamond governance)

Every `diamondCut` follows one ceremony — **emergency cuts follow the same steps
compressed, never skipped:**

1. PR updating facet source + `contracts/facets.json` (regenerated: `node scripts/manifest.mjs write`) + `contracts/storage-layout.lock.json` if a namespace grew (append-only; CI enforces).
2. CI green — including the diamond upgrade tests, manifest check, storage check.
3. Sepolia rehearsal of the exact cut; loupe diff attached to the PR.
4. Owner Safe signature collection: each signer independently cross-checks the calldata hash against the PR (the `Cut.s.sol` output prints the exact `diamondCut` calldata; hash it with `cast keccak`).
5. Execution via the Safe.
6. Post-cut loupe diff against the updated manifest + smoke test (one view call per facet, one dust `rotate`).
7. Manifest version archived (git tag) + re-verification per §6.

Cut power is the single point of catastrophic failure (§4.4 of the brief); the ceremony,
the Safe threshold, and the `DiamondCut` pager alert are its containment. An
**immutability endgame** exists and is documented deliberately: once final, a cut can
remove `diamondCut` itself, freezing the diamond permanently — a v1+ decision, not a PoC one.

## 6. Contract verification (Sourcify-first, explorer-second)

Diamonds need deliberate verification or the system is an unreadable black box. **No step
may require a paid explorer API key.**

**Primary — Sourcify (free, keyless).** Every facet and the diamond, at deploy time and
after every cut. Compiler settings are pinned in `foundry.toml` (solc 0.8.30, optimizer
200 runs, via-IR off) — verification fails on any mismatch, so freeze profiles per
release tag. Archive constructor args alongside `facets.json`.

```sh
# per contract (diamond + every facet):
forge verify-contract --verifier sourcify --chain-id 8453 <address> <ContractName>
# the diamond has constructor args:
forge verify-contract --verifier sourcify --chain-id 8453 \
  --constructor-args $(cast abi-encode "constructor((address,uint8,bytes4[])[],(address,address,bytes))" ...) \
  <diamond> Diamond
```

Blockscout's Base instance auto-imports Sourcify verifications.

**Basescan display, keyless path:** attempt Sourcify import on Basescan; fall back to
manual standard-JSON upload:

```sh
forge verify-contract --show-standard-json-input <address> <ContractName> > standard.json
# upload standard.json via Basescan's "Verify & Publish" UI (Standard JSON input mode)
```

If a working free key is later obtained, wire it in as convenience — never as a dependency.

**Basescan's proxy UI does not resolve EIP-2535 routing** — Read/Write-as-Proxy will not
show facet functions on the diamond address. Two workarounds for maintainers and signers:

1. **louper.dev** pointed at the diamond on Base — link it in the README and in every Safe transaction description.
2. The **merged-ABI artifact** assembled from `facets.json` (published in the repo as `contracts/out-merged-abi.json` at release), loadable into Basescan's "Custom ABI" feature.

**Release gate:** all facets Sourcify-verified + visible on Blockscout + louper resolves
the diamond + merged ABI published. Basescan source display is best-effort — a checklist
item, not a gate.

## 7. Sunset / emergency

- **Pause semantics:** keeper stop + strategist revoke leave funds safe — allocations persist and keep earning (F4); there is nothing time-critical to babysit in either protocol mode. This is the correct first response to almost any anomaly.
- **Full exit:** per tranche: `retireTranche` → `rescueERC721` to the Owner Safe. v2 permanent locks must be `unlockPermanent`ed (blocked while `voted` — reset first) and then wait out `MAXTIME` decay or sell the veNFT on a secondary marketplace; **locked AERO is not withdrawable before lock expiry** — treat principal as committed (brief §12).
- **Immutability endgame:** remove the `diamondCut` selector via a final cut. Irreversible by construction. Requires: all parameters final, protocol integration stable, and an explicit human decision — v1+, never the PoC.
- **Depositor implications if v1 adds shares:** every runbook above acquires a depositor-communication step and exit-window mechanics; the single-owner assumption (P6: rescue is a feature) stops being true — rescue paths must then be re-audited as attack surface.

## 8. Out of scope for the PoC (documented deliberately)

Share token; deposit/withdraw queue; performance fees; withdraw-to-NFT integration (v3
role-gated — the design must not depend on a role grant, F7); verifiable strategy
commitments (publishing config pre-images so third parties can check targets against a
committed strategy — a v1 extension already enabled by the `strategyRef` hash); Safe
module delegating `setTargets` to a bounded hot key for post-Aero short-cadence operation
(documented v1 option — guardrails already cap any strategist's damage).
