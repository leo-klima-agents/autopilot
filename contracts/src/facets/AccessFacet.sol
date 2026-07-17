// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibAccess} from "../libraries/LibAccess.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/// @title AccessFacet
/// @notice Grant/revoke for OWNER (Owner Safe), STRATEGIST (Strategist Safe) and KEEPER
///         (hot key). Only the diamond owner (ERC-173, the Owner Safe) may mutate roles.
contract AccessFacet {
    function grantRole(bytes32 role, address account) external {
        LibDiamond.enforceIsContractOwner();
        LibAccess.grantRole(role, account);
    }

    function revokeRole(bytes32 role, address account) external {
        LibDiamond.enforceIsContractOwner();
        LibAccess.revokeRole(role, account);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return LibAccess.hasRole(role, account);
    }

    function OWNER_ROLE() external pure returns (bytes32) {
        return LibAccess.OWNER_ROLE;
    }

    function STRATEGIST_ROLE() external pure returns (bytes32) {
        return LibAccess.STRATEGIST_ROLE;
    }

    function KEEPER_ROLE() external pure returns (bytes32) {
        return LibAccess.KEEPER_ROLE;
    }
}
