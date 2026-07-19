// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DiamondBuilder} from "./util/DiamondBuilder.sol";
import {IDiamond} from "../src/interfaces/IDiamond.sol";
import {IDiamondCut} from "../src/interfaces/IDiamondCut.sol";
import {DiamondInit} from "../src/init/DiamondInit.sol";
import {AeroFacet} from "../src/facets/protocol/AeroFacet.sol";
import {MockAeroFacet} from "../src/facets/protocol/MockAeroFacet.sol";

/// @title Cut
/// @notice The ONLY sanctioned path for protocol-facet swaps (OPERATIONS.md §5): every
///         cut goes PR → CI (upgrade tests + manifest diff) → Sepolia rehearsal → Owner
///         Safe signatures over this exact calldata → execution → loupe diff.
///
/// This script PRINTS the cut calldata for the Owner Safe by default; it broadcasts only
/// when the deployer key IS the diamond owner (dev/test chains).
///
/// Required env:
///   DIAMOND           , the diamond address
///   OLD_PROTOCOL_FACET, manifest name of the live protocol facet (e.g. AerodromeFacet)
///   NEW_PROTOCOL_FACET, manifest name to cut in (MockAeroFacet | AeroFacet)
///   SWAP_ID           , unique id for the idempotent init, e.g. "aero.autopilot.swap.2026-09-launch"
///   NEW_VOTER, NEW_VOTING_ESCROW, NEW_REWARDS_DISTRIBUTOR, NEW_TOKEN, NEW_ROUTER
contract Cut is Script, DiamondBuilder {
    function run() external {
        address diamond = vm.envAddress("DIAMOND");
        string memory oldName = vm.envString("OLD_PROTOCOL_FACET");
        string memory newName = vm.envString("NEW_PROTOCOL_FACET");

        vm.startBroadcast();
        address newFacet = _deployByName(newName);

        IDiamond.FacetCut[] memory cuts = protocolSwapCut(oldName, newFacet, newName);
        bytes memory initCalldata = abi.encodeCall(
            DiamondInit.initProtocolSwap,
            (
                keccak256(bytes(vm.envString("SWAP_ID"))),
                vm.envAddress("NEW_VOTER"),
                vm.envAddress("NEW_VOTING_ESCROW"),
                vm.envAddress("NEW_REWARDS_DISTRIBUTOR"),
                vm.envAddress("NEW_TOKEN"),
                vm.envAddress("NEW_ROUTER")
            )
        );
        address init = address(new DiamondInit());

        bytes memory cutCalldata = abi.encodeCall(IDiamondCut.diamondCut, (cuts, init, initCalldata));
        console.log("new protocol facet:", newFacet);
        console.log("init:", init);
        console.log("diamondCut calldata for the Owner Safe (target = diamond):");
        console.logBytes(cutCalldata);

        // broadcast directly only when the sender owns the diamond (dev chains)
        (bool ok, bytes memory ownerData) = diamond.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && abi.decode(ownerData, (address)) == msg.sender) {
            (bool success,) = diamond.call(cutCalldata);
            require(success, "diamondCut failed");
            console.log("cut executed directly (sender is diamond owner)");
        } else {
            console.log("sender is not the diamond owner - submit the calldata via the Owner Safe");
        }
        vm.stopBroadcast();
    }

    function _deployByName(string memory name) private returns (address) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("AeroFacet")) return address(new AeroFacet());
        if (h == keccak256("MockAeroFacet")) return address(new MockAeroFacet());
        revert("Cut: unsupported NEW_PROTOCOL_FACET");
    }
}
