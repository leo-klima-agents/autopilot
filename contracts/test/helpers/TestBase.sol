// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {DiamondBuilder} from "../../script/util/DiamondBuilder.sol";
import {DiamondInit} from "../../src/init/DiamondInit.sol";
import {IDiamond} from "../../src/interfaces/IDiamond.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {AccessFacet} from "../../src/facets/AccessFacet.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {CustodyFacet} from "../../src/facets/CustodyFacet.sol";
import {IERC173} from "../../src/interfaces/IERC173.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";

/// @notice Shared harness: full diamond deployed via the same builder as production,
///         then (optionally) the protocol facet swapped Aerodrome→Mock through the real
///         cut path, so every test run also exercises the swap machinery.
abstract contract TestBase is Test, DiamondBuilder {
    address internal constant OWNER = address(0xA11CE);
    address internal constant STRATEGIST = address(0x57121);
    address internal constant KEEPER = address(0x6EE6);
    address internal constant OUTSIDER = address(0xBAD);

    // dummy protocol addresses for unit tests (never called by MockAeroFacet)
    address internal constant DUMMY_VOTER = address(0xD001);
    address internal constant DUMMY_ESCROW = address(0xD002);
    address internal constant DUMMY_DIST = address(0xD003);
    address internal constant DUMMY_TOKEN = address(0xD004);
    address internal constant DUMMY_ROUTER = address(0xD005);

    address internal constant POOL_A = address(0x100A);
    address internal constant POOL_B = address(0x100B);
    address internal constant POOL_C = address(0x100C);

    uint256 internal constant WAD = 1e18;

    Deployed internal d;
    address internal mockAeroFacet;

    function _defaultConfig() internal pure returns (DiamondInit.InitConfig memory) {
        return DiamondInit.InitConfig({
            strategistSafe: STRATEGIST,
            keeper: KEEPER,
            voter: DUMMY_VOTER,
            votingEscrow: DUMMY_ESCROW,
            rewardsDistributor: DUMMY_DIST,
            token: DUMMY_TOKEN,
            router: DUMMY_ROUTER,
            maxPoolWeightWad: uint96(0.5e18),
            maxDeltaWad: uint96(2e18), // permissive default; guardrail tests tighten it
            rotationCooldown: 1 days
        });
    }

    function _deployDiamond() internal {
        vm.warp(1_752_000_000); // fixed genesis time for deterministic cooldown math
        // genesis cut executes as the deployer (this test contract), then ownership moves
        // to the Owner Safe, same sequence as Deploy.s.sol
        d = deployCore(address(this), _defaultConfig());
        IERC173(d.diamond).transferOwnership(OWNER);
    }

    /// @dev swap the live AerodromeFacet for MockAeroFacet through the sanctioned path
    function _cutInMockProtocol() internal {
        mockAeroFacet = address(new MockAeroFacet());
        IDiamond.FacetCut[] memory cuts = protocolSwapCut("AerodromeFacet", mockAeroFacet, "MockAeroFacet");
        vm.prank(OWNER);
        IDiamondCut(d.diamond).diamondCut(cuts, address(0), "");

        // default mock protocol parameters: 48h per-position cooldown (F1/F2)
        vm.startPrank(OWNER);
        MockAeroFacet(d.diamond).mockSetCooldown(48 hours, true);
        MockAeroFacet(d.diamond).mockAddPool(POOL_A, 1e15, 2e15, 3e15);
        MockAeroFacet(d.diamond).mockAddPool(POOL_B, 5e14, 1e15, 6e14);
        MockAeroFacet(d.diamond).mockAddPool(POOL_C, 0, 1e15, 0);
        vm.stopPrank();
    }

    function _allowPools() internal {
        vm.startPrank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_A, true);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_B, true);
        TargetsFacet(d.diamond).setPoolAllowed(POOL_C, true);
        vm.stopPrank();
    }

    function _setTarget5050() internal {
        address[] memory pools = new address[](2);
        pools[0] = POOL_A;
        pools[1] = POOL_B;
        uint256[] memory weights = new uint256[](2);
        weights[0] = 0.5e18;
        weights[1] = 0.5e18;
        vm.prank(STRATEGIST);
        TargetsFacet(d.diamond).setTargets(pools, weights, keccak256("strategy-config-v1"));
    }

    function _createTranche(uint256 amount) internal returns (uint256 trancheId) {
        vm.prank(OWNER);
        trancheId = TrancheFacet(d.diamond).createTranche(amount, 0);
    }
}
