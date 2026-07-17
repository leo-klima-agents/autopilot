// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice minimal mintable ERC-721 for CustodyFacet rescue-path tests
/// @dev mint uses _mint (no receiver hook) so tokens can be placed into the diamond
///      directly — the diamond's onERC721Received only accepts the configured escrow.
contract MockERC721 is ERC721 {
    constructor() ERC721("Mock NFT", "MNFT") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }
}
