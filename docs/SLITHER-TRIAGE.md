# Slither triage

Policy (§4.3): triage the vendored diamond's delegatecall findings once, document, pin.
The CI slither job is advisory (`continue-on-error`) with vendored paths filtered
(`lib/`, `src/Diamond.sol`, `src/libraries/LibDiamond.sol`, cut/loupe facets); anything
NEW on our own facets must be triaged here before merge.

## Accepted findings (vendored EIP-2535 reference, mudgen/diamond-1-hardhat @ MIT)

| Finding | Where | Verdict |
|---|---|---|
| `controlled-delegatecall` / `delegatecall-loop` | `Diamond.sol` fallback, `LibDiamond.initializeDiamondCut` | **By design.** Delegatecall routing is the diamond pattern itself; targets are facets installed exclusively via owner-gated `diamondCut` (asserted by the diamond suite) |
| `assembly` usage | `Diamond.sol`, `LibDiamond.sol`, `LibVaultStorage` accessors | **By design.** P5 permits assembly only in vendored diamond internals; our own assembly is limited to the ERC-7201 `s.slot :=` accessor idiom, slot constants CI-verified against the formula (scripts/storage-check.mjs) |

## Accepted findings (our facets)

| Finding | Where | Verdict |
|---|---|---|
| `timestamp` comparisons | cooldown math in TrancheFacet / ExecutionFacet / MockAeroFacet / AerodromeFacet | **Accepted.** Cooldowns are hours-to-days; sub-15s validator drift is immaterial |
| `calls-loop` | `MockAeroFacet._settle` position loop | **Test-only facet**, never in the production manifest (`deployed: false`) |
| reentrancy-events on external protocol calls | AerodromeFacet | External calls go only to the probed protocol contracts configured by DiamondInit; keeper-gated entrypoints; revisit if a public-caller bounty path is ever added (v1) |

Anything not listed here that slither reports on `src/facets/*.sol`, `src/libraries/Lib{Access,VaultStorage,Deterministic}.sol` or `src/init/DiamondInit.sol` is unreviewed — do not merge without adding a row.
