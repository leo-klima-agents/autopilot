// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibVaultStorage} from "./LibVaultStorage.sol";
import {LibDiamond} from "./LibDiamond.sol";

/// @title LibAccess
/// @notice Role management over namespaced storage. Reimplements OZ AccessControl logic
///         without its linear storage layout (P5): stock OZ AccessControl is unsafe in a
///         diamond.
/// @dev Root authority is the ERC-173 diamond owner (the Owner Safe, via LibDiamond).
///      OWNER_ROLE mirrors it for uniform role queries; grant/revoke of any role is
///      restricted to the diamond owner.
library LibAccess {
    /// @dev the Owner Safe — diamondCut, parameters, rescues, migration
    bytes32 internal constant OWNER_ROLE = keccak256("aero.autopilot.role.owner");
    /// @dev the Strategist Safe — submits target allocations
    bytes32 internal constant STRATEGIST_ROLE = keccak256("aero.autopilot.role.strategist");
    /// @dev hot key — mechanical, guardrail-bounded execution, no discretion
    bytes32 internal constant KEEPER_ROLE = keccak256("aero.autopilot.role.keeper");

    event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
    event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

    error MissingRole(bytes32 role, address account);
    error NotSelfOrOwner(address caller);

    function hasRole(bytes32 role, address account) internal view returns (bool) {
        if (role == OWNER_ROLE && account == LibDiamond.contractOwner()) return true;
        return LibVaultStorage.access().hasRole[role][account];
    }

    function enforceRole(bytes32 role, address account) internal view {
        if (!hasRole(role, account)) revert MissingRole(role, account);
    }

    /// @dev gate for protocol-facet mutators: reachable via internal self-call from
    ///      Tranche/Execution facets (msg.sender == diamond) or directly by the owner.
    function enforceSelfOrOwner() internal view {
        if (msg.sender != address(this) && !hasRole(OWNER_ROLE, msg.sender)) {
            revert NotSelfOrOwner(msg.sender);
        }
    }

    function grantRole(bytes32 role, address account) internal {
        LibVaultStorage.AccessStorage storage s = LibVaultStorage.access();
        if (!s.hasRole[role][account]) {
            s.hasRole[role][account] = true;
            emit RoleGranted(role, account, msg.sender);
        }
    }

    function revokeRole(bytes32 role, address account) internal {
        LibVaultStorage.AccessStorage storage s = LibVaultStorage.access();
        if (s.hasRole[role][account]) {
            s.hasRole[role][account] = false;
            emit RoleRevoked(role, account, msg.sender);
        }
    }
}
