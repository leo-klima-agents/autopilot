// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaultStorage} from "../../libraries/LibVaultStorage.sol";
import {LibAccess} from "../../libraries/LibAccess.sol";
import {IProtocolFacet} from "../../interfaces/IProtocolFacet.sol";
import {
    IAeroV3VotingEscrowDraft,
    IAeroV3VoterDraft,
    IAeroV3RewardsDraft
} from "../../interfaces/external/IAeroV3Draft.sol";

/// @title AeroFacet, ⚠️ DRAFT (M2), rewrite against published code before any funds move
/// @notice v3 (Aero) integration drafted from the metadex-specs Idea Drafts. Expect to
///         write this facet twice (P8): this draft fixes the SHAPE, createStake with the
///         permanent opt-in (F8), continuous allocation under a per-position cooldown
///         (F1/F2), streamed revenue claims (F10), while every external signature is
///         provisional (F22). The September protocol transition is a single diamondCut
///         swapping AerodromeFacet's selectors for this facet's.
/// @dev NOT in the default deployment manifest. Fork-test against published Aero code
///      before cutting (OPERATIONS.md §4, "protocol facet mismatch at Aero launch").
contract AeroFacet is IProtocolFacet {
    using SafeERC20 for IERC20;

    error DraftNotFinalized();

    /// @dev claim payload: reward contracts to pull from (composed off-chain, P1)
    struct ClaimData {
        address[] rewardContracts;
    }

    function protocolId() external pure returns (bytes32) {
        return keccak256("aero-v3-draft");
    }

    /// @inheritdoc IProtocolFacet
    function createStake(uint256 amount, uint256 duration, bool permanent) external returns (uint256 tokenId) {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.ProtocolConfigStorage storage cfg = LibVaultStorage.protocolConfig();
        IERC20(cfg.token).forceApprove(cfg.votingEscrow, amount);
        // voting-escrow.md: durations are integer weeks; permanent ignores duration (F8/F17)
        tokenId = IAeroV3VotingEscrowDraft(cfg.votingEscrow).createStake(amount, duration / 1 weeks, permanent);
    }

    /// @inheritdoc IProtocolFacet
    function allocate(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external {
        LibAccess.enforceSelfOrOwner();
        IAeroV3VoterDraft(LibVaultStorage.protocolConfig().voter).vote(tokenId, pools, weights);
    }

    /// @inheritdoc IProtocolFacet
    function resetAllocation(uint256 tokenId) external {
        LibAccess.enforceSelfOrOwner();
        IAeroV3VoterDraft(LibVaultStorage.protocolConfig().voter).reset(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    function claim(uint256 tokenId, bytes calldata data) external {
        LibAccess.enforceSelfOrOwner();
        ClaimData memory c = abi.decode(data, (ClaimData));
        for (uint256 i; i < c.rewardContracts.length; ++i) {
            IAeroV3RewardsDraft(c.rewardContracts[i]).getReward(tokenId);
        }
    }

    /// @inheritdoc IProtocolFacet
    /// @dev v3 compounding is expected to route through the MetaRouter batch flow (F16);
    ///      the draft cannot bind to an unpublished command encoding, finalize at M5.
    function compound(uint256, uint256, bytes calldata) external returns (uint256) {
        LibAccess.enforceSelfOrOwner();
        revert DraftNotFinalized();
    }

    /// @inheritdoc IProtocolFacet
    function positionWeight(uint256 tokenId) external view returns (uint256) {
        return IAeroV3VotingEscrowDraft(LibVaultStorage.protocolConfig().votingEscrow).stakingWeight(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    function cooldownRemaining(uint256 tokenId) external view returns (uint256) {
        IAeroV3VoterDraft voter = IAeroV3VoterDraft(LibVaultStorage.protocolConfig().voter);
        uint64 last = voter.lastAllocated(tokenId);
        if (last == 0) return 0;
        uint64 readyAt = last + voter.allocationCooldown();
        return block.timestamp >= readyAt ? 0 : readyAt - block.timestamp;
    }

    /// @inheritdoc IProtocolFacet
    function protocolCooldown() external view returns (uint64) {
        return IAeroV3VoterDraft(LibVaultStorage.protocolConfig().voter).allocationCooldown();
    }

    /// @inheritdoc IProtocolFacet
    /// @dev continuous: always open (F9)
    function allocationWindow() external view returns (uint64 opensAt, uint64 closesAt) {
        return (uint64(block.timestamp), type(uint64).max);
    }
}
