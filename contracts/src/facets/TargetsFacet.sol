// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibVaultStorage} from "../libraries/LibVaultStorage.sol";
import {LibAccess} from "../libraries/LibAccess.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {LibDeterministic} from "../libraries/LibDeterministic.sol";

/// @title TargetsFacet
/// @notice setTargets stores the strategist's allocation as a QUEUED INTENT after
///         guardrail validation (P1: decisions are computed off-chain; validated, bounded
///         and executed on-chain). One strategist signature drives many keeper executions,
///         so multisig latency costs signal freshness, never liveness.
contract TargetsFacet {
    event TargetsSet(address[] pools, uint256[] weightsWad, bytes32 indexed strategyRef, address indexed strategist);
    event GuardrailsSet(uint96 maxPoolWeightWad, uint96 maxDeltaWad, uint64 rotationCooldown, address organicFlowOracle);
    event PoolAllowed(address indexed pool, bool allowed);

    error LengthMismatch();
    error EmptyTarget();
    error PoolNotAllowed(address pool);
    error WeightAboveMax(address pool, uint256 weightWad);
    error WeightsMustSumToWad(uint256 sum);
    error DeltaAboveMax(uint256 deltaWad, uint256 maxDeltaWad);
    error DuplicatePool(address pool);

    /// @notice strategist-only: queue a new target allocation
    /// @param ref opaque strategy attribution tag (keccak of the TS strategy config):
    ///        emitted, never validated. Attribution, not enforcement.
    function setTargets(address[] calldata pools, uint256[] calldata weightsWad, bytes32 ref) external {
        LibAccess.enforceRole(LibAccess.STRATEGIST_ROLE, msg.sender);
        if (pools.length != weightsWad.length) revert LengthMismatch();
        if (pools.length == 0) revert EmptyTarget();

        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();

        uint256 sum;
        for (uint256 i; i < pools.length; ++i) {
            address pool = pools[i];
            if (!ts.poolAllowed[pool]) revert PoolNotAllowed(pool);
            if (weightsWad[i] > ts.maxPoolWeightWad) revert WeightAboveMax(pool, weightsWad[i]);
            // duplicate pools would double-count in delta math and protocol votes
            for (uint256 j; j < i; ++j) {
                if (pools[j] == pool) revert DuplicatePool(pool);
            }
            sum += weightsWad[i];
        }
        if (sum != LibDeterministic.WAD) revert WeightsMustSumToWad(sum);

        // max-reallocation-delta guardrail: L1 distance old→new over the union of pools.
        // Skipped for the genesis target: with no stored target the L1 distance from
        // "nothing" to any valid (WAD-summing) target is exactly WAD, which would make the
        // first setTargets revert under any maxDeltaWad < WAD (e.g. the 0.6e18 deploy
        // default), bricking a fresh diamond until the Owner loosened the guardrail.
        if (ts.targetPools.length != 0) {
            uint256 delta = _l1AgainstStored(ts, pools, weightsWad);
            if (delta > ts.maxDeltaWad) revert DeltaAboveMax(delta, ts.maxDeltaWad);
        }

        // replace stored target
        for (uint256 i; i < ts.targetPools.length; ++i) {
            delete ts.targetWeight[ts.targetPools[i]];
        }
        delete ts.targetPools;
        for (uint256 i; i < pools.length; ++i) {
            ts.targetPools.push(pools[i]);
            ts.targetWeight[pools[i]] = weightsWad[i];
        }
        ts.strategyRef = ref;
        ts.submittedAt = uint64(block.timestamp);
        emit TargetsSet(pools, weightsWad, ref, msg.sender);
    }

    function targets() external view returns (address[] memory pools, uint256[] memory weightsWad) {
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        pools = ts.targetPools;
        weightsWad = new uint256[](pools.length);
        for (uint256 i; i < pools.length; ++i) {
            weightsWad[i] = ts.targetWeight[pools[i]];
        }
    }

    function strategyRef() external view returns (bytes32 ref, uint64 submittedAt) {
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        return (ts.strategyRef, ts.submittedAt);
    }

    // ------------------------------------------------------------------
    // guardrail administration (Owner Safe)
    // ------------------------------------------------------------------

    function setGuardrails(uint96 maxPoolWeightWad, uint96 maxDeltaWad, uint64 rotationCooldown, address organicFlowOracle)
        external
    {
        LibDiamond.enforceIsContractOwner();
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        ts.maxPoolWeightWad = maxPoolWeightWad;
        ts.maxDeltaWad = maxDeltaWad;
        ts.rotationCooldown = rotationCooldown;
        ts.organicFlowOracle = organicFlowOracle;
        emit GuardrailsSet(maxPoolWeightWad, maxDeltaWad, rotationCooldown, organicFlowOracle);
    }

    function setPoolAllowed(address pool, bool allowed) external {
        LibDiamond.enforceIsContractOwner();
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        if (allowed && !ts.poolAllowed[pool]) {
            ts.allowlist.push(pool);
        } else if (!allowed && ts.poolAllowed[pool]) {
            uint256 len = ts.allowlist.length;
            for (uint256 i; i < len; ++i) {
                if (ts.allowlist[i] == pool) {
                    ts.allowlist[i] = ts.allowlist[len - 1];
                    ts.allowlist.pop();
                    break;
                }
            }
        }
        ts.poolAllowed[pool] = allowed;
        emit PoolAllowed(pool, allowed);
    }

    function guardrails()
        external
        view
        returns (uint96 maxPoolWeightWad, uint96 maxDeltaWad, uint64 rotationCooldown, address organicFlowOracle)
    {
        LibVaultStorage.TargetsStorage storage ts = LibVaultStorage.targets();
        return (ts.maxPoolWeightWad, ts.maxDeltaWad, ts.rotationCooldown, ts.organicFlowOracle);
    }

    function allowlist() external view returns (address[] memory) {
        return LibVaultStorage.targets().allowlist;
    }

    /// @dev L1 distance between the stored target and a proposed one over their pool union
    function _l1AgainstStored(
        LibVaultStorage.TargetsStorage storage ts,
        address[] calldata pools,
        uint256[] calldata weightsWad
    ) private view returns (uint256 delta) {
        // pools present in the new target
        for (uint256 i; i < pools.length; ++i) {
            uint256 oldW = ts.targetWeight[pools[i]];
            uint256 newW = weightsWad[i];
            delta += newW > oldW ? newW - oldW : oldW - newW;
        }
        // pools only in the old target (weight goes to zero)
        for (uint256 i; i < ts.targetPools.length; ++i) {
            address pool = ts.targetPools[i];
            bool inNew;
            for (uint256 j; j < pools.length; ++j) {
                if (pools[j] == pool) {
                    inNew = true;
                    break;
                }
            }
            if (!inNew) delta += ts.targetWeight[pool];
        }
    }
}
