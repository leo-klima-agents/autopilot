// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {TestBase} from "../helpers/TestBase.sol";
import {AccessFacet} from "../../src/facets/AccessFacet.sol";
import {IERC173} from "../../src/interfaces/IERC173.sol";
import {LibAccess} from "../../src/libraries/LibAccess.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";

/// @notice AccessFacet unit suite: grant/revoke/hasRole, owner-only mutation, the
///         implicit OWNER_ROLE of the ERC-173 diamond owner, and event emission.
contract AccessFacetTest is TestBase {
    // mirrors of LibAccess events for expectEmit
    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    address internal constant NEW_ACCOUNT = address(0xCAFE);

    bytes32 internal ownerRole;
    bytes32 internal strategistRole;
    bytes32 internal keeperRole;

    function setUp() public {
        _deployDiamond();
        ownerRole = AccessFacet(d.diamond).OWNER_ROLE();
        strategistRole = AccessFacet(d.diamond).STRATEGIST_ROLE();
        keeperRole = AccessFacet(d.diamond).KEEPER_ROLE();
    }

    // ------------------------------------------------------------------
    // genesis roles
    // ------------------------------------------------------------------

    function test_genesisRolesGranted() public view {
        assertTrue(AccessFacet(d.diamond).hasRole(strategistRole, STRATEGIST), "strategist");
        assertTrue(AccessFacet(d.diamond).hasRole(keeperRole, KEEPER), "keeper");
        assertFalse(AccessFacet(d.diamond).hasRole(keeperRole, OUTSIDER), "outsider has nothing");
        assertFalse(AccessFacet(d.diamond).hasRole(strategistRole, KEEPER), "roles do not bleed");
    }

    // ------------------------------------------------------------------
    // grant
    // ------------------------------------------------------------------

    function test_grant_setsRoleAndEmits() public {
        assertFalse(AccessFacet(d.diamond).hasRole(keeperRole, NEW_ACCOUNT));
        vm.expectEmit(d.diamond);
        emit RoleGranted(keeperRole, NEW_ACCOUNT, OWNER);
        vm.prank(OWNER);
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);
        assertTrue(AccessFacet(d.diamond).hasRole(keeperRole, NEW_ACCOUNT));
    }

    function test_grant_idempotent_noSecondEvent() public {
        vm.prank(OWNER);
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);
        vm.recordLogs();
        vm.prank(OWNER);
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "re-grant must not emit");
        assertTrue(AccessFacet(d.diamond).hasRole(keeperRole, NEW_ACCOUNT));
    }

    function test_grant_onlyDiamondOwner() public {
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, STRATEGIST, OWNER));
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, KEEPER, OWNER));
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, OUTSIDER, OWNER));
        AccessFacet(d.diamond).grantRole(keeperRole, NEW_ACCOUNT);
    }

    // ------------------------------------------------------------------
    // revoke
    // ------------------------------------------------------------------

    function test_revoke_clearsRoleAndEmits() public {
        vm.expectEmit(d.diamond);
        emit RoleRevoked(keeperRole, KEEPER, OWNER);
        vm.prank(OWNER);
        AccessFacet(d.diamond).revokeRole(keeperRole, KEEPER);
        assertFalse(AccessFacet(d.diamond).hasRole(keeperRole, KEEPER));
    }

    function test_revoke_nonGranted_noEvent() public {
        vm.recordLogs();
        vm.prank(OWNER);
        AccessFacet(d.diamond).revokeRole(keeperRole, NEW_ACCOUNT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 0, "revoking an ungranted role must not emit");
    }

    function test_revoke_onlyDiamondOwner() public {
        vm.prank(STRATEGIST);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, STRATEGIST, OWNER));
        AccessFacet(d.diamond).revokeRole(keeperRole, KEEPER);

        vm.prank(KEEPER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, KEEPER, OWNER));
        AccessFacet(d.diamond).revokeRole(keeperRole, KEEPER);

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, OUTSIDER, OWNER));
        AccessFacet(d.diamond).revokeRole(keeperRole, KEEPER);
    }

    // ------------------------------------------------------------------
    // OWNER_ROLE mirrors the ERC-173 owner implicitly
    // ------------------------------------------------------------------

    function test_ownerRole_implicitForDiamondOwner() public view {
        assertTrue(AccessFacet(d.diamond).hasRole(ownerRole, OWNER), "owner holds OWNER_ROLE implicitly");
        assertFalse(AccessFacet(d.diamond).hasRole(ownerRole, STRATEGIST));
        assertFalse(AccessFacet(d.diamond).hasRole(ownerRole, OUTSIDER));
    }

    function test_ownerRole_followsOwnershipTransfer() public {
        vm.prank(OWNER);
        IERC173(d.diamond).transferOwnership(NEW_ACCOUNT);
        assertTrue(AccessFacet(d.diamond).hasRole(ownerRole, NEW_ACCOUNT), "new owner picks up OWNER_ROLE");
        assertFalse(AccessFacet(d.diamond).hasRole(ownerRole, OWNER), "old owner loses implicit OWNER_ROLE");
    }

    function test_ownerRole_explicitGrantSurvivesQuery() public {
        // the owner can grant OWNER_ROLE explicitly to another account
        vm.prank(OWNER);
        AccessFacet(d.diamond).grantRole(ownerRole, NEW_ACCOUNT);
        assertTrue(AccessFacet(d.diamond).hasRole(ownerRole, NEW_ACCOUNT));
        vm.prank(OWNER);
        AccessFacet(d.diamond).revokeRole(ownerRole, NEW_ACCOUNT);
        assertFalse(AccessFacet(d.diamond).hasRole(ownerRole, NEW_ACCOUNT));
        // revoking cannot strip the implicit role of the ERC-173 owner
        vm.prank(OWNER);
        AccessFacet(d.diamond).revokeRole(ownerRole, OWNER);
        assertTrue(AccessFacet(d.diamond).hasRole(ownerRole, OWNER), "implicit OWNER_ROLE is not revocable");
    }
}
