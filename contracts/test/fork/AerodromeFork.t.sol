// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {DiamondBuilder} from "../../script/util/DiamondBuilder.sol";
import {DiamondInit} from "../../src/init/DiamondInit.sol";
import {IDiamondCut} from "../../src/interfaces/IDiamondCut.sol";
import {IERC173} from "../../src/interfaces/IERC173.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {CustodyFacet} from "../../src/facets/CustodyFacet.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {AerodromeFacet} from "../../src/facets/protocol/AerodromeFacet.sol";
import {IAeroVoter, IAeroVotingEscrow, IAeroRouter} from "../../src/interfaces/external/IAerodrome.sol";

interface IVoterProbe {
    function ve() external view returns (address);
}

interface IEscrowProbe {
    function token() external view returns (address);
    function ownerOf(uint256) external view returns (address);
    function safeTransferFrom(address, address, uint256) external;
    function balanceOfNFT(uint256) external view returns (uint256);
}

interface IPoolFactoryProbe {
    function allPoolsLength() external view returns (uint256);
    function allPools(uint256) external view returns (address);
}

interface IPoolProbe {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function stable() external view returns (bool);
}

interface IMinterProbe {
    function updatePeriod() external returns (uint256);
}

// Aerodrome Voter custom errors, asserted empirically (§8.3), never assumed from docs
error AlreadyVotedOrDeposited();
error DistributeWindow();

/// @notice The money path end-to-end against REAL Aerodrome through the diamond, at a
///         pinned Base block: create lock → vote → warp across the epoch flip → claim →
///         compound → re-vote, plus the v2 constraint assertions and a mid-lifecycle
///         facet swap. Skips itself when BASE_RPC_URL is unset so `forge test` stays
///         offline-green; CI runs it nightly and on labeled PRs (fork-tests.yml).
contract AerodromeForkTest is Test, DiamondBuilder {
    // Base mainnet addresses (ARCHITECTURE.md A10, README deployment table,
    // cross-checked against sugar deployments/base.env; probed on-chain in setUp)
    address internal constant VOTER = 0x16613524e02ad97eDfeF371bC883F2F5d6C480A5;
    address internal constant VOTING_ESCROW = 0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4;
    address internal constant AERO = 0x940181a94A35A4569E4529A3CDfB74e38FD98631;
    address internal constant REWARDS_DIST = 0x227f65131A261548b057215bB1D5Ab2997964C7d;
    address internal constant ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant POOL_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;
    address internal constant MINTER = 0xeB018363F0a9Af8f91F06FEe6613a751b2A33FE5;

    uint256 internal constant PINNED_BLOCK = 48_700_000;
    uint256 internal constant WEEK = 7 days;

    address internal constant OWNER = address(0xA11CE);
    address internal constant STRATEGIST = address(0x57121);
    address internal constant KEEPER = address(0x6EE6);

    Deployed internal d;
    address[] internal votePools;

    modifier onlyForked() {
        if (bytes(vm.envOr("BASE_RPC_URL", string(""))).length == 0) {
            vm.skip(true);
        }
        _;
    }

    function setUp() public {
        if (bytes(vm.envOr("BASE_RPC_URL", string(""))).length == 0) return;
        vm.createSelectFork(vm.rpcUrl("base"), PINNED_BLOCK);

        // probe before trusting (Non-negotiable #2)
        assertEq(IVoterProbe(VOTER).ve(), VOTING_ESCROW, "probe: voter.ve");
        assertEq(IEscrowProbe(VOTING_ESCROW).token(), AERO, "probe: escrow.token");

        d = deployCore(
            address(this),
            DiamondInit.InitConfig({
                strategistSafe: STRATEGIST,
                keeper: KEEPER,
                voter: VOTER,
                votingEscrow: VOTING_ESCROW,
                rewardsDistributor: REWARDS_DIST,
                token: AERO,
                router: ROUTER,
                maxPoolWeightWad: uint96(0.8e18),
                maxDeltaWad: uint96(2e18),
                rotationCooldown: 1 hours // vault guardrail loose here: the PROTOCOL constraint is under test
            })
        );
        IERC173(d.diamond).transferOwnership(OWNER);

        _discoverPools();
        vm.startPrank(OWNER);
        TargetsFacet(d.diamond).setPoolAllowed(votePools[0], true);
        TargetsFacet(d.diamond).setPoolAllowed(votePools[1], true);
        vm.stopPrank();

        // move to a clean spot inside the vote window of a fresh epoch
        _warpToVoteWindow();
        deal(AERO, d.diamond, 100_000e18);
    }

    /// @dev pick the first two factory pools with live gauges, discovered on-chain at
    ///      the pinned block, nothing invented
    function _discoverPools() internal {
        IPoolFactoryProbe factory = IPoolFactoryProbe(POOL_FACTORY);
        uint256 len = factory.allPoolsLength();
        for (uint256 i; i < len && votePools.length < 2; ++i) {
            address pool = factory.allPools(i);
            address gauge = IAeroVoter(VOTER).gauges(pool);
            if (gauge != address(0) && IAeroVoter(VOTER).isAlive(gauge)) {
                votePools.push(pool);
            }
        }
        require(votePools.length == 2, "fork: could not discover 2 live gauges");
    }

    function _warpToVoteWindow() internal {
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        // land 2 hours into the next epoch: inside [start+1h, end-1h]
        vm.warp(epochStart + WEEK + 2 hours);
    }

    function _setTargets() internal {
        address[] memory pools = new address[](2);
        pools[0] = votePools[0];
        pools[1] = votePools[1];
        uint256[] memory weights = new uint256[](2);
        weights[0] = 0.6e18;
        weights[1] = 0.4e18;
        vm.prank(STRATEGIST);
        TargetsFacet(d.diamond).setTargets(pools, weights, keccak256("fork-test-config"));
    }

    function _createTranche(uint256 amount) internal returns (uint256 trancheId) {
        vm.prank(OWNER);
        trancheId = TrancheFacet(d.diamond).createTranche(amount, 4 * 365 days);
    }

    // ------------------------------------------------------------------
    // the money path
    // ------------------------------------------------------------------

    function test_fork_moneyPath_lockVoteFlipClaimRevote() public onlyForked {
        _setTargets();
        uint256 t1 = _createTranche(10_000e18);
        (uint256 tokenId,,) = TrancheFacet(d.diamond).tranche(t1);

        // permanent lock custody + weight
        assertEq(IEscrowProbe(VOTING_ESCROW).ownerOf(tokenId), d.diamond, "diamond owns the veNFT");
        assertEq(IEscrowProbe(VOTING_ESCROW).balanceOfNFT(tokenId), 10_000e18, "permanent = constant weight");

        // vote
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
        assertGt(IAeroVoter(VOTER).lastVoted(tokenId), 0, "vote recorded");

        // cooldownRemaining reflects the epoch lock
        assertGt(IProtocolFacet(d.diamond).cooldownRemaining(tokenId), 0);

        // warp across the flip, past the distribute window
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        vm.warp(epochStart + WEEK + 2 hours);

        // zero-reward claim path (no fees accrued to a fresh voter is fine; must not revert)
        IMinterProbe(MINTER).updatePeriod();
        AerodromeFacet.ClaimData memory cd = AerodromeFacet.ClaimData({
            bribes: new address[](0),
            bribeTokens: new address[][](0),
            fees: new address[](0),
            feeTokens: new address[][](0),
            claimRebase: true
        });
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).harvest(t1, abi.encode(cd));

        // rebase (if any) auto-compounded into the permanent lock: weight never decreased
        assertGe(IEscrowProbe(VOTING_ESCROW).balanceOfNFT(tokenId), 10_000e18);

        // re-vote in the new epoch
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    // ------------------------------------------------------------------
    // v2 constraints asserted empirically (A2/A4), the P3 justification
    // ------------------------------------------------------------------

    function test_fork_sameEpochRevoteReverts_AlreadyVotedOrDeposited() public onlyForked {
        _setTargets();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);

        // vault cooldown (1h) elapses but the epoch hasn't flipped
        vm.warp(block.timestamp + 2 hours);
        vm.prank(KEEPER);
        vm.expectRevert(AlreadyVotedOrDeposited.selector);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    function test_fork_distributeWindowBlocksVoting() public onlyForked {
        _setTargets();
        uint256 t1 = _createTranche(1_000e18);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);

        // 30 minutes into the next epoch = inside the 1h distribute window
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        vm.warp(epochStart + WEEK + 30 minutes);
        vm.prank(KEEPER);
        vm.expectRevert(DistributeWindow.selector);
        ExecutionFacet(d.diamond).rotate(t1);

        // allocationWindow agrees: it must report an opensAt in the future
        (uint64 opensAt,) = IProtocolFacet(d.diamond).allocationWindow();
        assertGt(opensAt, block.timestamp, "window not yet open");
    }

    // ------------------------------------------------------------------
    // distribute-window boundary: probe the REAL Voter's operator (§8.3, empirical).
    // The facet reports the window open at exactly epochStart+1h; assert the chain
    // agrees (accepts the vote there), so cooldownRemaining/allocationWindow never
    // report ready one second before the Voter actually accepts.
    // ------------------------------------------------------------------

    function test_fork_voteAtExactDistributeWindowBoundary() public onlyForked {
        _setTargets();
        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        uint256 t1 = _createTranche(1_000e18);
        (uint256 tokenId,,) = TrancheFacet(d.diamond).tranche(t1);

        // Empirically: the real Voter reverts DistributeWindow at exactly epochStart+1h
        // (its check is `block.timestamp > epochVoteStart`), and accepts one second later.
        vm.warp(epochStart + WEEK + 1 hours);
        vm.prank(KEEPER);
        vm.expectRevert(DistributeWindow.selector);
        ExecutionFacet(d.diamond).rotate(t1);
        // the facet must agree: not ready yet at the boundary second
        assertGt(IProtocolFacet(d.diamond).cooldownRemaining(tokenId), 0, "facet: still closed at +1h");
        (uint64 opensAt,) = IProtocolFacet(d.diamond).allocationWindow();
        assertGt(opensAt, block.timestamp, "facet: window opens after +1h");

        vm.warp(epochStart + WEEK + 1 hours + 1); // one second later: open
        assertEq(IProtocolFacet(d.diamond).cooldownRemaining(tokenId), 0, "facet: ready at +1h+1");
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
        assertGt(IAeroVoter(VOTER).lastVoted(tokenId), 0, "vote recorded at +1h+1");
    }

    // ------------------------------------------------------------------
    // custody round-trip: NFT out (rescue) and back in (gated receipt)
    // ------------------------------------------------------------------

    function test_fork_nftTransferOutAndIn() public onlyForked {
        uint256 t1 = _createTranche(1_000e18);
        (uint256 tokenId,,) = TrancheFacet(d.diamond).tranche(t1);

        vm.prank(OWNER);
        CustodyFacet(d.diamond).rescueERC721(VOTING_ESCROW, tokenId, OWNER);
        assertEq(IEscrowProbe(VOTING_ESCROW).ownerOf(tokenId), OWNER);

        // back in: safeTransferFrom routes through onERC721Received, gated to the escrow
        vm.prank(OWNER);
        IEscrowProbe(VOTING_ESCROW).safeTransferFrom(OWNER, d.diamond, tokenId);
        assertEq(IEscrowProbe(VOTING_ESCROW).ownerOf(tokenId), d.diamond);
    }

    // ------------------------------------------------------------------
    // mid-lifecycle facet swap on the fork: custody + tranche state survive
    // ------------------------------------------------------------------

    function test_fork_midLifecycleProtocolSwap() public onlyForked {
        _setTargets();
        uint256 t1 = _createTranche(1_000e18);
        (uint256 tokenId,,) = TrancheFacet(d.diamond).tranche(t1);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);

        // Aerodrome → Mock → Aerodrome through the sanctioned cut path
        address mock = address(new MockAeroFacet());
        vm.prank(OWNER);
        IDiamondCut(d.diamond).diamondCut(protocolSwapCut("AerodromeFacet", mock, "MockAeroFacet"), address(0), "");
        assertEq(IProtocolFacet(d.diamond).protocolId(), keccak256("mock-aero-v3"));

        vm.prank(OWNER);
        IDiamondCut(d.diamond).diamondCut(
            protocolSwapCut("MockAeroFacet", d.aerodromeFacet, "AerodromeFacet"), address(0), ""
        );
        assertEq(IProtocolFacet(d.diamond).protocolId(), keccak256("aerodrome-v2"));

        // custody and tranche registry untouched; flows functional next epoch
        assertEq(IEscrowProbe(VOTING_ESCROW).ownerOf(tokenId), d.diamond);
        (uint256 tokenIdAfter,, bool exists) = TrancheFacet(d.diamond).tranche(t1);
        assertEq(tokenIdAfter, tokenId);
        assertTrue(exists);

        uint256 epochStart = block.timestamp - (block.timestamp % WEEK);
        vm.warp(epochStart + WEEK + 2 hours);
        vm.prank(KEEPER);
        ExecutionFacet(d.diamond).rotate(t1);
    }

    // ------------------------------------------------------------------
    // compound: real swap through the Aerodrome router into the lock
    // ------------------------------------------------------------------

    function test_fork_compoundSwapsRewardTokenIntoLock() public onlyForked {
        uint256 t1 = _createTranche(1_000e18);
        (uint256 tokenId,,) = TrancheFacet(d.diamond).tranche(t1);

        // find a live pool paired with AERO and use its other token as a fake reward
        (address pool, address otherToken) = _findAeroPool();
        uint256 rewardAmount = 200e18;
        deal(otherToken, d.diamond, rewardAmount);

        AerodromeFacet.SwapLeg[] memory legs = new AerodromeFacet.SwapLeg[](1);
        legs[0].tokenIn = otherToken;
        legs[0].routes = new IAeroRouter.Route[](1);
        legs[0].routes[0] =
            IAeroRouter.Route({from: otherToken, to: AERO, stable: IPoolProbe(pool).stable(), factory: POOL_FACTORY});

        uint256 weightBefore = IEscrowProbe(VOTING_ESCROW).balanceOfNFT(tokenId);
        vm.prank(KEEPER);
        uint256 added = ExecutionFacet(d.diamond).compoundTranche(t1, 1, abi.encode(legs));
        assertGt(added, 0, "swap produced AERO");
        assertEq(IEscrowProbe(VOTING_ESCROW).balanceOfNFT(tokenId), weightBefore + added, "stake increased");
    }

    function _findAeroPool() internal view returns (address pool, address otherToken) {
        IPoolFactoryProbe factory = IPoolFactoryProbe(POOL_FACTORY);
        uint256 len = factory.allPoolsLength();
        for (uint256 i; i < len; ++i) {
            address candidate = factory.allPools(i);
            address gauge = IAeroVoter(VOTER).gauges(candidate);
            if (gauge == address(0) || !IAeroVoter(VOTER).isAlive(gauge)) continue;
            address t0 = IPoolProbe(candidate).token0();
            address t1 = IPoolProbe(candidate).token1();
            if (t0 == AERO) return (candidate, t1);
            if (t1 == AERO) return (candidate, t0);
        }
        revert("fork: no live AERO pool found");
    }
}
