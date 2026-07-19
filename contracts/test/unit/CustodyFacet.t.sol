// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {TestBase} from "../helpers/TestBase.sol";
import {CustodyFacet} from "../../src/facets/CustodyFacet.sol";
import {NotContractOwner} from "../../src/libraries/LibDiamond.sol";
import {MockERC20} from "../mocks/MockERC20.sol";
import {MockERC721} from "../mocks/MockERC721.sol";

/// @notice CustodyFacet unit suite: escrow-gated ERC-721 receipt and the owner-only
///         rescue escape hatches, with real token transfers asserted.
contract CustodyFacetTest is TestBase {
    event NFTReceived(address indexed collection, address indexed from, uint256 indexed tokenId);
    event NFTRescued(address indexed collection, uint256 indexed tokenId, address indexed to);
    event TokenRescued(address indexed token, uint256 amount, address indexed to);

    address internal constant RECIPIENT = address(0xBEEF);

    MockERC20 internal token;
    MockERC721 internal nft;

    function setUp() public {
        _deployDiamond();
        token = new MockERC20();
        nft = new MockERC721();
    }

    // ------------------------------------------------------------------
    // onERC721Received, msg.sender must be the accepted collection
    // ------------------------------------------------------------------

    function test_acceptedCollection_isEscrow() public view {
        assertEq(CustodyFacet(d.diamond).acceptedCollection(), DUMMY_ESCROW);
    }

    function test_onERC721Received_acceptsEscrowCollection() public {
        vm.expectEmit(d.diamond);
        emit NFTReceived(DUMMY_ESCROW, address(0xF00D), 42);
        vm.prank(DUMMY_ESCROW);
        bytes4 ret = CustodyFacet(d.diamond).onERC721Received(address(0), address(0xF00D), 42, "");
        assertEq(ret, CustodyFacet.onERC721Received.selector);
    }

    function test_onERC721Received_rejectsOtherCollections() public {
        vm.prank(address(nft));
        vm.expectRevert(abi.encodeWithSelector(CustodyFacet.UnexpectedCollection.selector, address(nft)));
        CustodyFacet(d.diamond).onERC721Received(address(0), address(0xF00D), 1, "");

        vm.prank(OUTSIDER);
        vm.expectRevert(abi.encodeWithSelector(CustodyFacet.UnexpectedCollection.selector, OUTSIDER));
        CustodyFacet(d.diamond).onERC721Received(address(0), address(0xF00D), 1, "");
    }

    // ------------------------------------------------------------------
    // rescueERC721
    // ------------------------------------------------------------------

    function test_rescueERC721_transfersOut() public {
        nft.mint(d.diamond, 7);
        assertEq(nft.ownerOf(7), d.diamond);

        vm.expectEmit(d.diamond);
        emit NFTRescued(address(nft), 7, RECIPIENT);
        vm.prank(OWNER);
        CustodyFacet(d.diamond).rescueERC721(address(nft), 7, RECIPIENT);

        assertEq(nft.ownerOf(7), RECIPIENT, "NFT must land at recipient");
    }

    function test_rescueERC721_nonOwnerReverts() public {
        nft.mint(d.diamond, 7);
        address[3] memory callers = [STRATEGIST, KEEPER, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, callers[i], OWNER));
            CustodyFacet(d.diamond).rescueERC721(address(nft), 7, RECIPIENT);
        }
        assertEq(nft.ownerOf(7), d.diamond, "NFT stays in custody");
    }

    // ------------------------------------------------------------------
    // rescueERC20
    // ------------------------------------------------------------------

    function test_rescueERC20_transfersOut() public {
        token.mint(d.diamond, 100e18);

        vm.expectEmit(d.diamond);
        emit TokenRescued(address(token), 40e18, RECIPIENT);
        vm.prank(OWNER);
        CustodyFacet(d.diamond).rescueERC20(address(token), 40e18, RECIPIENT);

        assertEq(token.balanceOf(RECIPIENT), 40e18, "recipient credited");
        assertEq(token.balanceOf(d.diamond), 60e18, "diamond debited");
    }

    function test_rescueERC20_nonOwnerReverts() public {
        token.mint(d.diamond, 100e18);
        address[3] memory callers = [STRATEGIST, KEEPER, OUTSIDER];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(NotContractOwner.selector, callers[i], OWNER));
            CustodyFacet(d.diamond).rescueERC20(address(token), 40e18, RECIPIENT);
        }
        assertEq(token.balanceOf(d.diamond), 100e18, "funds stay in custody");
    }
}
