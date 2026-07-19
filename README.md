# Aero Autopilot PoC

A proof-of-concept autopilot (relay) for the [Aero](https://aero.xyz) economy on Base:

- **A diamond-proxy custody vault** (EIP-2535) holding voting/allocation positions as
  staggered permanent-stake tranches, the custody address is forever; protocol
  transitions (Aerodrome v2 → Aero v3 at launch) are a single `diamondCut`, never a
  custody migration.
- **An off-chain strategy engine** ([`packages/core`](packages/core)): deterministic
  bigint models of both the v2 epoch economy and the v3 continuous economy (48h
  per-position cooldowns, gauge caps with overage burn), five strategies from weekly grid
  to event-driven greedy, a backtester reproducing Aero's published on-target-%
  methodology.
- **A differential-tested TypeScript twin** of the accounting-critical on-chain logic:
  TS generates fixture vectors, Foundry replays them and asserts exact equality (P2).
- **A static simulator site** ([`apps/web`](apps/web)) replaying strategies against
  historical Aerodrome data and simulated Aero scenarios, reproducible via URL.

It runs live against Aerodrome v2 on Base today and absorbs Aero's real interfaces as
they publish (code drops from Aug 3, launch September, see
[docs/ARCHITECTURE.md §2, F20](docs/ARCHITECTURE.md#2-fact-table-every-v3v2-fact-this-build-depends-on)).

## Layout

| Path | Contents |
| --- | --- |
| [`contracts/`](contracts) | Foundry project, diamond, facets, tests (unit/diamond/fork/invariant/differential) |
| [`packages/core/`](packages/core) | TypeScript twin, math, models, strategies, scheduler, backtest, data, fixtures |
| [`apps/web/`](apps/web) | Vite+React static simulator (GitHub Pages) |
| [`apps/keeper/`](apps/keeper) | keeper CLI: watch → compute → submit |
| [`data/`](data) | versioned JSON datasets built by CI (never secrets) |
| [`docs/`](docs) | architecture, operations, and security-triage documentation (index below) |
| [`scripts/`](scripts) | preflight · facets.json manifest check · storage discipline check |

## Documentation

| Page | What it covers |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The v3 model restated, the [fact table](docs/ARCHITECTURE.md#2-fact-table-every-v3v2-fact-this-build-depends-on) every design choice depends on (with confidence markers), [where the design breaks if a fact is wrong](docs/ARCHITECTURE.md#3-where-the-design-breaks-if-a-fact-is-wrong), the append-only [spec-delta log](docs/ARCHITECTURE.md#4-spec-delta-log-append-only-from-aug-3), and [decisions taken at M0](docs/ARCHITECTURE.md#5-decisions-taken-at-m0) |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Governors & maintainers guide: [roles & keys](docs/OPERATIONS.md#1-roles--keys), [deployment](docs/OPERATIONS.md#2-deployment-runbook) / [cut](docs/OPERATIONS.md#5-cut-runbook-diamond-governance) / [verification](docs/OPERATIONS.md#6-contract-verification-sourcify-first-explorer-second) runbooks, [keeper operations](docs/OPERATIONS.md#3-keeper-operations), [failure modes](docs/OPERATIONS.md#4-failure-modes--gotchas), and the [emergency runbook](docs/OPERATIONS.md#7-sunset--emergency) |
| [docs/BRIEF.md](docs/BRIEF.md) | The initiating build brief, verbatim, design principles, contract/test/web specs, canary policy, the [M0–M5 milestone plan](docs/BRIEF.md#13-milestones) referenced throughout the repo, and the [definition of done](docs/BRIEF.md#14-definition-of-done) |
| [docs/SLITHER-TRIAGE.md](docs/SLITHER-TRIAGE.md) | Static-analysis triage policy and the pinned, accepted findings (vendored diamond + our facets) |

## Quick start

```sh
pnpm install
pnpm preflight        # BASE_RPC_URL + ALCHEMY_API_KEY present, RPC reachable, chain = Base
pnpm -r build && pnpm -r test
cd contracts && forge test                       # offline suites
forge test --match-path 'test/fork/*'            # fork suite (needs BASE_RPC_URL)
```

Secrets come from the environment only, see [`.env.example`](.env.example). Nothing in
[`apps/web`](apps/web) ever sees a key (P7).

## Governance & operations

Two Safes + one hot keeper key (P6): Owner Safe holds `diamondCut` (the root permission),
Strategist Safe submits guardrail-bounded targets, the keeper executes mechanically.
Read [docs/OPERATIONS.md](docs/OPERATIONS.md) before touching anything deployed; it
contains the deployment, cut, verification (Sourcify-first), migration, and emergency
runbooks.

Diamond introspection: [louper.dev](https://louper.dev) pointed at the diamond on Base
(Basescan's proxy UI cannot resolve EIP-2535 routing), or load the merged ABI from
[`contracts/facets.json`](contracts/facets.json) into Basescan's Custom ABI feature.

## Status

Measured against the brief's [M0–M5 milestone plan](docs/BRIEF.md#13-milestones), the
build has delivered the *engineering* deliverables of M0–M3 (scaffold, core, contracts +
test suites, simulator site). Items that require human action remain open and are owned
outside this repo:

- Safes deployment on Base + recorded addresses (M0).
- GitHub Actions secrets + Pages enablement so the data refresh and site deploy run (M3).
- The Aug 3 spec-delta loop, the Sepolia dry run, and the canary go-ahead (M2/M4), the
  canary is funded **only** on explicit human approval.
- Everything in M5 (launch week) by definition.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for every protocol fact this build
depends on (with confidence markers) and
[the places the design breaks](docs/ARCHITECTURE.md#3-where-the-design-breaks-if-a-fact-is-wrong)
if a fact is wrong. The `AeroFacet` is a spec-draft shape only; it is rewritten against
published Aero code before any funds move (P8).

## License

MIT, see [LICENSE](LICENSE). Private through audit-contest season, then public.
