// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev DRAFT v3 (Aero) interfaces transcribed from dromos-labs/metadex-specs Idea Drafts
///      (ARCHITECTURE.md F22). The specs publish NO real signatures; these are pseudo-call
///      shapes from the mermaid diagrams and WILL be rewritten against the code drops
///      starting Aug 3 (P8). Nothing here may be treated as final; AeroFacet is compiled
///      for shape only and is never part of the default deployment manifest.

interface IAeroV3VotingEscrowDraft {
    /// @dev voting-escrow.md: stake creation takes integer weeks + permanent opt-in flag
    function createStake(uint256 amount, uint256 durationWeeks, bool permanent) external returns (uint256 tokenId);
    function increaseAmount(uint256 tokenId, uint256 amount) external;
    function stakingWeight(uint256 tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IAeroV3VoterDraft {
    /// @dev leaf-voter.md pseudo-signature simplified to the single-chain (Base) case
    function vote(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external;
    function reset(uint256 tokenId) external;
    /// @dev voter.md §9: cooldown set on root Voter, globally uniform
    function allocationCooldown() external view returns (uint64);
    /// @dev granularity per PA-FAQ (F2): per-position. NOT in the spec drafts, assumed.
    function lastAllocated(uint256 tokenId) external view returns (uint64);
}

interface IAeroV3RewardsDraft {
    /// @dev gauge.md: getReward(account); tokenId-scoped shape assumed for allocator revenue
    function getReward(uint256 tokenId) external;
    function earned(uint256 tokenId) external view returns (uint256);
}
