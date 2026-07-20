// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibVaultStorage} from "../libraries/LibVaultStorage.sol";
import {LibAccess} from "../libraries/LibAccess.sol";
import {IDiamondLoupe} from "../interfaces/IDiamondLoupe.sol";
import {IDiamondCut} from "../interfaces/IDiamondCut.sol";
import {IERC173} from "../interfaces/IERC173.sol";
import {IERC165} from "../interfaces/IERC165.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

/// @title DiamondInit
/// @notice The ONLY writer of vault storage during cuts (storage rule 4). Each init is
///         idempotent-guarded: re-executing a consumed init reverts, so a replayed cut
///         calldata cannot clobber state.
contract DiamondInit {
    /// @dev erc7201:aero.autopilot.init, guard namespace, registered here because it is
    ///      only ever touched by inits (LibVaultStorage carries domain state).
    bytes32 internal constant INIT_SLOT = 0x01acbf6192e6faddc83344d5636fda956f6cc7ae94d2374a3d07e5f345e68800;

    struct InitGuard {
        mapping(bytes32 => bool) executed;
    }

    struct InitConfig {
        address strategistSafe;
        address keeper;
        // protocol config (Aerodrome v2 at genesis)
        address voter;
        address votingEscrow;
        address rewardsDistributor;
        address token;
        address router;
        // guardrails
        uint96 maxPoolWeightWad;
        uint96 maxDeltaWad;
        uint64 rotationCooldown;
    }

    error InitAlreadyExecuted(bytes32 initId);

    /// @notice emitted whenever the protocol integration config is (re)written, at genesis
    ///         and on every protocol-swap cut. Monitoring reads this to confirm exactly what
    ///         the vault was repointed to (the generic DiamondCut event carries only opaque
    ///         init calldata). §4.3: events on every state change.
    event ProtocolConfigSet(
        address voter,
        address votingEscrow,
        address rewardsDistributor,
        address token,
        address router,
        address acceptedCollection
    );
    /// @notice emitted once at genesis with the guardrail parameters written by init
    event GuardrailsInitialized(uint96 maxPoolWeightWad, uint96 maxDeltaWad, uint64 rotationCooldown);
    /// @notice emitted by the protocol-swap init so the September/August cut carries a
    ///         queryable, decoded record (page target, OPERATIONS §3)
    event ProtocolSwapExecuted(bytes32 indexed swapId);

    function _guard() private pure returns (InitGuard storage g) {
        bytes32 slot = INIT_SLOT;
        assembly {
            g.slot := slot
        }
    }

    /// @notice genesis init, called once via the deploying diamondCut
    function init(InitConfig calldata cfg) external {
        bytes32 initId = keccak256("aero.autopilot.init.genesis");
        InitGuard storage g = _guard();
        if (g.executed[initId]) revert InitAlreadyExecuted(initId);
        g.executed[initId] = true;

        // ERC-165 interface set
        LibDiamond.DiamondStorage storage ds = LibDiamond.diamondStorage();
        ds.supportedInterfaces[type(IERC165).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondCut).interfaceId] = true;
        ds.supportedInterfaces[type(IDiamondLoupe).interfaceId] = true;
        ds.supportedInterfaces[type(IERC173).interfaceId] = true;
        ds.supportedInterfaces[type(IERC721Receiver).interfaceId] = true;

        // roles (P6): owner is the ERC-173 diamond owner (Owner Safe) implicitly
        LibAccess.grantRole(LibAccess.STRATEGIST_ROLE, cfg.strategistSafe);
        LibAccess.grantRole(LibAccess.KEEPER_ROLE, cfg.keeper);

        // protocol config, addresses are supplied by the deploy script, which verifies
        // them on-chain first (Non-negotiable #2); custody accepts only the escrow
        LibVaultStorage.ProtocolConfigStorage storage pc = LibVaultStorage.protocolConfig();
        pc.voter = cfg.voter;
        pc.votingEscrow = cfg.votingEscrow;
        pc.rewardsDistributor = cfg.rewardsDistributor;
        pc.token = cfg.token;
        pc.router = cfg.router;
        LibVaultStorage.custody().acceptedCollection = cfg.votingEscrow;
        emit ProtocolConfigSet(
            cfg.voter, cfg.votingEscrow, cfg.rewardsDistributor, cfg.token, cfg.router, cfg.votingEscrow
        );

        // guardrails
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        ts.maxPoolWeightWad = cfg.maxPoolWeightWad;
        ts.maxDeltaWad = cfg.maxDeltaWad;
        ts.rotationCooldown = cfg.rotationCooldown;
        emit GuardrailsInitialized(cfg.maxPoolWeightWad, cfg.maxDeltaWad, cfg.rotationCooldown);
    }

    /// @notice protocol-swap init, used by the August/September facet cuts to repoint
    ///         protocol config and custody at the new protocol's contracts
    function initProtocolSwap(
        bytes32 swapId,
        address voter,
        address votingEscrow,
        address rewardsDistributor,
        address token,
        address router
    ) external {
        InitGuard storage g = _guard();
        if (g.executed[swapId]) revert InitAlreadyExecuted(swapId);
        g.executed[swapId] = true;

        LibVaultStorage.ProtocolConfigStorage storage pc = LibVaultStorage.protocolConfig();
        pc.voter = voter;
        pc.votingEscrow = votingEscrow;
        pc.rewardsDistributor = rewardsDistributor;
        pc.token = token;
        pc.router = router;
        LibVaultStorage.custody().acceptedCollection = votingEscrow;
        emit ProtocolConfigSet(voter, votingEscrow, rewardsDistributor, token, router, votingEscrow);
        emit ProtocolSwapExecuted(swapId);
    }
}
