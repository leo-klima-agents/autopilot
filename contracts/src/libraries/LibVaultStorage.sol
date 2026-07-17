// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title LibVaultStorage
/// @notice ERC-7201 namespaced storage for every vault domain. This file is the single
///         registry of namespace strings (storage rule 3): CI fails on duplicates or on a
///         struct whose layout hash changes without an append.
/// @dev Storage rules (ARCHITECTURE brief §4.2), enforced in CI where possible:
///      1. Structs are append-only: never reorder, retype, or delete fields — deprecate by
///         renaming to `__deprecated_*`.
///      2. No facet declares contract-level state variables.
///      3. Every namespace string is registered here, and only here.
///      4. DiamondInit is the only writer during cuts.
library LibVaultStorage {
    // ---------------------------------------------------------------------
    // Namespace registry — one constant per domain, ERC-7201 formula:
    // keccak256(abi.encode(uint256(keccak256(id)) - 1)) & ~bytes32(uint256(0xff))
    // ---------------------------------------------------------------------

    /// @dev erc7201:aero.autopilot.access
    bytes32 internal constant ACCESS_SLOT = 0x0f51361fed6ecbdbb5d50fb9075833529521647bb1eb1c33aa79c6fa5d593200;
    /// @dev erc7201:aero.autopilot.custody
    bytes32 internal constant CUSTODY_SLOT = 0x513346aaf54c34028cb44341b043b96cab011b65f6e97a93523da5f2758d4900;
    /// @dev erc7201:aero.autopilot.tranches
    bytes32 internal constant TRANCHES_SLOT = 0x7da935f08dbc10fbb1bffedd43b75f21fa58998ab1af1c9b2c8a5be1ad2ebf00;
    /// @dev erc7201:aero.autopilot.targets
    bytes32 internal constant TARGETS_SLOT = 0x18280182a73564c90b216cfd0b5cd975aebdadc2230c92b0a3426cdd39270900;
    /// @dev erc7201:aero.autopilot.protocol.config
    bytes32 internal constant PROTOCOL_CONFIG_SLOT = 0x3521dceec571d1a0be9d6b77a96d662f768dc7a73c50a5c5e937b1d301074300;
    /// @dev erc7201:aero.autopilot.protocol.mockaero — MockAeroFacet simulation state (test-only facet)
    bytes32 internal constant MOCK_AERO_SLOT = 0x934c398e14ff90ae8a85361b18f9c11713cfa169ba591f5195cda98202054d00;

    // ---------------------------------------------------------------------
    // aero.autopilot.access
    // ---------------------------------------------------------------------

    struct AccessStorage {
        /// @dev role => account => granted
        mapping(bytes32 => mapping(address => bool)) hasRole;
    }

    // ---------------------------------------------------------------------
    // aero.autopilot.custody
    // ---------------------------------------------------------------------

    struct CustodyStorage {
        /// @dev the only ERC-721 collection accepted by onERC721Received (the escrow)
        address acceptedCollection;
    }

    // ---------------------------------------------------------------------
    // aero.autopilot.tranches
    // ---------------------------------------------------------------------

    struct Tranche {
        /// @dev position NFT id held by the diamond (0 is invalid — v2/v3 ids start at 1)
        uint256 positionTokenId;
        /// @dev last rotate/creation timestamp, drives vault-level cooldown accounting
        uint64 lastActionAt;
        bool exists;
    }

    struct TrancheStorage {
        uint256 nextTrancheId;
        mapping(uint256 => Tranche) tranches;
        /// @dev enumeration aid for keeper/monitoring; ids are never reused
        uint256[] trancheIds;
    }

    // ---------------------------------------------------------------------
    // aero.autopilot.targets
    // ---------------------------------------------------------------------

    struct TargetsStorage {
        /// @dev queued intent: pools and WAD weights summing to 1e18
        address[] targetPools;
        mapping(address => uint256) targetWeight;
        /// @dev opaque attribution tag (keccak of the TS strategy config); never validated (P1)
        bytes32 strategyRef;
        uint64 submittedAt;
        // -- guardrails (Owner-set) --
        mapping(address => bool) poolAllowed;
        address[] allowlist;
        /// @dev max WAD weight a single pool may receive
        uint96 maxPoolWeightWad;
        /// @dev max L1 reallocation distance (WAD) between consecutive targets
        uint96 maxDeltaWad;
        /// @dev per-tranche rotation cooldown in seconds (7d for the v2 grid; 48h/24h/1h for v3 modes)
        uint64 rotationCooldown;
        /// @dev optional min-organic-flow oracle hook; zero = disabled (stubbed for PoC)
        address organicFlowOracle;
    }

    // ---------------------------------------------------------------------
    // aero.autopilot.protocol.config
    // ---------------------------------------------------------------------

    struct ProtocolConfigStorage {
        /// @dev Aerodrome v2 today; Aero v3 after the September cut
        address voter;
        address votingEscrow;
        address rewardsDistributor;
        /// @dev the emissions/lock token (AERO)
        address token;
        address router;
    }

    // ---------------------------------------------------------------------
    // aero.autopilot.protocol.mockaero — self-contained v3 simulation (test-only)
    // ---------------------------------------------------------------------

    struct MockPosition {
        uint256 weight;
        uint64 lastAllocationAt;
        bool permanent;
        bool exists;
        address[] pools;
        mapping(address => uint256) allocation; // WAD share of this position's weight
    }

    struct MockPool {
        /// @dev revenue streamed to allocators, token-wei per second
        uint256 revenueRate;
        /// @dev emissions allocated to this pool, token-wei per second
        uint256 allocatedRate;
        /// @dev cap on effective emission rate (κ × trailing revenue, test-settable)
        uint256 capRate;
        uint256 totalWeight;
        bool exists;
    }

    struct MockAeroStorage {
        uint256 nextTokenId;
        uint64 cooldown;
        /// @dev true = per-position cooldown (F2); false = global (breakage probe, §3.1)
        bool perPositionCooldown;
        uint64 globalLastAllocationAt;
        uint64 lastSettledAt;
        uint256 totalEmitted;
        uint256 totalStreamed;
        uint256 totalBurned;
        address[] poolList;
        mapping(address => MockPool) pools;
        mapping(uint256 => MockPosition) positions;
        /// @dev earned[tokenId] — claimable streamed revenue
        mapping(uint256 => uint256) earned;
    }

    // ---------------------------------------------------------------------
    // accessors
    // ---------------------------------------------------------------------

    function access() internal pure returns (AccessStorage storage s) {
        bytes32 slot = ACCESS_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function custody() internal pure returns (CustodyStorage storage s) {
        bytes32 slot = CUSTODY_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function tranches() internal pure returns (TrancheStorage storage s) {
        bytes32 slot = TRANCHES_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function targets() internal pure returns (TargetsStorage storage s) {
        bytes32 slot = TARGETS_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function protocolConfig() internal pure returns (ProtocolConfigStorage storage s) {
        bytes32 slot = PROTOCOL_CONFIG_SLOT;
        assembly {
            s.slot := slot
        }
    }

    function mockAero() internal pure returns (MockAeroStorage storage s) {
        bytes32 slot = MOCK_AERO_SLOT;
        assembly {
            s.slot := slot
        }
    }
}
