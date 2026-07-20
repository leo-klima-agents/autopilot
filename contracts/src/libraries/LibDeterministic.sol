// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title LibDeterministic
/// @notice The Solidity half of the P2 deterministic core: pro-rata revenue math,
///         cap/burn arithmetic, and the tranche rotation-selection rule. The TypeScript
///         twin in packages/core generates fixture vectors; the differential harness
///         replays them through these functions and asserts EXACT equality.
/// @dev All math is floor-division over non-negative integers, WAD = 1e18 weights.
///      Any change here must be mirrored in packages/core and regenerate fixtures.
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

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

    /// @notice cap rate from trailing revenue: capRate = κ × (trailingRevenue / windowSec)
    ///        , mirrors packages/core capBurnExpected exactly (floor at each step)
    function capFromRevenue(uint256 trailingRevenue, uint256 windowSec, uint256 kappaWad)
        internal
        pure
        returns (uint256)
    {
        if (windowSec == 0) revert ZeroDenominator();
        return mulDiv(kappaWad, trailingRevenue / windowSec, WAD);
    }

    // ---------------------------------------------------------------------
    // Water-filling allocator (mirror of packages/core strategies/waterFilling.ts)
    // ---------------------------------------------------------------------

    /// @notice bits needed to represent n (bitLength(0) == 0), mirrors TS bitLength
    function bitLength(uint256 n) internal pure returns (uint256 bits) {
        while (n > 0) {
            n >>= 1;
            ++bits;
        }
    }

    /// @notice floor integer square root, the exact Newton iteration of the TS twin:
    ///         x₀ = 2^(ceil(bitLength(n)/2)), xₖ₊₁ = (xₖ + n/xₖ) >> 1, stop when y >= x
    function isqrt(uint256 n) internal pure returns (uint256) {
        if (n < 2) return n;
        uint256 x = uint256(1) << ((bitLength(n) + 1) / 2);
        for (;;) {
            uint256 y = (x + n / x) >> 1;
            if (y >= x) return x;
            x = y;
        }
    }

    /// @dev w_i(λ) = max(0, isqrt(R_i·W_i·scale/λ) − W_i). 512-bit intermediate via OZ
    ///      Math.mulDiv; evaluated λ values keep the result within uint256 for inputs
    ///      bounded by the fixture domain (R, W, budget ≤ 1e30).
    function _weightAtLambda(uint256 r, uint256 w, uint256 lambda, uint256 scale) private pure returns (uint256) {
        uint256 product = r * w;
        if (product == 0) return 0;
        uint256 root = isqrt(Math.mulDiv(product, scale, lambda));
        return root > w ? root - w : 0;
    }

    /// @notice Exact water-filling: max Σ wᵢRᵢ/(Wᵢ+wᵢ) s.t. Σwᵢ = budget. Bisection for
    ///         the smallest integer λ with Σ wᵢ(λ) ≤ budget; leftover assigned to the
    ///         largest-R pool (ties: lowest index). Bit-exact mirror of the TS twin.
    function waterFill(uint256[] memory r, uint256[] memory w, uint256 budget, uint256 scale)
        internal
        pure
        returns (uint256[] memory weights, uint256 lambda, uint256 iterations)
    {
        if (r.length != w.length) revert LengthMismatch();
        uint256 n = r.length;
        weights = new uint256[](n);
        if (n == 0 || budget == 0) return (weights, 0, 0);

        // λ_hi: smallest λ zeroing every pool
        uint256 hi = 1;
        for (uint256 i; i < n; ++i) {
            if (r[i] > 0 && w[i] > 0) {
                uint256 cand = (r[i] * scale) / w[i] + 1;
                if (cand > hi) hi = cand;
            }
        }
        iterations = bitLength(hi);

        uint256 lo = 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) >> 1;
            uint256 sum;
            for (uint256 i; i < n; ++i) {
                sum += _weightAtLambda(r[i], w[i], mid, scale);
            }
            if (sum <= budget) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        lambda = hi;

        uint256 total;
        for (uint256 i; i < n; ++i) {
            weights[i] = _weightAtLambda(r[i], w[i], lambda, scale);
            total += weights[i];
        }
        if (budget > total) {
            uint256 best;
            for (uint256 i = 1; i < n; ++i) {
                if (r[i] > r[best]) best = i;
            }
            weights[best] += budget - total;
        }
    }

    // ---------------------------------------------------------------------
    // Rotation selection (the scheduler's on-chain twin)
    // ---------------------------------------------------------------------

    /// @notice L1 distance between an allocation and a target over the target's pool set
    /// @dev allocation weights for pools outside `targetWeights`' index space must be
    ///      passed as entries with target 0, both arrays are indexed identically.
    function l1Distance(uint256[] memory current, uint256[] memory target) internal pure returns (uint256 d) {
        if (current.length != target.length) revert LengthMismatch();
        for (uint256 i; i < current.length; ++i) {
            d += current[i] > target[i] ? current[i] - target[i] : target[i] - current[i];
        }
    }

    /// @notice pick the tranche to rotate next: cooldown elapsed, farthest from target by
    ///         L1 distance, ties broken by lowest index. Mirrors packages/core scheduler,
    ///         whose tie-break is ascending (lexicographic) tranche id: callers MUST pass
    ///         `lastActionAt`/`distances` ordered by that same id order so "lowest index"
    ///         here equals "lowest id" there. The differential harness enforces this and
    ///         asserts exact parity (including two-digit ids where lexicographic != numeric).
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
