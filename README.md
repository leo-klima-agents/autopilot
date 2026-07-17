# Aero Autopilot PoC

A proof-of-concept autopilot (relay) for the [Aero](https://aero.xyz) economy on Base:

- **A diamond-proxy custody vault** (EIP-2535) holding voting/allocation positions as
  staggered permanent-stake tranches — the custody address is forever; protocol
  transitions (Aerodrome v2 → Aero v3 at launch) are a single `diamondCut`, never a
  custody migration.
- **An off-chain strategy engine** (`packages/core`): deterministic bigint models of both
  the v2 epoch economy and the v3 continuous economy (48h per-position cooldowns, gauge
  caps with overage burn), five strategies from weekly grid to event-driven greedy, a
  backtester reproducing Aero's published on-target-% methodology.
- **A differential-tested TypeScript twin** of the accounting-critical on-chain logic —
  TS generates fixture vectors, Foundry replays them and asserts exact equality (P2).
- **A static simulator site** (`apps/web`) replaying strategies against historical
  Aerodrome data and simulated Aero scenarios, reproducible via URL.

It runs live against Aerodrome v2 on Base today and absorbs Aero's real interfaces as
they publish (code drops from Aug 3, launch September — see `docs/ARCHITECTURE.md` §2 F20).

## Layout

```
contracts/          Foundry project — diamond, facets, tests (unit/diamond/fork/invariant/differential)
packages/core/      TypeScript twin — math, models, strategies, scheduler, backtest, data, fixtures
apps/web/           Vite+React static simulator (GitHub Pages)
apps/keeper/        keeper CLI: watch → compute → submit
data/               versioned JSON datasets built by CI (never secrets)
docs/               ARCHITECTURE.md (fact table + breakage list) · OPERATIONS.md (runbooks)
scripts/            preflight · facets.json manifest check · storage discipline check
```

## Quick start

```sh
pnpm install
pnpm preflight        # BASE_RPC_URL + ALCHEMY_API_KEY present, RPC reachable, chain = Base
pnpm -r build && pnpm -r test
cd contracts && forge test                       # offline suites
forge test --match-path 'test/fork/*'            # fork suite (needs BASE_RPC_URL)
```

Secrets come from the environment only — see `.env.example`. Nothing in `apps/web` ever
sees a key (P7).

## Governance & operations

Two Safes + one hot keeper key (P6): Owner Safe holds `diamondCut` (the root permission),
Strategist Safe submits guardrail-bounded targets, the keeper executes mechanically.
Read `docs/OPERATIONS.md` before touching anything deployed — it contains the deployment,
cut, verification (Sourcify-first), migration, and emergency runbooks.

Diamond introspection: [louper.dev](https://louper.dev) pointed at the diamond on Base
(Basescan's proxy UI cannot resolve EIP-2535 routing), or load the merged ABI from
`contracts/facets.json` into Basescan's Custom ABI feature.

## Status

M0–M2-scale PoC scaffold: see `docs/ARCHITECTURE.md` for every protocol fact this build
depends on (with confidence markers) and the places the design breaks if a fact is wrong.
The `AeroFacet` is a spec-draft shape only — it is rewritten against published Aero code
before any funds move (P8).

## License

MIT — see [LICENSE](LICENSE). Private through audit-contest season, then public.
