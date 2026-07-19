// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {ManifestLib} from "../../script/util/ManifestLib.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IDiamond} from "../../src/interfaces/IDiamond.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {AccessFacet} from "../../src/facets/AccessFacet.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {AerodromeFacet} from "../../src/facets/protocol/AerodromeFacet.sol";
import {LibAccess} from "../../src/libraries/LibAccess.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";
import {LibDiamond} from "../../src/libraries/LibDiamond.sol";
import {DiamondInit} from "../../src/init/DiamondInit.sol";

/// @notice Diamond suite (§8.2): loupe invariants against facets.json, cut access
///         control, and the upgrade test that doubles as the September migration
///         rehearsal in miniature.
contract DiamondSuiteTest is TestBase {
    function setUp() public {
        _deployDiamond();
    }

    // ------------------------------------------------------------------
    // loupe ↔ manifest invariants
    // ------------------------------------------------------------------

    function test_loupe_everyManifestSelectorRoutesToExpectedFacet() public view {
        _assertFacetSelectors("DiamondCutFacet", d.cutFacet);
        _assertFacetSelectors("DiamondLoupeFacet", d.loupeFacet);
        _assertFacetSelectors("OwnershipFacet", d.ownershipFacet);
        _assertFacetSelectors("AccessFacet", d.accessFacet);
        _assertFacetSelectors("CustodyFacet", d.custodyFacet);
        _assertFacetSelectors("TrancheFacet", d.trancheFacet);
        _assertFacetSelectors("TargetsFacet", d.targetsFacet);
        _assertFacetSelectors("ExecutionFacet", d.executionFacet);
        _assertFacetSelectors("AerodromeFacet", d.aerodromeFacet);
    }

    function test_loupe_noOrphanSelectors() public view {
        // every selector the loupe reports must belong to a manifest facet we deployed
        IDiamondLoupe.Facet[] memory facets = IDiamondLoupe(d.diamond).facets();
        for (uint256 i; i < facets.length; ++i) {
            assertTrue(_isKnownFacet(facets[i].facetAddress), "orphan facet in loupe");
        }
    }

    function _isKnownFacet(address facet) private view returns (bool) {
        return facet == d.cutFacet || facet == d.loupeFacet || facet == d.ownershipFacet || facet == d.accessFacet
            || facet == d.custodyFacet || facet == d.trancheFacet || facet == d.targetsFacet || facet == d.executionFacet
            || facet == d.aerodromeFacet;
    }

    function _assertFacetSelectors(string memory name, address expected) private view {
        bytes4[] memory sels = ManifestLib.selectorsOf(name);
        for (uint256 i; i < sels.length; ++i) {
            assertEq(IDiamondLoupe(d.diamond).facetAddress(sels[i]), expected, string.concat("routing: ", name));
        }
    }

    // ------------------------------------------------------------------
    // cut access control, diamondCut is the root permission (P4)
    // ------------------------------------------------------------------

    function test_cut_nonOwnerReverts() public {
        IDiamond.FacetCut[] memory cuts = new IDiamond.FacetCut[](0);
        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, OUTSIDER, OWNER));
        IDiamondCut(d.diamond).diamondCut(cuts, address(0), "");
    }

    function test_cut_strategistAndKeeperCannotCut() public {
        IDiamond.FacetCut[] memory cuts = new IDiamond.FacetCut[](0);
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, STRATEGIST, OWNER));
        IDiamondCut(d.diamond).diamondCut(cuts, address(0), "");
        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, KEEPER, OWNER));
        IDiamondCut(d.diamond).diamondCut(cuts, address(0), "");
    }

    // ------------------------------------------------------------------
    // init idempotence, a replayed init cannot clobber state (§4.2 rule 4)
    // ------------------------------------------------------------------

    function test_init_cannotReExecuteGenesis() public {
        vm.prank(OWNER);
        vm.expectRevert(); // InitAlreadyExecuted, wrapped by LibDiamond init revert handling
        IDiamondCut(d.diamond).diamondCut(
            new IDiamond.FacetCut[](0), d.diamondInit, abi.encodeCall(DiamondInit.init, (_defaultConfig()))
        );
    }

    // ------------------------------------------------------------------
    // the upgrade test: populate state → protocol swap → byte-identical state
    // ------------------------------------------------------------------

    struct StateSnapshot {
        address[] pools;
        uint256[] weights;
        bytes32 strategyRef;
        uint256 position1;
        uint256 position2;
        bool exists1;
        bool exists2;
        uint256 weight1;
    }

    StateSnapshot private _snap;
    uint256 private _t1;
    uint256 private _t2;

    function _takeSnapshot() private {
        (_snap.pools, _snap.weights) = TargetsFacet(d.diamond).targets();
        (_snap.strategyRef,) = TargetsFacet(d.diamond).strategyRef();
        (_snap.position1,, _snap.exists1) = TrancheFacet(d.diamond).tranche(_t1);
        (_snap.position2,, _snap.exists2) = TrancheFacet(d.diamond).tranche(_t2);
        _snap.weight1 = IProtocolFacet(d.diamond).positionWeight(_snap.position1);
    }

    function _assertSnapshotIntact() private view {
        (address[] memory pools, uint256[] memory weights) = TargetsFacet(d.diamond).targets();
        (bytes32 ref,) = TargetsFacet(d.diamond).strategyRef();
        assertEq(pools.length, _snap.pools.length, "targets pools");
        for (uint256 i; i < pools.length; ++i) {
            assertEq(pools[i], _snap.pools[i]);
            assertEq(weights[i], _snap.weights[i]);
        }
        assertEq(ref, _snap.strategyRef, "strategyRef");
        (uint256 p1,, bool e1) = TrancheFacet(d.diamond).tranche(_t1);
        (uint256 p2,, bool e2) = TrancheFacet(d.diamond).tranche(_t2);
        assertEq(p1, _snap.position1);
        assertEq(p2, _snap.position2);
        assertTrue(e1 == _snap.exists1 && e2 == _snap.exists2, "tranche existence");
        assertEq(IProtocolFacet(d.diamond).positionWeight(p1), _snap.weight1, "position weight survives round-trip");
        assertTrue(AccessFacet(d.diamond).hasRole(AccessFacet(d.diamond).KEEPER_ROLE(), KEEPER), "roles intact");
    }

    function test_upgrade_protocolSwapPreservesAllNamespaces() public {
        // populate every domain
        _cutInMockProtocol();
        _allowPools();
        _setTarget5050();
        _t1 = _createTranche(1_000e18);
        _t2 = _createTranche(2_000e18);
        vm.warp(block.timestamp + 2 days);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(_t1);

        _takeSnapshot();

        // swap Mock → Aerodrome → Mock through the sanctioned path (mid-lifecycle swap)
        vm.prank(OWNER);
        IDiamondCut(d.diamond).diamondCut(
            protocolSwapCut("MockAeroFacet", d.aerodromeFacet, "AerodromeFacet"), address(0), ""
        );
        vm.prank(OWNER);
        IDiamondCut(d.diamond).diamondCut(
            protocolSwapCut("AerodromeFacet", mockAeroFacet, "MockAeroFacet"), address(0), ""
        );

        _assertSnapshotIntact();

        // flows still functional post-cut: rotate the second tranche
        vm.warp(block.timestamp + 3 days);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(_t2);
        assertEq(IProtocolFacet(d.diamond).protocolId(), keccak256("mock-aero-v3"));
    }

    function test_upgrade_swapChangesOnlyProtocolSelectors() public {
        _cutInMockProtocol();
        // IProtocolFacet selectors now route to the mock; vault selectors untouched
        assertEq(IDiamondLoupe(d.diamond).facetAddress(IProtocolFacet.createStake.selector), mockAeroFacet);
        assertEq(IDiamondLoupe(d.diamond).facetAddress(TrancheFacet.createTranche.selector), d.trancheFacet);
        assertEq(IDiamondLoupe(d.diamond).facetAddress(TargetsFacet.setTargets.selector), d.targetsFacet);
        // mock-only selectors were Added
        assertEq(IDiamondLoupe(d.diamond).facetAddress(MockAeroFacet.mockSettle.selector), mockAeroFacet);
    }
}
