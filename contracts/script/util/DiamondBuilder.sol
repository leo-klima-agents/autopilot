// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IDiamond} from "../../src/interfaces/IDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {Diamond, DiamondArgs} from "../../src/Diamond.sol";
import {DiamondCutFacet} from "../../src/facets/DiamondCutFacet.sol";
import {DiamondLoupeFacet} from "../../src/facets/DiamondLoupeFacet.sol";
import {OwnershipFacet} from "../../src/facets/OwnershipFacet.sol";
import {AccessFacet} from "../../src/facets/AccessFacet.sol";
import {CustodyFacet} from "../../src/facets/CustodyFacet.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {AerodromeFacet} from "../../src/facets/protocol/AerodromeFacet.sol";
import {DiamondInit} from "../../src/init/DiamondInit.sol";
import {ManifestLib} from "./ManifestLib.sol";

/// @title DiamondBuilder
/// @notice Shared assembly logic for Deploy.s.sol and the test harness: deploys the
///         standard facet set and produces the genesis cut from facets.json, so what CI
///         checked is exactly what gets cut (rule: Cut.s.sol / this builder only — no
///         hand-rolled cuts).
contract DiamondBuilder {
    struct Deployed {
        address diamond;
        address diamondInit;
        address cutFacet;
        address loupeFacet;
        address ownershipFacet;
        address accessFacet;
        address custodyFacet;
        address trancheFacet;
        address targetsFacet;
        address executionFacet;
        address aerodromeFacet;
    }

    function deployCore(address owner, DiamondInit.InitConfig memory cfg) internal returns (Deployed memory d) {
        d.cutFacet = address(new DiamondCutFacet());
        d.loupeFacet = address(new DiamondLoupeFacet());
        d.ownershipFacet = address(new OwnershipFacet());
        d.accessFacet = address(new AccessFacet());
        d.custodyFacet = address(new CustodyFacet());
        d.trancheFacet = address(new TrancheFacet());
        d.targetsFacet = address(new TargetsFacet());
        d.executionFacet = address(new ExecutionFacet());
        d.aerodromeFacet = address(new AerodromeFacet());
        d.diamondInit = address(new DiamondInit());

        // genesis diamond carries only the cut facet; everything else arrives via one cut
        d.diamond = address(
            new Diamond(
                _cutFor(d.cutFacet, "DiamondCutFacet"),
                DiamondArgs({owner: owner, init: address(0), initCalldata: ""})
            )
        );

        IDiamond.FacetCut[] memory cuts = new IDiamond.FacetCut[](8);
        cuts[0] = _add(d.loupeFacet, "DiamondLoupeFacet");
        cuts[1] = _add(d.ownershipFacet, "OwnershipFacet");
        cuts[2] = _add(d.accessFacet, "AccessFacet");
        cuts[3] = _add(d.custodyFacet, "CustodyFacet");
        cuts[4] = _add(d.trancheFacet, "TrancheFacet");
        cuts[5] = _add(d.targetsFacet, "TargetsFacet");
        cuts[6] = _add(d.executionFacet, "ExecutionFacet");
        cuts[7] = _add(d.aerodromeFacet, "AerodromeFacet");

        IDiamondCut(d.diamond).diamondCut(cuts, d.diamondInit, abi.encodeCall(DiamondInit.init, (cfg)));
    }

    /// @notice build the cut that swaps the live protocol facet for another (P8): the
    ///         August/September transition in one operation. Selectors shared between the
    ///         facets are Replaced, new-only selectors Added, old-only selectors Removed.
    function protocolSwapCut(string memory oldFacetName, address newFacet, string memory newFacetName)
        internal
        view
        returns (IDiamond.FacetCut[] memory cuts)
    {
        bytes4[] memory oldSel = ManifestLib.selectorsOf(oldFacetName);
        bytes4[] memory newSel = ManifestLib.selectorsOf(newFacetName);

        bytes4[] memory replaced = _intersection(newSel, oldSel);
        bytes4[] memory added = _difference(newSel, oldSel);
        bytes4[] memory removed = _difference(oldSel, newSel);

        uint256 n;
        if (replaced.length > 0) n++;
        if (added.length > 0) n++;
        if (removed.length > 0) n++;
        cuts = new IDiamond.FacetCut[](n);
        uint256 i;
        if (replaced.length > 0) {
            cuts[i++] =
                IDiamond.FacetCut({facetAddress: newFacet, action: IDiamond.FacetCutAction.Replace, functionSelectors: replaced});
        }
        if (added.length > 0) {
            cuts[i++] =
                IDiamond.FacetCut({facetAddress: newFacet, action: IDiamond.FacetCutAction.Add, functionSelectors: added});
        }
        if (removed.length > 0) {
            cuts[i++] =
                IDiamond.FacetCut({facetAddress: address(0), action: IDiamond.FacetCutAction.Remove, functionSelectors: removed});
        }
    }

    function _contains(bytes4[] memory set, bytes4 sel) private pure returns (bool) {
        for (uint256 i; i < set.length; ++i) {
            if (set[i] == sel) return true;
        }
        return false;
    }

    function _intersection(bytes4[] memory a, bytes4[] memory b) private pure returns (bytes4[] memory out) {
        bytes4[] memory tmp = new bytes4[](a.length);
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (_contains(b, a[i])) tmp[n++] = a[i];
        }
        out = new bytes4[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    function _difference(bytes4[] memory a, bytes4[] memory b) private pure returns (bytes4[] memory out) {
        bytes4[] memory tmp = new bytes4[](a.length);
        uint256 n;
        for (uint256 i; i < a.length; ++i) {
            if (!_contains(b, a[i])) tmp[n++] = a[i];
        }
        out = new bytes4[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = tmp[i];
        }
    }

    function _add(address facet, string memory name) private view returns (IDiamond.FacetCut memory) {
        return IDiamond.FacetCut({
            facetAddress: facet,
            action: IDiamond.FacetCutAction.Add,
            functionSelectors: ManifestLib.selectorsOf(name)
        });
    }

    function _cutFor(address facet, string memory name) private view returns (IDiamond.FacetCut[] memory cuts) {
        cuts = new IDiamond.FacetCut[](1);
        cuts[0] = _add(facet, name);
    }
}
