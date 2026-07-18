// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibVaultStorage} from "../../libraries/LibVaultStorage.sol";
import {LibAccess} from "../../libraries/LibAccess.sol";
import {LibDiamond} from "../../libraries/LibDiamond.sol";
import {LibDeterministic} from "../../libraries/LibDeterministic.sol";
import {IProtocolFacet} from "../../interfaces/IProtocolFacet.sol";

/// @title MockAeroFacet
/// @notice TEST-ONLY protocol facet simulating the v3 (Aero) semantics from the spec
///         drafts entirely in-diamond: per-position rolling cooldown (F1/F2), per-second
///         streaming revenue pro-rata by weight (F10), gauge caps with overage burn
///         (F13–F15). Every parameter is test-settable so scenario tests and the upgrade
///         rehearsal can probe the §3 breakage list (e.g. cooldown granularity).
/// @dev Never deployed to mainnet. Conservation invariant: totalStreamed + totalBurned
///      == totalEmitted (asserted by the invariant suite).
contract MockAeroFacet is IProtocolFacet {
    event MockAllocated(uint256 indexed tokenId, address[] pools, uint256[] weights);

    error CooldownNotElapsed(uint256 tokenId, uint64 readyAt);
    error UnknownPosition(uint256 tokenId);
    error UnknownPool(address pool);
    error LengthMismatch();

    function protocolId() external pure returns (bytes32) {
        return keccak256("mock-aero-v3");
    }

    // ------------------------------------------------------------------
    // IProtocolFacet
    // ------------------------------------------------------------------

    /// @inheritdoc IProtocolFacet
    function createStake(uint256 amount, uint256, bool permanent) external returns (uint256 tokenId) {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        tokenId = ++s.nextTokenId;
        LibVaultStorage.MockPosition storage p = s.positions[tokenId];
        p.weight = amount; // permanent stakes: constant weight (F8); decay not modeled here
        p.permanent = permanent;
        p.exists = true;
    }

    /// @inheritdoc IProtocolFacet
    function allocate(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external {
        LibAccess.enforceSelfOrOwner();
        if (pools.length != weights.length) revert LengthMismatch();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        LibVaultStorage.MockPosition storage p = _position(s, tokenId);

        uint64 last = s.perPositionCooldown ? p.lastAllocationAt : s.globalLastAllocationAt;
        uint64 readyAt = last + s.cooldown;
        if (last != 0 && block.timestamp < readyAt) revert CooldownNotElapsed(tokenId, readyAt);

        _settle(s);
        _clearAllocation(s, p);

        uint256 sum;
        for (uint256 i; i < weights.length; ++i) {
            sum += weights[i];
        }
        for (uint256 i; i < pools.length; ++i) {
            LibVaultStorage.MockPool storage pool = s.pools[pools[i]];
            if (!pool.exists) revert UnknownPool(pools[i]);
            // position's weight split pro-rata over its relative weights (floor)
            uint256 w = LibDeterministic.mulDiv(p.weight, weights[i], sum);
            p.pools.push(pools[i]);
            p.allocation[pools[i]] = w;
            pool.totalWeight += w;
        }
        p.lastAllocationAt = uint64(block.timestamp);
        s.globalLastAllocationAt = uint64(block.timestamp);
        emit MockAllocated(tokenId, pools, weights);
    }

    /// @inheritdoc IProtocolFacet
    function resetAllocation(uint256 tokenId) external {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        LibVaultStorage.MockPosition storage p = _position(s, tokenId);
        _settle(s);
        _clearAllocation(s, p);
    }

    /// @inheritdoc IProtocolFacet
    /// @dev streaming accrual is settled lazily; claim just zeroes the earned counter
    ///      (the mock holds no real tokens)
    function claim(uint256 tokenId, bytes calldata) external {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        _position(s, tokenId);
        _settle(s);
        s.earned[tokenId] = 0;
    }

    /// @inheritdoc IProtocolFacet
    function compound(uint256 tokenId, uint256, bytes calldata) external returns (uint256 added) {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        LibVaultStorage.MockPosition storage p = _position(s, tokenId);
        _settle(s);
        added = s.earned[tokenId];
        s.earned[tokenId] = 0;
        p.weight += added;
    }

    /// @inheritdoc IProtocolFacet
    function positionWeight(uint256 tokenId) external view returns (uint256) {
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        return s.positions[tokenId].weight;
    }

    /// @inheritdoc IProtocolFacet
    function cooldownRemaining(uint256 tokenId) external view returns (uint256) {
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        LibVaultStorage.MockPosition storage p = s.positions[tokenId];
        if (!p.exists) revert UnknownPosition(tokenId);
        uint64 last = s.perPositionCooldown ? p.lastAllocationAt : s.globalLastAllocationAt;
        if (last == 0) return 0;
        uint64 readyAt = last + s.cooldown;
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    /// @inheritdoc IProtocolFacet
    function protocolCooldown() external view returns (uint64) {
        return LibVaultStorage.mockAero().cooldown;
    }

    /// @inheritdoc IProtocolFacet
    /// @dev continuous model: always open (F9)
    function allocationWindow() external view returns (uint64 opensAt, uint64 closesAt) {
        return (uint64(block.timestamp), type(uint64).max);
    }

    // ------------------------------------------------------------------
    // test controls (owner-gated; never cut into a production diamond)
    // ------------------------------------------------------------------

    function mockSetCooldown(uint64 cooldown, bool perPosition) external {
        LibDiamond.enforceIsContractOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        s.cooldown = cooldown;
        s.perPositionCooldown = perPosition;
    }

    function mockAddPool(address pool, uint256 revenueRate, uint256 allocatedRate, uint256 capRate) external {
        LibDiamond.enforceIsContractOwner();
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        _settle(s);
        if (!s.pools[pool].exists) s.poolList.push(pool);
        s.pools[pool] =
            LibVaultStorage.MockPool({revenueRate: revenueRate, allocatedRate: allocatedRate, capRate: capRate, totalWeight: s.pools[pool].totalWeight, exists: true});
    }

    function mockEarned(uint256 tokenId) external view returns (uint256) {
        return LibVaultStorage.mockAero().earned[tokenId];
    }

    function mockTotals() external view returns (uint256 emitted, uint256 streamed, uint256 burned) {
        LibVaultStorage.MockAeroStorage storage s = LibVaultStorage.mockAero();
        return (s.totalEmitted, s.totalStreamed, s.totalBurned);
    }

    /// @notice settle streaming to now (also called lazily by every state change)
    function mockSettle() external {
        _settle(LibVaultStorage.mockAero());
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    /// @dev integrate emissions + revenue over [lastSettledAt, now); weights are
    ///      piecewise-constant between allocation events so one segment suffices
    function _settle(LibVaultStorage.MockAeroStorage storage s) private {
        uint64 nowTs = uint64(block.timestamp);
        if (s.lastSettledAt == 0 || s.poolList.length == 0) {
            s.lastSettledAt = nowTs;
            return;
        }
        uint256 dt = nowTs - s.lastSettledAt;
        if (dt == 0) return;

        for (uint256 i; i < s.poolList.length; ++i) {
            LibVaultStorage.MockPool storage pool = s.pools[s.poolList[i]];
            (uint256 emitted, uint256 streamed, uint256 burned) =
                LibDeterministic.capStream(pool.allocatedRate, pool.capRate, dt);
            s.totalEmitted += emitted;
            s.totalStreamed += streamed;
            s.totalBurned += burned;

            // revenue to allocators, pro-rata by position weight in the pool
            if (pool.totalWeight > 0 && pool.revenueRate > 0) {
                uint256 revenue = pool.revenueRate * dt;
                // iterate positions holding this pool — mock-scale bookkeeping
                for (uint256 tid = 1; tid <= s.nextTokenId; ++tid) {
                    uint256 w = s.positions[tid].allocation[s.poolList[i]];
                    if (w > 0) {
                        s.earned[tid] += LibDeterministic.mulDiv(revenue, w, pool.totalWeight);
                    }
                }
            }
        }
        s.lastSettledAt = nowTs;
    }

    function _clearAllocation(LibVaultStorage.MockAeroStorage storage s, LibVaultStorage.MockPosition storage p)
        private
    {
        for (uint256 i; i < p.pools.length; ++i) {
            address pool = p.pools[i];
            s.pools[pool].totalWeight -= p.allocation[pool];
            delete p.allocation[pool];
        }
        delete p.pools;
    }

    function _position(LibVaultStorage.MockAeroStorage storage s, uint256 tokenId)
        private
        view
        returns (LibVaultStorage.MockPosition storage p)
    {
        p = s.positions[tokenId];
        if (!p.exists) revert UnknownPosition(tokenId);
    }
}
