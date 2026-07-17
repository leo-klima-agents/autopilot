// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title LibDeterministic
/// @notice The Solidity half of the P2 deterministic core: pro-rata revenue math,
///         cap/burn arithmetic, and the tranche rotation-selection rule. The TypeScript
///         twin in packages/core generates fixture vectors; the differential harness
///         replays them through these functions and asserts EXACT equality.
/// @dev All math is floor-division over non-negative integers, WAD = 1e18 weights.
///      Any change here must be mirrored in packages/core and regenerate fixtures.
library LibDeterministic {
    uint256 internal constant WAD = 1e18;

    error ZeroDenominator();
    error LengthMismatch();

    /// @notice floor(a * b / d), reverting on overflow of the intermediate product
    /// @dev fixture inputs are bounded (< 1e30) so the naive product cannot overflow there;
    ///      production callers keep operands within WAD scale.
    function mulDiv(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        if (d == 0) revert ZeroDenominator();
        return (a * b) / d;
    }

    // ---------------------------------------------------------------------
    // Pro-rata revenue distribution
    // ---------------------------------------------------------------------

    /// @notice split `reward` across `weights` pro-rata with floor rounding
    /// @return payouts per-weight payouts; dust = reward - Σ payouts stays undistributed
    function proRata(uint256 reward, uint256[] memory weights)
        internal
        pure
        returns (uint256[] memory payouts, uint256 dust)
    {
        uint256 total;
        for (uint256 i; i < weights.length; ++i) {
            total += weights[i];
        }
        payouts = new uint256[](weights.length);
        if (total == 0) return (payouts, reward);
        uint256 paid;
        for (uint256 i; i < weights.length; ++i) {
            payouts[i] = mulDiv(reward, weights[i], total);
            paid += payouts[i];
        }
        dust = reward - paid;
    }

    // ---------------------------------------------------------------------
    // Gauge cap / burn arithmetic (v3 model)
    // ---------------------------------------------------------------------

    /// @notice integrate emission streaming over `dt` seconds under a cap
    /// @param allocatedRate emissions allocated to the pool, wei/second
    /// @param capRate cap on the effective rate (κ × trailing revenue), wei/second
    /// @return emitted allocatedRate·dt   (what the minter accounted)
    /// @return streamed min(allocatedRate, capRate)·dt   (what reaches the pool)
    /// @return burned emitted − streamed   (overage, never minted / burned)
    function capStream(uint256 allocatedRate, uint256 capRate, uint256 dt)
        internal
        pure
        returns (uint256 emitted, uint256 streamed, uint256 burned)
    {
        emitted = allocatedRate * dt;
        uint256 eff = allocatedRate < capRate ? allocatedRate : capRate;
        streamed = eff * dt;
        burned = emitted - streamed;
    }

    // ---------------------------------------------------------------------
    // Rotation selection (the scheduler's on-chain twin)
    // ---------------------------------------------------------------------

    /// @notice L1 distance between an allocation and a target over the target's pool set
    /// @dev allocation weights for pools outside `targetWeights`' index space must be
    ///      passed as entries with target 0 — both arrays are indexed identically.
    function l1Distance(uint256[] memory current, uint256[] memory target) internal pure returns (uint256 d) {
        if (current.length != target.length) revert LengthMismatch();
        for (uint256 i; i < current.length; ++i) {
            d += current[i] > target[i] ? current[i] - target[i] : target[i] - current[i];
        }
    }

    /// @notice pick the tranche to rotate next: cooldown elapsed, farthest from target by
    ///         L1 distance, ties broken by lowest index. Mirrors packages/core scheduler.
    /// @param lastActionAt per-tranche last action timestamps
    /// @param distances per-tranche L1 distance to target (precomputed via l1Distance)
    /// @return found false when no tranche is rotatable
    /// @return index index of the selected tranche
    function selectRotation(
        uint64[] memory lastActionAt,
        uint256[] memory distances,
        uint64 nowTs,
        uint64 cooldown
    ) internal pure returns (bool found, uint256 index) {
        if (lastActionAt.length != distances.length) revert LengthMismatch();
        uint256 best;
        for (uint256 i; i < lastActionAt.length; ++i) {
            if (nowTs < lastActionAt[i] + cooldown) continue;
            if (distances[i] == 0) continue;
            if (!found || distances[i] > best) {
                found = true;
                best = distances[i];
                index = i;
            }
        }
    }
}
