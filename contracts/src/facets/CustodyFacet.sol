// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {LibVaultStorage} from "../libraries/LibVaultStorage.sol";
import {LibAccess} from "../libraries/LibAccess.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";

/// @title CustodyFacet
/// @notice ERC-721 receipt gated to the configured escrow, plus owner rescue of any
///         NFT/token, a feature under single-owner custody (P6), not a bug. Custody
///         state never moves: every upgrade is a facet swap around the NFTs.
contract CustodyFacet {
    using SafeERC20 for IERC20;

    event NFTReceived(address indexed collection, address indexed from, uint256 indexed tokenId);
    event NFTRescued(address indexed collection, uint256 indexed tokenId, address indexed to);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    error UnexpectedCollection(address collection);

    /// @notice accept position NFTs only from the configured escrow collection
    function onERC721Received(address, address from, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender != LibVaultStorage.custody().acceptedCollection) {
            revert UnexpectedCollection(msg.sender);
        }
        emit NFTReceived(msg.sender, from, tokenId);
        return this.onERC721Received.selector;
    }

    function acceptedCollection() external view returns (address) {
        return LibVaultStorage.custody().acceptedCollection;
    }

    /// @notice Owner-only escape hatch for any NFT, including position NFTs during the
    ///         September migration (exit → migrate → re-stake, OPERATIONS.md §4).
    function rescueERC721(address collection, uint256 tokenId, address to) external {
        LibDiamond.enforceIsContractOwner();
        IERC721(collection).safeTransferFrom(address(this), to, tokenId);
        emit NFTRescued(collection, tokenId, to);
    }

    /// @notice Owner-only escape hatch for any ERC-20 held by the diamond.
    function rescueERC20(address token, uint256 amount, address to) external {
        LibDiamond.enforceIsContractOwner();
        IERC20(token).safeTransfer(to, amount);
        emit TokenRescued(token, amount, to);
    }
}
