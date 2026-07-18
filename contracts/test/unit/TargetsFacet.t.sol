// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {LibAccess} from "../../src/libraries/LibAccess.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";

/// @notice TargetsFacet unit suite: every guardrail branch of setTargets, target
///         replacement semantics (old weights zeroed), allowlist maintenance, and
///         owner-only guardrail administration.
contract TargetsFacetTest is TestBase {
    event TargetsSet(address[] pools, uint256[] weightsWad, bytes32 indexed strategyRef, address indexed strategist);
    event GuardrailsSet(uint96 maxPoolWeightWad, uint96 maxDeltaWad, uint64 rotationCooldown, address organicFlowOracle);
    event PoolAllowed(address indexed pool, bool allowed);

    address internal constant POOL_X = address(0x100E); // never allowlisted

    function setUp() public {
        _deployDiamond();
        _allowPools();
    }

    function _submit(address[] memory pools, uint256[] memory weights) internal {
        vm.prank(STRATEGIST);
        TargetsFacet(d.diamond).setTargets(pools, weights, keccak256("ref"));
    }

    function _pair(address a, address b, uint256 wa, uint256 wb)
        internal
        pure
        returns (address[] memory pools, uint256[] memory weights)
    {
        pools = new address[](2);
        pools[0] = a;
        pools[1] = b;
        weights = new uint256[](2);
        weights[0] = wa;
        weights[1] = wb;
    }

    // ------------------------------------------------------------------
    // guardrail branches
    // ------------------------------------------------------------------

    function test_setTargets_lengthMismatch() public {
        address[] memory pools = new address[](2);
        pools[0] = POOL_A;
        pools[1] = POOL_B;
        uint256[] memory weights = new uint256[](1);
        weights[0] = WAD;
        vm.prank(STRATEGIST);
        vm.expectRevert(TargetsFacet.LengthMismatch.selector);
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_emptyTarget() public {
        vm.prank(STRATEGIST);
        vm.expectRevert(TargetsFacet.EmptyTarget.selector);
        TargetsFacet(d.diamond).setTargets(new address[](0), new uint256[](0), bytes32(0));
    }

    function test_setTargets_poolNotAllowed() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_X, 0.5e18, 0.5e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.PoolNotAllowed.selector, POOL_X));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_weightAboveMax() public {
        // maxPoolWeightWad is 0.5e18 in the default config
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.6e18, 0.4e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.WeightAboveMax.selector, POOL_A, 0.6e18));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_sumTooLow() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.4e18, 0.5e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.WeightsMustSumToWad.selector, 0.9e18));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_sumTooHigh() public {
        address[] memory pools = new address[](3);
        pools[0] = POOL_A;
        pools[1] = POOL_B;
        pools[2] = POOL_C;
        uint256[] memory weights = new uint256[](3);
        weights[0] = 0.5e18;
        weights[1] = 0.5e18;
        weights[2] = 0.1e18;
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.WeightsMustSumToWad.selector, 1.1e18));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_deltaAboveMax() public {
        // seed a stored target under the permissive default maxDeltaWad
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        _submit(pools, weights);

        // tighten the delta guardrail, then submit a reallocation with L1 distance 0.4e18
        // (every weight stays <= maxPoolWeightWad so only the delta guardrail can fire)
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setGuardrails(uint96(0.5e18), uint96(0.1e18), 1 days, address(0));

        pools = new address[](3);
        pools[0] = POOL_A;
        pools[1] = POOL_B;
        pools[2] = POOL_C;
        weights = new uint256[](3);
        weights[0] = 0.5e18;
        weights[1] = 0.3e18;
        weights[2] = 0.2e18;
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.DeltaAboveMax.selector, 0.4e18, 0.1e18));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_duplicatePool() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_A, 0.5e18, 0.5e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.DuplicatePool.selector, POOL_A));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    function test_setTargets_nonStrategistReverts() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        address[3] memory callers = [OWNER, KEEPER, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(
                abi.encodeWithSelector(LibAccess.MissingRole.selector, LibAccess.STRATEGIST_ROLE, callers[i])
            );
            TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
        }
    }

    // ------------------------------------------------------------------
    // happy path + full replacement
    // ------------------------------------------------------------------

    function test_setTargets_storesTargetRefAndTimestamp() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        vm.warp(block.timestamp + 12 hours);

        vm.expectEmit(d.diamond);
        emit TargetsSet(pools, weights, keccak256("cfg-v1"), STRATEGIST);
        vm.prank(STRATEGIST);
        TargetsFacet(d.diamond).setTargets(pools, weights, keccak256("cfg-v1"));

        (address[] memory storedPools, uint256[] memory storedWeights) = TargetsFacet(d.diamond).targets();
        assertEq(storedPools.length, 2);
        assertEq(storedPools[0], POOL_A);
        assertEq(storedPools[1], POOL_B);
        assertEq(storedWeights[0], 0.5e18);
        assertEq(storedWeights[1], 0.5e18);

        (bytes32 ref, uint64 submittedAt) = TargetsFacet(d.diamond).strategyRef();
        assertEq(ref, keccak256("cfg-v1"));
        assertEq(submittedAt, uint64(block.timestamp));
    }

    function test_setTargets_replacesPreviousTargetFully() public {
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        _submit(pools, weights);

        // replace with a disjoint-overlapping target; delta = 0.5 (A→0) + 0 (B) + 0.5 (C) = 1e18
        (pools, weights) = _pair(POOL_B, POOL_C, 0.5e18, 0.5e18);
        _submit(pools, weights);

        (address[] memory storedPools, uint256[] memory storedWeights) = TargetsFacet(d.diamond).targets();
        assertEq(storedPools.length, 2, "old target fully replaced");
        assertEq(storedPools[0], POOL_B);
        assertEq(storedPools[1], POOL_C);
        assertEq(storedWeights[0], 0.5e18);
        assertEq(storedWeights[1], 0.5e18);
    }

    function test_setTargets_replacementZeroesOldWeights() public {
        // target1: A/B — then target2: B/C. If A's stored weight is properly zeroed,
        // re-submitting A/B must price A's re-entry at 0.5e18 in the delta math:
        // delta = 0.5 (A: 0→0.5) + 0 (B) + 0.5 (C: 0.5→0) = 1.0e18.
        // A stale A weight of 0.5e18 would instead yield delta 0.5e18 and slip below the cap.
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        _submit(pools, weights);
        (pools, weights) = _pair(POOL_B, POOL_C, 0.5e18, 0.5e18);
        _submit(pools, weights);

        vm.prank(OWNER);
        TargetsFacet(d.diamond).setGuardrails(uint96(0.5e18), uint96(0.75e18), 1 days, address(0));

        (pools, weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.DeltaAboveMax.selector, 1e18, 0.75e18));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));
    }

    // ------------------------------------------------------------------
    // allowlist maintenance
    // ------------------------------------------------------------------

    function test_setPoolAllowed_addAndRemoveMaintainsAllowlist() public {
        address[] memory list = TargetsFacet(d.diamond).allowlist();
        assertEq(list.length, 3, "A, B, C from setUp");

        // duplicate add: no duplicate entry
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_A, true);
        assertEq(TargetsFacet(d.diamond).allowlist().length, 3, "re-allow must not duplicate");

        // remove the middle entry (swap-pop)
        vm.expectEmit(d.diamond);
        emit PoolAllowed(POOL_B, false);
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_B, false);
        list = TargetsFacet(d.diamond).allowlist();
        assertEq(list.length, 2);
        assertEq(list[0], POOL_A);
        assertEq(list[1], POOL_C);

        // removing an already-removed pool is a no-op
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_B, false);
        assertEq(TargetsFacet(d.diamond).allowlist().length, 2);

        // disallowed pool is rejected by setTargets
        (address[] memory pools, uint256[] memory weights) = _pair(POOL_A, POOL_B, 0.5e18, 0.5e18);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(TargetsFacet.PoolNotAllowed.selector, POOL_B));
        TargetsFacet(d.diamond).setTargets(pools, weights, bytes32(0));

        // re-allow appends again
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_B, true);
        list = TargetsFacet(d.diamond).allowlist();
        assertEq(list.length, 3);
        assertEq(list[2], POOL_B);
    }

    function test_setPoolAllowed_ownerOnly() public {
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, STRATEGIST, OWNER));
        TargetsFacet(d.diamond).setPoolAllowed(POOL_X, true);
    }

    // ------------------------------------------------------------------
    // guardrail administration
    // ------------------------------------------------------------------

    function test_setGuardrails_ownerOnlyAndStored() public {
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, STRATEGIST, OWNER));
        TargetsFacet(d.diamond).setGuardrails(uint96(0.3e18), uint96(0.4e18), 2 days, address(0x0AC1E));

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, KEEPER, OWNER));
        TargetsFacet(d.diamond).setGuardrails(uint96(0.3e18), uint96(0.4e18), 2 days, address(0x0AC1E));

        vm.expectEmit(d.diamond);
        emit GuardrailsSet(uint96(0.3e18), uint96(0.4e18), 2 days, address(0x0AC1E));
        vm.prank(OWNER);
        TargetsFacet(d.diamond).setGuardrails(uint96(0.3e18), uint96(0.4e18), 2 days, address(0x0AC1E));

        (uint96 maxPool, uint96 maxDelta, uint64 cooldown, address oracle) = TargetsFacet(d.diamond).guardrails();
        assertEq(maxPool, uint96(0.3e18));
        assertEq(maxDelta, uint96(0.4e18));
        assertEq(cooldown, 2 days);
        assertEq(oracle, address(0x0AC1E));
    }
}
