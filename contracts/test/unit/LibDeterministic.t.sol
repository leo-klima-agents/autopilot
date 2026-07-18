// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibDeterministic} from "../../src/libraries/LibDeterministic.sol";

/// @dev external wrapper so expectRevert works and fuzzed calls cross a call boundary
contract DetHarness {
    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) {
        return LibDeterministic.mulDiv(a, b, d);
    }

    function proRata(uint256 reward, uint256[] memory weights)
        external
        pure
        returns (uint256[] memory payouts, uint256 dust)
    {
        return LibDeterministic.proRata(reward, weights);
    }

    function capStream(uint256 allocatedRate, uint256 capRate, uint256 dt)
        external
        pure
        returns (uint256 emitted, uint256 streamed, uint256 burned)
    {
        return LibDeterministic.capStream(allocatedRate, capRate, dt);
    }

    function l1Distance(uint256[] memory current, uint256[] memory target) external pure returns (uint256) {
        return LibDeterministic.l1Distance(current, target);
    }

    function selectRotation(uint64[] memory lastActionAt, uint256[] memory distances, uint64 nowTs, uint64 cooldown)
        external
        pure
        returns (bool found, uint256 index)
    {
        return LibDeterministic.selectRotation(lastActionAt, distances, nowTs, cooldown);
    }
}

/// @notice Direct tests of the deterministic core: pro-rata floor math, cap/burn
///         arithmetic, L1 distance, and the rotation-selection rule, plus conservation
///         fuzz properties.
contract LibDeterministicTest is Test {
    DetHarness internal h;

    function setUp() public {
        h = new DetHarness();
    }

    // ------------------------------------------------------------------
    // mulDiv
    // ------------------------------------------------------------------

    function test_mulDiv_floorsAndRevertsOnZeroDenominator() public {
        assertEq(h.mulDiv(10, 3, 4), 7, "floor(30/4)");
        vm.expectRevert(LibDeterministic.ZeroDenominator.selector);
        h.mulDiv(1, 1, 0);
    }

    // ------------------------------------------------------------------
    // proRata
    // ------------------------------------------------------------------

    function test_proRata_exactSplitNoDust() public view {
        uint256[] memory weights = new uint256[](2);
        weights[0] = 1;
        weights[1] = 3;
        (uint256[] memory payouts, uint256 dust) = h.proRata(100, weights);
        assertEq(payouts[0], 25);
        assertEq(payouts[1], 75);
        assertEq(dust, 0);
    }

    function test_proRata_indivisibleRewardLeavesDust() public view {
        uint256[] memory weights = new uint256[](3);
        weights[0] = 1;
        weights[1] = 1;
        weights[2] = 1;
        (uint256[] memory payouts, uint256 dust) = h.proRata(10, weights);
        assertEq(payouts[0], 3);
        assertEq(payouts[1], 3);
        assertEq(payouts[2], 3);
        assertEq(dust, 1, "10 = 3+3+3 + 1 dust");
    }

    function test_proRata_zeroTotalWeightAllDust() public view {
        uint256[] memory weights = new uint256[](2); // all zero
        (uint256[] memory payouts, uint256 dust) = h.proRata(1e18, weights);
        assertEq(payouts[0], 0);
        assertEq(payouts[1], 0);
        assertEq(dust, 1e18, "no weight: whole reward is dust");
    }

    function test_proRata_emptyWeights() public view {
        (uint256[] memory payouts, uint256 dust) = h.proRata(7, new uint256[](0));
        assertEq(payouts.length, 0);
        assertEq(dust, 7);
    }

    function testFuzz_proRata_neverOverDistributes(uint256 reward, uint256[] memory weights) public view {
        reward = bound(reward, 0, 1e30);
        vm.assume(weights.length <= 64);
        for (uint256 i; i < weights.length; ++i) {
            weights[i] = bound(weights[i], 0, 1e30);
        }
        (uint256[] memory payouts, uint256 dust) = h.proRata(reward, weights);
        uint256 sum;
        for (uint256 i; i < payouts.length; ++i) {
            assertLe(payouts[i], reward, "single payout bounded by reward");
            sum += payouts[i];
        }
        assertEq(sum + dust, reward, "conservation: payouts + dust == reward");
    }

    // ------------------------------------------------------------------
    // capStream
    // ------------------------------------------------------------------

    function test_capStream_underCapNoBurn() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(2e15, 3e15, 100);
        assertEq(emitted, 2e17);
        assertEq(streamed, 2e17);
        assertEq(burned, 0);
    }

    function test_capStream_overCapBurnsOverage() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(1e15, 6e14, 100);
        assertEq(emitted, 1e17);
        assertEq(streamed, 6e16);
        assertEq(burned, 4e16);
    }

    function test_capStream_atCapBoundary() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(5e14, 5e14, 100);
        assertEq(emitted, streamed, "alloc == cap streams fully");
        assertEq(burned, 0);
    }

    function test_capStream_zeroCapBurnsEverything() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(1e15, 0, 100);
        assertEq(streamed, 0);
        assertEq(burned, emitted);
    }

    function test_capStream_zeroDt() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(1e15, 6e14, 0);
        assertEq(emitted + streamed + burned, 0);
    }

    function testFuzz_capStream_conservation(uint256 allocatedRate, uint256 capRate, uint256 dt) public view {
        allocatedRate = bound(allocatedRate, 0, 1e30);
        capRate = bound(capRate, 0, 1e30);
        dt = bound(dt, 0, 1e9);
        (uint256 emitted, uint256 streamed, uint256 burned) = h.capStream(allocatedRate, capRate, dt);
        assertEq(emitted, streamed + burned, "conservation");
        assertLe(streamed, emitted, "cap can only reduce");
        assertEq(emitted, allocatedRate * dt);
    }

    // ------------------------------------------------------------------
    // l1Distance
    // ------------------------------------------------------------------

    function test_l1Distance_basicAndSymmetric() public view {
        uint256[] memory a = new uint256[](3);
        a[0] = 0.5e18;
        a[1] = 0.5e18;
        a[2] = 0;
        uint256[] memory b = new uint256[](3);
        b[0] = 0.2e18;
        b[1] = 0.3e18;
        b[2] = 0.5e18;
        assertEq(h.l1Distance(a, b), 0.3e18 + 0.2e18 + 0.5e18);
        assertEq(h.l1Distance(b, a), h.l1Distance(a, b), "symmetric");
        assertEq(h.l1Distance(a, a), 0, "identity");
    }

    function test_l1Distance_lengthMismatchReverts() public {
        vm.expectRevert(LibDeterministic.LengthMismatch.selector);
        h.l1Distance(new uint256[](2), new uint256[](3));
    }

    // ------------------------------------------------------------------
    // selectRotation
    // ------------------------------------------------------------------

    uint64 internal constant NOW_TS = 1_752_000_000;
    uint64 internal constant CD = 48 hours;

    function test_selectRotation_picksFarthest() public view {
        uint64[] memory last = new uint64[](3); // all zero → all eligible
        uint256[] memory dist = new uint256[](3);
        dist[0] = 1e17;
        dist[1] = 5e17;
        dist[2] = 3e17;
        (bool found, uint256 index) = h.selectRotation(last, dist, NOW_TS, CD);
        assertTrue(found);
        assertEq(index, 1, "farthest-first");
    }

    function test_selectRotation_tieBreaksToLowestIndex() public view {
        uint64[] memory last = new uint64[](3);
        uint256[] memory dist = new uint256[](3);
        dist[0] = 1e17;
        dist[1] = 4e17;
        dist[2] = 4e17;
        (bool found, uint256 index) = h.selectRotation(last, dist, NOW_TS, CD);
        assertTrue(found);
        assertEq(index, 1, "tie: lowest index wins");
    }

    function test_selectRotation_filtersCooldown() public view {
        uint64[] memory last = new uint64[](2);
        last[0] = NOW_TS - CD + 1; // 1s short of eligibility
        last[1] = NOW_TS - CD; // exactly eligible
        uint256[] memory dist = new uint256[](2);
        dist[0] = 9e17; // farthest, but cooling down
        dist[1] = 1e17;
        (bool found, uint256 index) = h.selectRotation(last, dist, NOW_TS, CD);
        assertTrue(found);
        assertEq(index, 1, "cooldown filter beats distance");
    }

    function test_selectRotation_skipsZeroDistance() public view {
        uint64[] memory last = new uint64[](2);
        uint256[] memory dist = new uint256[](2);
        dist[0] = 0; // already at target
        dist[1] = 1;
        (bool found, uint256 index) = h.selectRotation(last, dist, NOW_TS, CD);
        assertTrue(found);
        assertEq(index, 1);
    }

    function test_selectRotation_noneEligible() public view {
        // everyone cooling down
        uint64[] memory last = new uint64[](2);
        last[0] = NOW_TS - 1;
        last[1] = NOW_TS - CD + 1;
        uint256[] memory dist = new uint256[](2);
        dist[0] = 1e17;
        dist[1] = 2e17;
        (bool found,) = h.selectRotation(last, dist, NOW_TS, CD);
        assertFalse(found, "all in cooldown: not found");

        // everyone at target
        (found,) = h.selectRotation(new uint64[](2), new uint256[](2), NOW_TS, CD);
        assertFalse(found, "all zero distance: not found");

        // empty input
        (found,) = h.selectRotation(new uint64[](0), new uint256[](0), NOW_TS, CD);
        assertFalse(found);
    }

    function test_selectRotation_lengthMismatchReverts() public {
        vm.expectRevert(LibDeterministic.LengthMismatch.selector);
        h.selectRotation(new uint64[](1), new uint256[](2), NOW_TS, CD);
    }
}
