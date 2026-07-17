// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibVaultStorage} from "../libraries/LibVaultStorage.sol";
import {LibAccess} from "../libraries/LibAccess.sol";
import {IProtocolFacet} from "../interfaces/IProtocolFacet.sol";

/// @title ExecutionFacet
/// @notice Keeper-gated, mechanical execution: converge tranches toward the stored target
///         as cooldowns unlock. The keeper has no discretion — it can only push tranches
///         toward the strategist's queued intent (P1/P6). Keeper compromise costs
///         liveness only.
contract ExecutionFacet {
    event Rotated(uint256 indexed trancheId, uint256 indexed positionTokenId, bytes32 strategyRef);
    event Harvested(uint256 indexed trancheId, uint256 indexed positionTokenId);
    event Compounded(uint256 indexed trancheId, uint256 indexed positionTokenId, uint256 added);

    error UnknownTranche(uint256 trancheId);
    error CooldownActive(uint256 trancheId, uint64 readyAt);
    error NoTargetSet();

    modifier onlyKeeper() {
        LibAccess.enforceRole(LibAccess.KEEPER_ROLE, msg.sender);
        _;
    }

    /// @notice re-allocate a tranche's position toward the stored target
    function rotate(uint256 trancheId) external onlyKeeper {
        LibVaultStorage.Tranche storage t = _tranche(trancheId);
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        if (ts.targetPools.length == 0) revert NoTargetSet();

        // lastActionAt == 0 ⇒ never allocated, immediately rotatable
        uint64 readyAt = t.lastActionAt + ts.rotationCooldown;
        if (t.lastActionAt != 0 && block.timestamp < readyAt) revert CooldownActive(trancheId, readyAt);

        uint256 n = ts.targetPools.length;
        address[] memory pools = new address[](n);
        uint256[] memory weights = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            pools[i] = ts.targetPools[i];
            weights[i] = ts.targetWeight[pools[i]];
        }

        IProtocolFacet(address(this)).allocate(t.positionTokenId, pools, weights);
        t.lastActionAt = uint64(block.timestamp);
        emit Rotated(trancheId, t.positionTokenId, ts.strategyRef);
    }

    /// @notice claim fees/bribes/rebase for a tranche; `claimData` is composed off-chain
    ///         by the keeper and validated by the protocol facet (P1)
    function harvest(uint256 trancheId, bytes calldata claimData) external onlyKeeper {
        LibVaultStorage.Tranche storage t = _tranche(trancheId);
        IProtocolFacet(address(this)).claim(t.positionTokenId, claimData);
        emit Harvested(trancheId, t.positionTokenId);
    }

    /// @notice swap claimed rewards to the protocol token and increase the stake
    ///         (mirrors the MetaRouter CLAIM_REWARDS → SWAP → ADD_LIQUIDITY → STAKE flow)
    function compoundTranche(uint256 trancheId, uint256 minAmountOut, bytes calldata swapData)
        external
        onlyKeeper
        returns (uint256 added)
    {
        LibVaultStorage.Tranche storage t = _tranche(trancheId);
        added = IProtocolFacet(address(this)).compound(t.positionTokenId, minAmountOut, swapData);
        emit Compounded(trancheId, t.positionTokenId, added);
    }

    /// @notice seconds until a tranche may rotate under the VAULT guardrail cooldown
    ///         (the protocol may impose its own on top — see IProtocolFacet.cooldownRemaining)
    function vaultCooldownRemaining(uint256 trancheId) external view returns (uint256) {
        LibVaultStorage.Tranche storage t = _tranche(trancheId);
        if (t.lastActionAt == 0) return 0;
        uint64 readyAt = t.lastActionAt + LibVaultStorage.targets().rotationCooldown;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    function _tranche(uint256 trancheId) private view returns (LibVaultStorage.Tranche storage t) {
        t = LibVaultStorage.tranches().tranches[trancheId];
        if (!t.exists) revert UnknownTranche(trancheId);
    }
}
