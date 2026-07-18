// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";

/// @notice TrancheFacet unit suite against the mock protocol: create/retire access
///         control, position registration, id monotonicity, and enumeration upkeep.
contract TrancheFacetTest is TestBase {
    event TrancheCreated(uint256 indexed trancheId, uint256 indexed positionTokenId, uint256 amount);
    event TrancheRetired(uint256 indexed trancheId, uint256 indexed positionTokenId);

    function setUp() public {
        _deployDiamond();
        _cutInMockProtocol();
    }

    // ------------------------------------------------------------------
    // createTranche
    // ------------------------------------------------------------------

    function test_createTranche_ownerOnly() public {
        address[3] memory callers = [STRATEGIST, KEEPER, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, callers[i], OWNER));
            TrancheFacet(d.diamond).createTranche(1_000e18, 0);
        }
    }

    function test_createTranche_registersProtocolPosition() public {
        vm.expectEmit(d.diamond);
        emit TrancheCreated(1, 1, 1_000e18);
        uint256 t1 = _createTranche(1_000e18);
        assertEq(t1, 1, "first tranche id");

        (uint256 positionTokenId, uint64 lastActionAt, bool exists) = TrancheFacet(d.diamond).tranche(t1);
        assertEq(positionTokenId, 1, "position id minted by the mock protocol");
        assertEq(lastActionAt, 0, "fresh tranche never acted: immediately rotatable");
        assertTrue(exists);
        assertEq(IProtocolFacet(d.diamond).positionWeight(positionTokenId), 1_000e18, "stake weight = amount");
    }

    function test_createTranche_incrementsIds() public {
        uint256 t1 = _createTranche(1_000e18);
        uint256 t2 = _createTranche(2_000e18);
        uint256 t3 = _createTranche(3_000e18);
        assertEq(t1, 1);
        assertEq(t2, 2);
        assertEq(t3, 3);

        // tranche ids and protocol token ids advance in lockstep here (fresh mock)
        (uint256 p2,,) = TrancheFacet(d.diamond).tranche(t2);
        (uint256 p3,,) = TrancheFacet(d.diamond).tranche(t3);
        assertEq(p2, 2);
        assertEq(p3, 3);

        uint256[] memory ids = TrancheFacet(d.diamond).trancheIds();
        assertEq(ids.length, 3);
        assertEq(ids[0], 1);
        assertEq(ids[1], 2);
        assertEq(ids[2], 3);
    }

    // ------------------------------------------------------------------
    // retireTranche
    // ------------------------------------------------------------------

    function test_retireTranche_ownerOnly() public {
        uint256 t1 = _createTranche(1_000e18);
        address[3] memory callers = [STRATEGIST, KEEPER, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, callers[i], OWNER));
            TrancheFacet(d.diamond).retireTranche(t1);
        }
    }

    function test_retireTranche_unknownReverts() public {
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TrancheFacet.UnknownTranche.selector, 99));
        TrancheFacet(d.diamond).retireTranche(99);
    }

    function test_retireTranche_removesFromEnumeration() public {
        uint256 t1 = _createTranche(1_000e18);
        uint256 t2 = _createTranche(2_000e18);
        uint256 t3 = _createTranche(3_000e18);

        vm.expectEmit(d.diamond);
        emit TrancheRetired(t2, 2);
        vm.prank(OWNER);
        TrancheFacet(d.diamond).retireTranche(t2);

        uint256[] memory ids = TrancheFacet(d.diamond).trancheIds();
        assertEq(ids.length, 2, "retired tranche removed from enumeration");
        assertEq(ids[0], t1);
        assertEq(ids[1], t3, "swap-pop keeps the remaining ids");

        (uint256 positionTokenId,, bool exists) = TrancheFacet(d.diamond).tranche(t2);
        assertFalse(exists, "tranche no longer exists");
        assertEq(positionTokenId, 2, "registry row retained for audit");

        // double retire reverts
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(TrancheFacet.UnknownTranche.selector, t2));
        TrancheFacet(d.diamond).retireTranche(t2);
    }

    function test_retireTranche_idsNeverReused() public {
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(OWNER);
        TrancheFacet(d.diamond).retireTranche(t1);
        uint256 t2 = _createTranche(500e18);
        assertEq(t2, 2, "ids are monotonic even after retirement");
    }

    // ------------------------------------------------------------------
    // tranche() view
    // ------------------------------------------------------------------

    function test_tranche_viewUnknownIsEmpty() public view {
        (uint256 positionTokenId, uint64 lastActionAt, bool exists) = TrancheFacet(d.diamond).tranche(42);
        assertEq(positionTokenId, 0);
        assertEq(lastActionAt, 0);
        assertFalse(exists);
    }
}
