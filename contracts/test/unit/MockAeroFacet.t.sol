// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {LibAccess} from "../../src/libraries/LibAccess.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";

/// @notice MockAeroFacet unit suite: cooldown granularity (per-position vs global),
///         exact streaming accrual, cap/burn conservation, and allocation lifecycle.
///         The mock is the stand-in for the v3 spec drafts, so its semantics are
///         pinned down exactly (F1/F2, F10, F13–F15).
contract MockAeroFacetTest is TestBase {
    // pool parameters from _cutInMockProtocol:
    //   POOL_A: revenueRate 1e15, allocatedRate 2e15, capRate 3e15  (under cap)
    //   POOL_B: revenueRate 5e14, allocatedRate 1e15, capRate 6e14  (over cap → burn)
    //   POOL_C: revenueRate 0,    allocatedRate 1e15, capRate 0     (cap 0 → burn all)

    function setUp() public {
        _deployDiamond();
        _cutInMockProtocol();
    }

    function _stake(uint256 amount) internal returns (uint256 tokenId) {
        vm.prank(OWNER);
        tokenId = IProtocolFacet(d.diamond).createStake(amount, 0, true);
    }

    function _alloc(uint256 tokenId, address pool) internal {
        address[] memory pools = new address[](1);
        pools[0] = pool;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1; // relative weights: single pool gets everything
        vm.prank(OWNER);
        IProtocolFacet(d.diamond).allocate(tokenId, pools, weights);
    }

    // ------------------------------------------------------------------
    // access gates
    // ------------------------------------------------------------------

    function test_mutators_selfOrOwnerOnly() public {
        uint256 tok = _stake(100e18);
        address[] memory pools = new address[](1);
        pools[0] = POOL_A;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(LibAccess.NotSelfOrOwner.selector, OUTSIDER));
        IProtocolFacet(d.diamond).allocate(tok, pools, weights);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(LibAccess.NotSelfOrOwner.selector, OUTSIDER));
        IProtocolFacet(d.diamond).createStake(1e18, 0, true);
    }

    function test_mockControls_ownerOnly() public {
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, OUTSIDER, OWNER));
        MockAeroFacet(d.diamond).mockSetCooldown(1 hours, true);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, OUTSIDER, OWNER));
        MockAeroFacet(d.diamond).mockAddPool(address(0xDEAD), 1, 1, 1);
    }

    // ------------------------------------------------------------------
    // per-position cooldown (F1/F2)
    // ------------------------------------------------------------------

    function test_perPositionCooldown_blocksReallocationWithin48h() public {
        uint256 tok = _stake(100e18);
        _alloc(tok, POOL_A);
        uint64 readyAt = uint64(block.timestamp + 48 hours);

        // immediate re-allocation blocked with the exact readyAt
        address[] memory pools = new address[](1);
        pools[0] = POOL_B;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.CooldownNotElapsed.selector, tok, readyAt));
        IProtocolFacet(d.diamond).allocate(tok, pools, weights);

        // one second early: still blocked
        vm.warp(readyAt - 1);
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.CooldownNotElapsed.selector, tok, readyAt));
        IProtocolFacet(d.diamond).allocate(tok, pools, weights);

        // exactly at readyAt: allowed
        vm.warp(readyAt);
        _alloc(tok, POOL_B);
    }

    function test_perPositionCooldown_doesNotBlockOtherPositions() public {
        uint256 tok1 = _stake(100e18);
        uint256 tok2 = _stake(200e18);
        _alloc(tok1, POOL_A);

        vm.warp(block.timestamp + 1 hours); // deep inside tok1's cooldown
        _alloc(tok2, POOL_A); // must succeed: cooldown is per position (F2)
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok2), 48 hours, "tok2 cooldown armed independently");
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok1), 47 hours, "tok1 unaffected by tok2");
    }

    function test_globalCooldown_blocksAcrossPositions() public {
        vm.prank(OWNER);
        MockAeroFacet(d.diamond).mockSetCooldown(48 hours, false); // §3.1 breakage probe

        uint256 tok1 = _stake(100e18);
        uint256 tok2 = _stake(200e18);
        _alloc(tok1, POOL_A);
        uint64 readyAt = uint64(block.timestamp + 48 hours);

        address[] memory pools = new address[](1);
        pools[0] = POOL_A;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.CooldownNotElapsed.selector, tok2, readyAt));
        IProtocolFacet(d.diamond).allocate(tok2, pools, weights);

        vm.warp(readyAt);
        _alloc(tok2, POOL_A); // global cooldown elapsed
    }

    function test_cooldownRemaining_viewMath() public {
        uint256 tok = _stake(100e18);
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok), 0, "never allocated: free");
        _alloc(tok, POOL_A);
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok), 48 hours);
        vm.warp(block.timestamp + 10 hours);
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok), 38 hours);
        vm.warp(block.timestamp + 38 hours);
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tok), 0);
    }

    // ------------------------------------------------------------------
    // streaming accrual (F10)
    // ------------------------------------------------------------------

    function test_streaming_singleAllocatorEarnsExactly() public {
        uint256 tok = _stake(100e18);
        _alloc(tok, POOL_A);

        vm.warp(block.timestamp + 1000);
        MockAeroFacet(d.diamond).mockSettle();

        assertEq(MockAeroFacet(d.diamond).mockEarned(tok), 1e15 * 1000, "sole allocator gets revenueRate*dt");
    }

    function test_streaming_twoAllocatorsSplitProRataFloor() public {
        uint256 tok1 = _stake(100e18);
        uint256 tok2 = _stake(200e18);
        _alloc(tok1, POOL_A);
        _alloc(tok2, POOL_A); // same timestamp — per-position cooldowns independent

        vm.warp(block.timestamp + 1000);
        MockAeroFacet(d.diamond).mockSettle();

        uint256 revenue = 1e15 * 1000; // 1e18: not divisible by 3 → floor rounding visible
        uint256 e1 = MockAeroFacet(d.diamond).mockEarned(tok1);
        uint256 e2 = MockAeroFacet(d.diamond).mockEarned(tok2);
        assertEq(e1, (revenue * 100e18) / 300e18, "1/3 share, mulDiv floor");
        assertEq(e1, 333333333333333333);
        assertEq(e2, (revenue * 200e18) / 300e18, "2/3 share, mulDiv floor");
        assertEq(e2, 666666666666666666);
        assertEq(e1 + e2, revenue - 1, "floor dust stays undistributed");
    }

    // ------------------------------------------------------------------
    // cap / burn (F13–F15) and conservation
    // ------------------------------------------------------------------

    function test_capBurn_accountingAndConservation() public {
        (uint256 e0, uint256 s0, uint256 b0) = MockAeroFacet(d.diamond).mockTotals();
        assertEq(e0 + s0 + b0, 0, "clean slate after cut");

        uint256 dt = 500;
        vm.warp(block.timestamp + dt);
        MockAeroFacet(d.diamond).mockSettle();

        (uint256 emitted, uint256 streamed, uint256 burned) = MockAeroFacet(d.diamond).mockTotals();
        // A: alloc 2e15 < cap 3e15 → no burn; B: alloc 1e15 > cap 6e14; C: cap 0 → all burned
        assertEq(emitted, (2e15 + 1e15 + 1e15) * dt, "emitted = sum allocatedRate*dt");
        assertEq(streamed, (2e15 + 6e14 + 0) * dt, "streamed = sum min(alloc,cap)*dt");
        assertEq(burned, (0 + 4e14 + 1e15) * dt, "burned = sum (alloc-eff)*dt");
        assertEq(emitted, streamed + burned, "conservation: emitted == streamed + burned");
    }

    function test_capBurn_accumulatesAcrossSegments() public {
        vm.warp(block.timestamp + 100);
        MockAeroFacet(d.diamond).mockSettle();
        vm.warp(block.timestamp + 300);
        MockAeroFacet(d.diamond).mockSettle();

        (uint256 emitted, uint256 streamed, uint256 burned) = MockAeroFacet(d.diamond).mockTotals();
        assertEq(emitted, 4e15 * 400, "two segments integrate to the same total");
        assertEq(emitted, streamed + burned);
    }

    // ------------------------------------------------------------------
    // claim / resetAllocation
    // ------------------------------------------------------------------

    function test_claim_zeroesEarned() public {
        uint256 tok = _stake(100e18);
        _alloc(tok, POOL_A);
        vm.warp(block.timestamp + 1000);
        MockAeroFacet(d.diamond).mockSettle();
        assertGt(MockAeroFacet(d.diamond).mockEarned(tok), 0);

        vm.prank(OWNER);
        IProtocolFacet(d.diamond).claim(tok, "");
        assertEq(MockAeroFacet(d.diamond).mockEarned(tok), 0, "claim zeroes earned");
    }

    function test_resetAllocation_freesWeightFromPool() public {
        uint256 tok1 = _stake(100e18);
        uint256 tok2 = _stake(300e18);
        _alloc(tok1, POOL_A);
        _alloc(tok2, POOL_A); // pool A totalWeight = 400e18

        vm.warp(block.timestamp + 400);
        // resetAllocation settles first: split 1/4 vs 3/4 of 1e15*400
        vm.prank(OWNER);
        IProtocolFacet(d.diamond).resetAllocation(tok2);
        assertEq(MockAeroFacet(d.diamond).mockEarned(tok1), 1e17, "tok1: 1/4 of first segment");
        assertEq(MockAeroFacet(d.diamond).mockEarned(tok2), 3e17, "tok2: 3/4 of first segment");

        // after the reset tok1 is the sole allocator: earns 100% of the next segment,
        // proving tok2's weight was freed from the pool
        vm.warp(block.timestamp + 100);
        MockAeroFacet(d.diamond).mockSettle();
        assertEq(MockAeroFacet(d.diamond).mockEarned(tok1), 1e17 + 1e15 * 100, "tok1 now earns the full stream");
        assertEq(MockAeroFacet(d.diamond).mockEarned(tok2), 3e17, "tok2 accrues nothing after reset");
    }

    // ------------------------------------------------------------------
    // input validation
    // ------------------------------------------------------------------

    function test_allocate_unknownPositionReverts() public {
        address[] memory pools = new address[](1);
        pools[0] = POOL_A;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.UnknownPosition.selector, 99));
        IProtocolFacet(d.diamond).allocate(99, pools, weights);
    }

    function test_allocate_unknownPoolReverts() public {
        uint256 tok = _stake(100e18);
        address[] memory pools = new address[](1);
        pools[0] = address(0xDEAD);
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.UnknownPool.selector, address(0xDEAD)));
        IProtocolFacet(d.diamond).allocate(tok, pools, weights);
    }

    function test_allocate_lengthMismatchReverts() public {
        uint256 tok = _stake(100e18);
        address[] memory pools = new address[](2);
        pools[0] = POOL_A;
        pools[1] = POOL_B;
        uint256[] memory weights = new uint256[](1);
        weights[0] = 1;
        vm.prank(OWNER);
        vm.expectRevert(MockAeroFacet.LengthMismatch.selector);
        IProtocolFacet(d.diamond).allocate(tok, pools, weights);
    }
}
