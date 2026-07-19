// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {LibAccess} from "../../src/libraries/LibAccess.sol";

/// @notice ExecutionFacet unit suite: keeper gating, rotate cooldown machinery, and
///         harvest/compound flows exercised against the mock protocol's streaming model.
contract ExecutionFacetTest is TestBase {
    event Rotated(uint256 indexed trancheId, uint256 indexed positionTokenId, bytes32 strategyRef);
    event Harvested(uint256 indexed trancheId, uint256 indexed positionTokenId);
    event Compounded(uint256 indexed trancheId, uint256 indexed positionTokenId, uint256 added);

    function setUp() public {
        _deployDiamond();
        _cutInMockProtocol();
        _allowPools();
    }

    function _expectMissingKeeperRole(address caller) internal {
        vm.expectRevert(abi.encodeWithSelector(LibAccess.MissingRole.selector, LibAccess.KEEPER_ROLE, caller));
    }

    // ------------------------------------------------------------------
    // rotate, access + guard branches
    // ------------------------------------------------------------------

    function test_rotate_keeperOnly() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        address[3] memory callers = [OWNER, STRATEGIST, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            _expectMissingKeeperRole(callers[i]);
            ExecutionFacet(d.diamond).rotate(t1);
        }
    }

    function test_rotate_unknownTranche() public {
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(ExecutionFacet.UnknownTranche.selector, 7));
        ExecutionFacet(d.diamond).rotate(7);
    }

    function test_rotate_noTargetSet() public {
        uint256 t1 = _createTranche(1_000e18);
        vm.warp(block.timestamp + 2 days); // cooldown elapsed, target check must fire first
        vm.prank(KEEPER);
        vm.expectRevert(ExecutionFacet.NoTargetSet.selector);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    function test_rotate_freshTrancheRotatesImmediately() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        // lastActionAt == 0: no vault cooldown before the first rotation
        vm.expectEmit(d.diamond);
        emit Rotated(t1, 1, keccak256("strategy-config-v1"));
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    function test_rotate_cooldownActiveThenSuccess() public {
        // shrink the protocol cooldown so the VAULT cooldown (1 day) is the binding one
        vm.prank(OWNER);
        MockAeroFacet(d.diamond).mockSetCooldown(1 hours, true);
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1); // arms the cooldown
        uint64 readyAt = uint64(block.timestamp + 1 days);

        // immediately after: cooldown active
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(ExecutionFacet.CooldownActive.selector, t1, readyAt));
        ExecutionFacet(d.diamond).rotate(t1);

        // one second before readiness: still active
        vm.warp(readyAt - 1);
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(ExecutionFacet.CooldownActive.selector, t1, readyAt));
        ExecutionFacet(d.diamond).rotate(t1);

        // exactly at readyAt: rotates
        vm.warp(readyAt);
        vm.expectEmit(d.diamond);
        emit Rotated(t1, 1, keccak256("strategy-config-v1"));
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    function test_rotate_updatesLastActionAt() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        vm.warp(block.timestamp + 3 hours);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);

        (, uint64 lastActionAt,) = TrancheFacet(d.diamond).tranche(t1);
        assertEq(lastActionAt, uint64(block.timestamp), "rotate stamps lastActionAt");
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 1 days, "full cooldown re-armed");
    }

    function test_rotate_protocolCooldownStillGates() public {
        // vault cooldown (1 day) elapses before the mock's 48h per-position cooldown:
        // the protocol layer must still block the second rotate
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
        uint64 protocolReadyAt = uint64(block.timestamp + 48 hours);

        vm.warp(block.timestamp + 1 days); // vault says go, protocol says no
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(MockAeroFacet.CooldownNotElapsed.selector, 1, protocolReadyAt));
        ExecutionFacet(d.diamond).rotate(t1);

        vm.warp(protocolReadyAt);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1); // both cooldowns elapsed
    }

    // ------------------------------------------------------------------
    // harvest
    // ------------------------------------------------------------------

    function test_harvest_keeperOnly() public {
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(OUTSIDER);
        _expectMissingKeeperRole(OUTSIDER);
        ExecutionFacet(d.diamond).harvest(t1, "");
    }

    function test_harvest_unknownTranche() public {
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(ExecutionFacet.UnknownTranche.selector, 7));
        ExecutionFacet(d.diamond).harvest(7, "");
    }

    function test_harvest_claimsStreamedRevenue() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1); // allocate 50/50 A/B, sole allocator

        vm.warp(block.timestamp + 1 days);
        MockAeroFacet(d.diamond).mockSettle();
        uint256 expected = (1e15 + 5e14) * 1 days; // full revenue of both pools
        assertEq(MockAeroFacet(d.diamond).mockEarned(1), expected, "streamed revenue accrued");

        vm.expectEmit(d.diamond);
        emit Harvested(t1, 1);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).harvest(t1, "");
        assertEq(MockAeroFacet(d.diamond).mockEarned(1), 0, "harvest zeroes earned");
    }

    // ------------------------------------------------------------------
    // compoundTranche
    // ------------------------------------------------------------------

    function test_compoundTranche_keeperOnly() public {
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(OUTSIDER);
        _expectMissingKeeperRole(OUTSIDER);
        ExecutionFacet(d.diamond).compoundTranche(t1, 0, "");
    }

    function test_compoundTranche_addsEarnedToPositionWeight() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);

        vm.warp(block.timestamp + 1 days);
        // sole allocator in A (rate 1e15/s) and B (rate 5e14/s) → exact accrual
        uint256 expected = (1e15 + 5e14) * 1 days;

        vm.expectEmit(d.diamond);
        emit Compounded(t1, 1, expected);
        vm.prank(KEEPER);
        uint256 added = ExecutionFacet(d.diamond).compoundTranche(t1, 0, "");

        assertEq(added, expected, "compound returns streamed amount");
        assertEq(IProtocolFacet(d.diamond).positionWeight(1), 1_000e18 + expected, "weight increased by earned");
        assertEq(MockAeroFacet(d.diamond).mockEarned(1), 0, "earned consumed");
    }

    // ------------------------------------------------------------------
    // vaultCooldownRemaining
    // ------------------------------------------------------------------

    function test_vaultCooldownRemaining_math() public {
        _setTarget5050();
        uint256 t1 = _createTranche(1_000e18);
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 0, "fresh tranche immediately rotatable");

        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 1 days, "rotate arms the full cooldown");

        vm.warp(block.timestamp + 5 hours);
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 19 hours, "counts down");

        vm.warp(block.timestamp + 19 hours);
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 0, "zero at readyAt");

        vm.warp(block.timestamp + 30 days);
        assertEq(ExecutionFacet(d.diamond).vaultCooldownRemaining(t1), 0, "stays zero");
    }

    function test_vaultCooldownRemaining_unknownTranche() public {
        vm.expectRevert(abi.encodeWithSelector(ExecutionFacet.UnknownTranche.selector, 7));
        ExecutionFacet(d.diamond).vaultCooldownRemaining(7);
    }
}
