# Milestones

The milestone identifiers (M0…M5) referenced across this repository come from the
project's initiating document, the **Aero Autopilot PoC — Build Brief** (2026-07-17).
This page restates the brief's §13 (milestones) and §14 (definition of done) so those
references resolve somewhere inside the repo.

## Plan (brief §13)

| Phase | Dates (2026) | Deliverables & acceptance criteria |
|---|---|---|
| **M0 Scaffold** | Jul 20–24 | Tier-1 + Tier-2 reading done and [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) committed; **env preflight passes** (`pnpm preflight`: `BASE_RPC_URL`/`ALCHEMY_API_KEY` present, RPC reachable, chain id = Base); monorepo builds; MIT LICENSE committed; both Safes deployed on Base, addresses recorded; diamond scaffold (vendored cut/loupe + `LibVaultStorage` + manifest CI check) compiling with the diamond suite green on empty facets; `sugar`-vs-custom-indexer decision made and recorded; indexer pulls 12mo of top-30 Aerodrome pools into [`data/`](../data) with human-readable pool names resolved via Alchemy token metadata. |
| **M1 Core & sim** | Jul 27–Aug 7 | [`core`](../packages/core) complete: both models, five strategies, backtester reproducing the published on-target-% methodology within tolerance; vitest + property tests green; fixture vectors emitted. |
| **M2 Contracts** | Aug 3–14 | All facets + both protocol facets; unit/diamond/invariant/differential suites green; fork suite green at pinned block including the mid-lifecycle facet swap. **From Aug 3: pull each Aero code drop, diff against [`docs/ARCHITECTURE.md`](ARCHITECTURE.md), log every spec delta, draft `AeroFacet`.** |
| **M3 Web** | Aug 10–21 | Site live on Pages from Actions; interactive backtests on historical + synthetic data; URL-reproducible runs; secret-scan enforced. |
| **M4 Ops & v3 readiness** | Aug 24–Sep 11 | [OPERATIONS.md](OPERATIONS.md) complete incl. migration, cut, and verification runbooks; Sepolia dry run incl. a rehearsed cut; canary gate check → funded only on human go-ahead; `AeroFacet` updated against published code; audit-contest findings tracked for spec changes. |
| **M5 Launch week** | Sep (post-contest) | Final `AeroFacet` vs deployed addresses; fork tests vs real Aero; canary migrated through the real flow with the production cut executed per runbook; all facets re-verified; repo flipped public (MIT); go/no-go checklist executed. |

Estimated effort: ~6.5 weeks for one experienced protocol/full-stack engineer. Critical
path: M1→M2 differential testing plus the diamond upgrade suite — not the UI.

## Definition of done (brief §14)

- `pnpm test` and `forge test` green; fork suite green at the pinned block; coverage gate met.
- Every claim in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md) carries a source link and a
  confidence marker; every spec delta since Aug 3 is logged.
- [OPERATIONS.md](OPERATIONS.md) sufficient for someone who never spoke to the authors to
  deploy, operate, cut, verify, and migrate the system.
- The site reproduces the published cbBTC early-allocator story as a preset scenario.
- No secret in git history, in [`data/`](../data), or in the site bundle — CI proves it.

## Current status

The PoC build delivered the *engineering* deliverables of M0–M3 ahead of the calendar
(scaffold, core, contracts + test suites, simulator site) — see the repository
[README](../README.md#status). Items that require human action remain open and are owned
outside this repo:

- Safes deployment on Base + recorded addresses (M0).
- GitHub Actions secrets + Pages enablement so the data refresh and site deploy run (M3).
- The Aug 3 spec-delta loop, the Sepolia dry run, and the canary go-ahead (M2/M4) —
  the canary is funded **only** on explicit human approval.
- Everything in M5 (launch week) by definition.
