// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @title IProtocolFacet
/// @notice The selector set every protocol facet implements (P8). Everything spec-derived
///         is quarantined behind this interface: swapping Aerodrome v2 for Aero v3 is a
///         single diamondCut replacing one facet's selectors with another's.
/// @dev Mutators are gated to self-call (from Tranche/Execution facets) or the Owner.
///      `data` parameters carry protocol-specific payloads composed off-chain by the
///      keeper (P1): claim routes, swap routes. The facet validates and executes; it never
///      originates a decision.
interface IProtocolFacet {
    /// @notice identifies the live integration, e.g. keccak256("aerodrome-v2")
    function protocolId() external view returns (bytes32);

    /// @notice create a position from `amount` of the protocol token held by the diamond
    /// @param duration lock duration in seconds (ignored when `permanent` on protocols
    ///        with a creation-time permanent flag; v2 creates then locks permanent)
    function createStake(uint256 amount, uint256 duration, bool permanent) external returns (uint256 tokenId);

    /// @notice replace the position's allocation with pools/weights (relative weights)
    function allocate(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external;

    /// @notice clear the position's allocation
    function resetAllocation(uint256 tokenId) external;

    /// @notice claim fees/bribes/rebase per the protocol-specific `data` payload
    function claim(uint256 tokenId, bytes calldata data) external;

    /// @notice swap claimed rewards to the protocol token and increase the stake
    /// @param data protocol-specific swap routing composed off-chain
    /// @return added amount of protocol token added to the position
    function compound(uint256 tokenId, uint256 minAmountOut, bytes calldata data) external returns (uint256 added);

    /// @notice current allocating weight of the position
    function positionWeight(uint256 tokenId) external view returns (uint256);

    /// @notice seconds until the position may re-allocate (0 = free now)
    function cooldownRemaining(uint256 tokenId) external view returns (uint256);

    /// @notice protocol-enforced minimum between allocation changes, in seconds
    ///         (v2: one epoch; v3: the allocation cooldown)
    function protocolCooldown() external view returns (uint64);

    /// @notice the window in which allocation is currently permitted
    /// @return opensAt earliest timestamp allocation is allowed (now if already open)
    /// @return closesAt last timestamp allocation is allowed (type(uint64).max = no close)
    function allocationWindow() external view returns (uint64 opensAt, uint64 closesAt);
}
