// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";

/// @title ManifestLib
/// @notice Reads contracts/facets.json (the off-chain mirror of the loupe) so deploy
///         scripts, cut scripts, and the diamond test suite all cut the exact selector
///         sets that CI checked (no hand-maintained selector arrays to drift).
library ManifestLib {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function selectorsOf(string memory facetName) internal view returns (bytes4[] memory selectors) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/facets.json"));
        for (uint256 i; vm.keyExistsJson(json, string.concat(".facets[", vm.toString(i), "]")); ++i) {
            string memory prefix = string.concat(".facets[", vm.toString(i), "]");
            string memory name = vm.parseJsonString(json, string.concat(prefix, ".name"));
            if (keccak256(bytes(name)) != keccak256(bytes(facetName))) continue;
            string[] memory raw = vm.parseJsonStringArray(json, string.concat(prefix, ".selectorList"));
            selectors = new bytes4[](raw.length);
            for (uint256 j; j < raw.length; ++j) {
                selectors[j] = bytes4(vm.parseBytes(raw[j]));
            }
            return selectors;
        }
        revert(string.concat("ManifestLib: facet not in facets.json: ", facetName));
    }
}
