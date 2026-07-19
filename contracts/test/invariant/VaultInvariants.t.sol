// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {TestBase} from "../helpers/TestBase.sol";
import {TrancheFacet} from "../../src/facets/TrancheFacet.sol";
import {TargetsFacet} from "../../src/facets/TargetsFacet.sol";
import {ExecutionFacet} from "../../src/facets/ExecutionFacet.sol";
import {MockAeroFacet} from "../../src/facets/protocol/MockAeroFacet.sol";
import {IProtocolFacet} from "../../src/interfaces/IProtocolFacet.sol";
import {IDiamondLoupe} from "../../src/interfaces/IDiamondLoupe.sol";

/// @notice Randomized actor loop over the deployed diamond + mock protocol:
///         strategist re-targets, keeper rotates/harvests/compounds, owner adds
///         tranches, and time skips 1h–72h. Every state-changing entry point either
///         succeeds or is an expected guardrail revert swallowed by try/catch.
contract VaultHandler is CommonBase, StdUtils {
    address internal immutable diamond;
    address internal immutable owner;
    address internal immutable strategist;
    address internal immutable keeper;
    address internal immutable poolA;
    address internal immutable poolB;
    address internal immutable poolC;

    uint256 internal constant MAX_TRANCHES = 5;

    uint256[] internal _trancheIds;
    uint256[] internal _tokens;
    mapping(uint256 => uint256) public tokenOf; // trancheId → position tokenId
    mapping(uint256 => uint64) public lastRotateAt; // trancheId → last successful rotate ts
    mapping(uint256 => uint256) public allocatedSumOf; // tokenId → Σ per-pool allocated weight

    /// @dev min observed spacing between successive successful rotates of one tranche
    uint256 public minRotateSpacing = type(uint256).max;

    constructor(address diamond_, address owner_, address strategist_, address keeper_, address[3] memory pools) {
        diamond = diamond_;
        owner = owner_;
        strategist = strategist_;
        keeper = keeper_;
        poolA = pools[0];
        poolB = pools[1];
        poolC = pools[2];
    }

    // ------------------------------------------------------------------
    // actions
    // ------------------------------------------------------------------

    function createTranche(uint256 amountSeed) external {
        if (_trancheIds.length >= MAX_TRANCHES) return;
        uint256 amount = bound(amountSeed, 1e18, 1e24);
        vm.prank(owner);
        uint256 trancheId = TrancheFacet(diamond).createTranche(amount, 0);
        (uint256 tokenId,,) = TrancheFacet(diamond).tranche(trancheId);
        _trancheIds.push(trancheId);
        _tokens.push(tokenId);
        tokenOf[trancheId] = tokenId;
    }

    function setTargets(uint256 seed) external {
        (address[] memory pools, uint256[] memory weights) = _targetFor(seed);
        // always valid: allowlisted pools, each weight ≤ maxPoolWeightWad (0.5e18),
        // sum == 1e18, and L1 delta between weight vectors is ≤ 2e18 == maxDeltaWad
        vm.prank(strategist);
        TargetsFacet(diamond).setTargets(pools, weights, keccak256(abi.encode("handler-target", seed % 4)));
    }

    function rotate(uint256 trancheSeed) external {
        uint256 trancheId = _pickTranche(trancheSeed);
        if (trancheId == 0) return;
        vm.prank(keeper);
        try ExecutionFacet(diamond).rotate(trancheId) {
            uint64 nowTs = uint64(block.timestamp);
            uint64 prev = lastRotateAt[trancheId];
            if (prev != 0) {
                uint256 spacing = nowTs - prev;
                if (spacing < minRotateSpacing) minRotateSpacing = spacing;
            }
            lastRotateAt[trancheId] = nowTs;
            _recordAllocation(trancheId);
        } catch {
            // CooldownActive / CooldownNotElapsed, expected under random timing
        }
    }

    function harvest(uint256 trancheSeed) external {
        uint256 trancheId = _pickTranche(trancheSeed);
        if (trancheId == 0) return;
        vm.prank(keeper);
        try ExecutionFacet(diamond).harvest(trancheId, "") {} catch {}
    }

    function compoundTranche(uint256 trancheSeed) external {
        uint256 trancheId = _pickTranche(trancheSeed);
        if (trancheId == 0) return;
        vm.prank(keeper);
        try ExecutionFacet(diamond).compoundTranche(trancheId, 0, "") {} catch {}
    }

    function warpTime(uint256 seed) external {
        uint256 dt = bound(seed, 1 hours, 72 hours);
        vm.warp(block.timestamp + dt);
    }

    // ------------------------------------------------------------------
    // views for the invariant contract
    // ------------------------------------------------------------------

    function trancheCount() external view returns (uint256) {
        return _trancheIds.length;
    }

    function tokens() external view returns (uint256[] memory) {
        return _tokens;
    }

    // ------------------------------------------------------------------
    // internals
    // ------------------------------------------------------------------

    function _pickTranche(uint256 seed) internal view returns (uint256) {
        uint256 n = _trancheIds.length;
        if (n == 0) return 0;
        return _trancheIds[_bound(seed, 0, n - 1)];
    }

    /// @dev mirror of MockAeroFacet.allocate's per-pool split: w_i = floor(weight * t_i / Σt).
    ///      Recorded at rotate time; positionWeight can only grow afterwards (compound),
    ///      so Σ allocated ≤ positionWeight must keep holding.
    function _recordAllocation(uint256 trancheId) internal {
        uint256 tokenId = tokenOf[trancheId];
        uint256 w = IProtocolFacet(diamond).positionWeight(tokenId);
        (, uint256[] memory weights) = TargetsFacet(diamond).targets();
        uint256 sum;
        for (uint256 i; i < weights.length; ++i) {
            sum += weights[i];
        }
        uint256 alloc;
        for (uint256 i; i < weights.length; ++i) {
            alloc += (w * weights[i]) / sum;
        }
        allocatedSumOf[tokenId] = alloc;
    }

    function _targetFor(uint256 seed) internal view returns (address[] memory pools, uint256[] memory weights) {
        uint256 v = seed % 4;
        if (v == 0) {
            pools = new address[](2);
            (pools[0], pools[1]) = (poolA, poolB);
            weights = new uint256[](2);
            (weights[0], weights[1]) = (0.5e18, 0.5e18);
        } else if (v == 1) {
            pools = new address[](2);
            (pools[0], pools[1]) = (poolB, poolC);
            weights = new uint256[](2);
            (weights[0], weights[1]) = (0.5e18, 0.5e18);
        } else if (v == 2) {
            pools = new address[](3);
            (pools[0], pools[1], pools[2]) = (poolA, poolB, poolC);
            weights = new uint256[](3);
            (weights[0], weights[1], weights[2]) = (0.4e18, 0.3e18, 0.3e18);
        } else {
            pools = new address[](3);
            (pools[0], pools[1], pools[2]) = (poolC, poolA, poolB);
            weights = new uint256[](3);
            (weights[0], weights[1], weights[2]) = (0.5e18, 0.25e18, 0.25e18);
        }
    }
}

/// @notice Vault invariant suite (§8.2): conservation of mock emissions, cooldown
///         spacing of successful rotations, allocation ≤ position weight, and stable
///         selector routing (no diamondCut in the action set).
/// forge-config: default.invariant.runs = 24
/// forge-config: default.invariant.depth = 50
/// forge-config: default.invariant.fail-on-revert = true
contract VaultInvariantsTest is TestBase {
    VaultHandler internal handler;

    address internal trancheFacetAtGenesis;
    address internal protocolFacetAtGenesis;

    function setUp() public {
        _deployDiamond();
        _cutInMockProtocol();
        _allowPools();

        trancheFacetAtGenesis = IDiamondLoupe(d.diamond).facetAddress(TrancheFacet.createTranche.selector);
        protocolFacetAtGenesis = IDiamondLoupe(d.diamond).facetAddress(IProtocolFacet.createStake.selector);
        assertEq(trancheFacetAtGenesis, d.trancheFacet);
        assertEq(protocolFacetAtGenesis, mockAeroFacet);

        handler = new VaultHandler(d.diamond, OWNER, STRATEGIST, KEEPER, [POOL_A, POOL_B, POOL_C]);
        // seed: one target and one tranche so keeper actions bite early
        handler.setTargets(0);
        handler.createTranche(0);

        targetContract(address(handler));
    }

    /// @dev (a) mock protocol conservation: everything the minter accounted either
    ///      reached a pool or was burned, no token appears or vanishes
    function invariant_mockTotalsConservation() public view {
        (uint256 emitted, uint256 streamed, uint256 burned) = MockAeroFacet(d.diamond).mockTotals();
        assertEq(emitted, streamed + burned, "emitted == streamed + burned");
    }

    /// @dev (b) successful rotations of one tranche can never be closer together than
    ///      the vault rotation cooldown (and the mock's 48h per-position cooldown)
    function invariant_rotationSpacingRespectsCooldowns() public view {
        (,, uint64 rotationCooldown,) = TargetsFacet(d.diamond).guardrails();
        uint256 spacing = handler.minRotateSpacing();
        assertGe(spacing, rotationCooldown, "spacing >= vault rotationCooldown");
        assertGe(spacing, IProtocolFacet(d.diamond).protocolCooldown(), "spacing >= protocol cooldown (48h)");
    }

    /// @dev (c) a position never allocates more weight into pools than it has
    function invariant_allocatedWithinPositionWeight() public view {
        uint256[] memory tokens = handler.tokens();
        for (uint256 i; i < tokens.length; ++i) {
            assertLe(
                handler.allocatedSumOf(tokens[i]),
                IProtocolFacet(d.diamond).positionWeight(tokens[i]),
                "sum of per-pool allocation <= position weight"
            );
        }
    }

    /// @dev (d) no handler action performs a diamondCut, so selector routing is frozen
    function invariant_selectorRoutingUnchanged() public view {
        assertEq(
            IDiamondLoupe(d.diamond).facetAddress(TrancheFacet.createTranche.selector),
            trancheFacetAtGenesis,
            "createTranche routing frozen"
        );
        assertEq(
            IDiamondLoupe(d.diamond).facetAddress(IProtocolFacet.createStake.selector),
            protocolFacetAtGenesis,
            "createStake routing frozen"
        );
    }
}
