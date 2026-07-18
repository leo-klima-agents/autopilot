// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaultStorage} from "../../libraries/LibVaultStorage.sol";
import {LibAccess} from "../../libraries/LibAccess.sol";
import {IProtocolFacet} from "../../interfaces/IProtocolFacet.sol";
import {
    IAeroVoter,
    IAeroVotingEscrow,
    IAeroRewardsDistributor,
    IAeroRouter
} from "../../interfaces/external/IAerodrome.sol";

/// @title AerodromeFacet
/// @notice Live Aerodrome v2 integration (Base). v2 semantics this facet encodes
///         (asserted empirically in the fork suite, not trusted from docs):
///         - one allocation change per epoch (`AlreadyVotedOrDeposited`, A4)
///         - voting blocked in the first hour of an epoch (`DistributeWindow`, A2)
///         - permanent locks carry constant weight (A7)
contract AerodromeFacet is IProtocolFacet {
    using SafeERC20 for IERC20;

    uint256 private constant WEEK = 7 days;
    /// @dev v2 maximum lock — permanent stakes are created at max then locked permanent
    uint256 private constant MAXTIME = 4 * 365 days;

    /// @dev claim payload composed off-chain by the keeper (P1)
    struct ClaimData {
        address[] bribes;
        address[][] bribeTokens;
        address[] fees;
        address[][] feeTokens;
        bool claimRebase;
    }

    /// @dev compound payload: for each reward token, a swap route to AERO
    struct SwapLeg {
        address tokenIn;
        IAeroRouter.Route[] routes;
    }

    error NothingToCompound();
    error InsufficientOutput(uint256 got, uint256 want);

    function protocolId() external pure returns (bytes32) {
        return keccak256("aerodrome-v2");
    }

    /// @inheritdoc IProtocolFacet
    function createStake(uint256 amount, uint256 duration, bool permanent) external returns (uint256 tokenId) {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.ProtocolConfigStorage storage cfg = LibVaultStorage.protocolConfig();
        IERC20(cfg.token).forceApprove(cfg.votingEscrow, amount);
        tokenId = IAeroVotingEscrow(cfg.votingEscrow).createLock(amount, permanent ? MAXTIME : duration);
        if (permanent) IAeroVotingEscrow(cfg.votingEscrow).lockPermanent(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    function allocate(uint256 tokenId, address[] calldata pools, uint256[] calldata weights) external {
        LibAccess.enforceSelfOrOwner();
        IAeroVoter(LibVaultStorage.protocolConfig().voter).vote(tokenId, pools, weights);
    }

    /// @inheritdoc IProtocolFacet
    function resetAllocation(uint256 tokenId) external {
        LibAccess.enforceSelfOrOwner();
        IAeroVoter(LibVaultStorage.protocolConfig().voter).reset(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    function claim(uint256 tokenId, bytes calldata data) external {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.ProtocolConfigStorage storage cfg = LibVaultStorage.protocolConfig();
        ClaimData memory c = abi.decode(data, (ClaimData));
        if (c.bribes.length > 0) IAeroVoter(cfg.voter).claimBribes(c.bribes, c.bribeTokens, tokenId);
        if (c.fees.length > 0) IAeroVoter(cfg.voter).claimFees(c.fees, c.feeTokens, tokenId);
        // rebase auto-compounds into the permanent lock via depositFor (A8)
        if (c.claimRebase) IAeroRewardsDistributor(cfg.rewardsDistributor).claim(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    function compound(uint256 tokenId, uint256 minAmountOut, bytes calldata data) external returns (uint256 added) {
        LibAccess.enforceSelfOrOwner();
        LibVaultStorage.ProtocolConfigStorage storage cfg = LibVaultStorage.protocolConfig();
        SwapLeg[] memory legs = abi.decode(data, (SwapLeg[]));

        uint256 before = IERC20(cfg.token).balanceOf(address(this));
        for (uint256 i; i < legs.length; ++i) {
            uint256 bal = IERC20(legs[i].tokenIn).balanceOf(address(this));
            if (bal == 0) continue;
            IERC20(legs[i].tokenIn).forceApprove(cfg.router, bal);
            // per-leg minOut is 0; the aggregate is enforced below against minAmountOut
            IAeroRouter(cfg.router).swapExactTokensForTokens(bal, 0, legs[i].routes, address(this), block.timestamp);
        }
        added = IERC20(cfg.token).balanceOf(address(this)) - before;
        if (added < minAmountOut) revert InsufficientOutput(added, minAmountOut);
        if (added == 0) revert NothingToCompound();

        IERC20(cfg.token).forceApprove(cfg.votingEscrow, added);
        IAeroVotingEscrow(cfg.votingEscrow).increaseAmount(tokenId, added);
    }

    /// @inheritdoc IProtocolFacet
    function positionWeight(uint256 tokenId) external view returns (uint256) {
        return IAeroVotingEscrow(LibVaultStorage.protocolConfig().votingEscrow).balanceOfNFT(tokenId);
    }

    /// @inheritdoc IProtocolFacet
    /// @dev v2: a position that voted this epoch is locked until the flip; the distribute
    ///         window (first hour) also blocks. Returns the later constraint.
    function cooldownRemaining(uint256 tokenId) external view returns (uint256) {
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        uint256 lastVoted = IAeroVoter(LibVaultStorage.protocolConfig().voter).lastVoted(tokenId);
        uint256 readyAt;
        if (lastVoted >= epochStart) {
            // voted this epoch: free at next flip + 1h distribute window
            readyAt = epochStart + WEEK + 1 hours;
        } else if (block.timestamp < epochStart + 1 hours) {
            readyAt = epochStart + 1 hours;
        } else {
            return 0;
        }
        return readyAt - block.timestamp;
    }

    /// @inheritdoc IProtocolFacet
    function protocolCooldown() external pure returns (uint64) {
        return uint64(WEEK);
    }

    /// @inheritdoc IProtocolFacet
    /// @dev vote window is [epochStart+1h, epochStart+WEEK-1h); the last hour is
    ///      whitelist-only (A3) which this vault does not assume it has
    function allocationWindow() external view returns (uint64 opensAt, uint64 closesAt) {
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        uint256 voteStart = epochStart + 1 hours;
        opensAt = uint64(block.timestamp < voteStart ? voteStart : block.timestamp);
        closesAt = uint64(epochStart + WEEK - 1 hours);
    }
}
