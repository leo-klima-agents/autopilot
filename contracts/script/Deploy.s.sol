// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {DiamondBuilder} from "./util/DiamondBuilder.sol";
import {DiamondInit} from "../src/init/DiamondInit.sol";
import {IERC173} from "../src/interfaces/IERC173.sol";

interface IVoterProbe {
    function ve() external view returns (address);
}

interface IEscrowProbe {
    function token() external view returns (address);
}

/// @title Deploy
/// @notice Deploys the diamond + full facet set, runs the genesis init, then hands
///         ownership to the Owner Safe. Addresses come from the environment and are
///         probed on-chain before use (Non-negotiable #2), never from docs.
///
/// Required env:
///   OWNER_SAFE, STRATEGIST_SAFE, KEEPER_ADDRESS
///   AERODROME_VOTER, AERODROME_VOTING_ESCROW, AERODROME_REWARDS_DISTRIBUTOR,
///   AERO_TOKEN, AERODROME_ROUTER
/// Optional env (defaults):
///   MAX_POOL_WEIGHT_WAD (0.5e18), MAX_DELTA_WAD (0.6e18), ROTATION_COOLDOWN (7 days)
contract Deploy is Script, DiamondBuilder {
    function run() external {
        address ownerSafe = vm.envAddress("OWNER_SAFE");

        DiamondInit.InitConfig memory cfg = DiamondInit.InitConfig({
            strategistSafe: vm.envAddress("STRATEGIST_SAFE"),
            keeper: vm.envAddress("KEEPER_ADDRESS"),
            voter: vm.envAddress("AERODROME_VOTER"),
            votingEscrow: vm.envAddress("AERODROME_VOTING_ESCROW"),
            rewardsDistributor: vm.envAddress("AERODROME_REWARDS_DISTRIBUTOR"),
            token: vm.envAddress("AERO_TOKEN"),
            router: vm.envAddress("AERODROME_ROUTER"),
            maxPoolWeightWad: uint96(vm.envOr("MAX_POOL_WEIGHT_WAD", uint256(0.5e18))),
            maxDeltaWad: uint96(vm.envOr("MAX_DELTA_WAD", uint256(0.6e18))),
            rotationCooldown: uint64(vm.envOr("ROTATION_COOLDOWN", uint256(7 days)))
        });

        // on-chain probes: the voter must point at the escrow, the escrow at the token
        require(IVoterProbe(cfg.voter).ve() == cfg.votingEscrow, "probe: voter.ve() != votingEscrow");
        require(IEscrowProbe(cfg.votingEscrow).token() == cfg.token, "probe: escrow.token() != token");
        require(cfg.rewardsDistributor.code.length > 0, "probe: rewardsDistributor has no code");
        require(cfg.router.code.length > 0, "probe: router has no code");

        vm.startBroadcast();
        // the genesis cut is sent by the broadcaster, so the diamond starts
        // broadcaster-owned and is handed to the Owner Safe as the final step
        (, address broadcaster,) = vm.readCallers();
        Deployed memory d = deployCore(broadcaster, cfg);
        IERC173(d.diamond).transferOwnership(ownerSafe);
        vm.stopBroadcast();

        console.log("diamond           ", d.diamond);
        console.log("diamondInit       ", d.diamondInit);
        console.log("DiamondCutFacet   ", d.cutFacet);
        console.log("DiamondLoupeFacet ", d.loupeFacet);
        console.log("OwnershipFacet    ", d.ownershipFacet);
        console.log("AccessFacet       ", d.accessFacet);
        console.log("CustodyFacet      ", d.custodyFacet);
        console.log("TrancheFacet      ", d.trancheFacet);
        console.log("TargetsFacet      ", d.targetsFacet);
        console.log("ExecutionFacet    ", d.executionFacet);
        console.log("AerodromeFacet    ", d.aerodromeFacet);
        console.log("owner (pending accept-less ERC-173 transfer):", ownerSafe);
        console.log("next: record addresses in facets.json, verify via Sourcify (OPERATIONS.md 6)");
    }
}
