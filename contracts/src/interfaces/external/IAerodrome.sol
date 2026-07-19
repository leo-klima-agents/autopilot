// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @dev Minimal Aerodrome v2 interfaces, only the functions this vault calls.
///      Signatures verified against aerodrome-finance/contracts (main). Addresses are
///      NEVER hardcoded here; they live in ProtocolConfigStorage, set by DiamondInit and
///      re-verified on-chain by the deploy script (Non-negotiable #2).

interface IAeroVoter {
    function vote(uint256 _tokenId, address[] calldata _poolVote, uint256[] calldata _weights) external;
    function reset(uint256 _tokenId) external;
    function poke(uint256 _tokenId) external;
    function claimBribes(address[] memory _bribes, address[][] memory _tokens, uint256 _tokenId) external;
    function claimFees(address[] memory _fees, address[][] memory _tokens, uint256 _tokenId) external;
    function lastVoted(uint256 tokenId) external view returns (uint256);
    function gauges(address pool) external view returns (address);
    function isAlive(address gauge) external view returns (bool);
}

interface IAeroVotingEscrow {
    function createLock(uint256 _value, uint256 _lockDuration) external returns (uint256);
    function lockPermanent(uint256 _tokenId) external;
    function increaseAmount(uint256 _tokenId, uint256 _value) external;
    function balanceOfNFT(uint256 _tokenId) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function safeTransferFrom(address from, address to, uint256 tokenId) external;
}

interface IAeroRewardsDistributor {
    function claim(uint256 _tokenId) external returns (uint256);
    function claimable(uint256 _tokenId) external view returns (uint256);
}

interface IAeroRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}
