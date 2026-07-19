// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibDeterministic} from "../../src/libraries/LibDeterministic.sol";

/// @notice Differential suite (P2): packages/core generates fixture vectors
///         (`pnpm fixtures` → contracts/test/differential/fixtures/); this harness
///         replays each through the Solidity twin and asserts EXACT equality.
///         TS generates, Solidity verifies. Tests skip loudly when a fixture file is
///         missing so the contracts suite stays runnable before `pnpm fixtures`.
contract DifferentialTest is Test {
    string private constant FIXTURE_DIR = "/test/differential/fixtures/";

    // ------------------------------------------------------------------
    // pro-rata revenue distribution  (pro-rata-revenue.json, 120 cases)
    // ------------------------------------------------------------------

    function test_differential_proRata() public {
        string memory json = _load("pro-rata-revenue.json");
        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            (uint256[] memory payouts, uint256 dust) = LibDeterministic.proRata(
                _u(json, string.concat(base, ".inputs.poolReward")),
                _uarr(json, string.concat(base, ".inputs.weights"))
            );
            uint256[] memory expectedPayouts = _uarr(json, string.concat(base, ".expected.payouts"));
            assertEq(payouts.length, expectedPayouts.length, _ctx(json, base, "payout len"));
            for (uint256 j; j < payouts.length; ++j) {
                assertEq(payouts[j], expectedPayouts[j], _ctx(json, base, "payout"));
            }
            assertEq(dust, _u(json, string.concat(base, ".expected.dust")), _ctx(json, base, "dust"));
        }
    }

    // ------------------------------------------------------------------
    // gauge cap / burn arithmetic  (cap-burn.json, 100 cases)
    // ------------------------------------------------------------------

    function test_differential_capBurn() public {
        string memory json = _load("cap-burn.json");
        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256 allocatedRate = _u(json, string.concat(base, ".inputs.allocatedRatePerSec"));
            uint256 capRate = LibDeterministic.capFromRevenue(
                _u(json, string.concat(base, ".inputs.trailingRevenue")),
                uint256(vm.parseJsonUint(json, string.concat(base, ".inputs.windowSec"))),
                _u(json, string.concat(base, ".inputs.kappaWad"))
            );
            (uint256 emitted, uint256 streamed, uint256 burned) = LibDeterministic.capStream(
                allocatedRate, capRate, uint256(vm.parseJsonUint(json, string.concat(base, ".inputs.dtSec")))
            );
            uint256 effectiveRate = allocatedRate < capRate ? allocatedRate : capRate;

            assertEq(capRate, _u(json, string.concat(base, ".expected.capRate")), _ctx(json, base, "capRate"));
            assertEq(
                effectiveRate, _u(json, string.concat(base, ".expected.effectiveRate")), _ctx(json, base, "effRate")
            );
            assertEq(emitted, _u(json, string.concat(base, ".expected.emitted")), _ctx(json, base, "emitted"));
            assertEq(streamed, _u(json, string.concat(base, ".expected.streamed")), _ctx(json, base, "streamed"));
            assertEq(burned, _u(json, string.concat(base, ".expected.burned")), _ctx(json, base, "burned"));
            // conservation, doubly checked
            assertEq(streamed + burned, emitted, _ctx(json, base, "conservation"));
        }
    }

    // ------------------------------------------------------------------
    // water-filling allocator  (water-filling.json, 64 cases)
    // ------------------------------------------------------------------

    function test_differential_waterFill() public {
        string memory json = _load("water-filling.json");
        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            (uint256[] memory weights, uint256 lambda, uint256 iterations) = LibDeterministic.waterFill(
                _uarr(json, string.concat(base, ".inputs.R")),
                _uarr(json, string.concat(base, ".inputs.W")),
                _u(json, string.concat(base, ".inputs.budget")),
                _u(json, string.concat(base, ".inputs.scale"))
            );
            uint256[] memory expected = _uarr(json, string.concat(base, ".expected.weights"));
            assertEq(weights.length, expected.length, _ctx(json, base, "wf len"));
            for (uint256 j; j < weights.length; ++j) {
                assertEq(weights[j], expected[j], _ctx(json, base, "wf weight"));
            }
            assertEq(lambda, _u(json, string.concat(base, ".expected.lambda")), _ctx(json, base, "wf lambda"));
            assertEq(
                iterations,
                uint256(vm.parseJsonUint(json, string.concat(base, ".expected.iterations"))),
                _ctx(json, base, "wf iterations")
            );
        }
    }

    // ------------------------------------------------------------------
    // cooldown scheduler plan  (cooldown-scheduler.json, 60 cases)
    // ------------------------------------------------------------------

    struct PlanItem {
        string id;
        uint256 distance; // rotate: L1 distance; wait: readyAt
        bool rotate;
    }

    function test_differential_schedulerPlan() public {
        string memory json = _load("cooldown-scheduler.json");
        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            _replayPlanCase(json, string.concat(".cases[", vm.toString(i), "]"));
        }
    }

    struct PlanCase {
        string[] targetPools;
        PlanItem[] rotations;
        PlanItem[] waits;
        uint256 nRot;
        uint256 nWait;
    }

    /// @dev replays packages/core scheduler.plan: rotations farthest-first (ties by
    ///      ascending id, lexicographic), then waits by readyAt ascending (ties by id)
    function _replayPlanCase(string memory json, string memory base) private view {
        PlanCase memory pc = _buildPlan(json, base);
        _sortRotations(pc.rotations, pc.nRot);
        _sortWaits(pc.waits, pc.nWait);
        _assertPlan(json, base, pc);
    }

    function _buildPlan(string memory json, string memory base) private view returns (PlanCase memory pc) {
        pc.targetPools = vm.parseJsonKeys(json, string.concat(base, ".inputs.target"));
        uint256 now_ = uint256(vm.parseJsonUint(json, string.concat(base, ".inputs.now")));
        uint256 cooldown = uint256(vm.parseJsonUint(json, string.concat(base, ".inputs.cooldownSec")));

        uint256 trancheCount;
        while (vm.keyExistsJson(json, string.concat(base, ".inputs.tranches[", vm.toString(trancheCount), "]"))) {
            ++trancheCount;
        }
        pc.rotations = new PlanItem[](trancheCount);
        pc.waits = new PlanItem[](trancheCount);
        for (uint256 t; t < trancheCount; ++t) {
            _classifyTranche(json, base, pc, t, now_, cooldown);
        }
    }

    function _classifyTranche(
        string memory json,
        string memory base,
        PlanCase memory pc,
        uint256 t,
        uint256 now_,
        uint256 cooldown
    ) private view {
        string memory tb = string.concat(base, ".inputs.tranches[", vm.toString(t), "]");
        uint256 distance = _l1VsTarget(json, base, tb, pc.targetPools);
        if (distance == 0) return;
        uint256 readyAt = uint256(vm.parseJsonUint(json, string.concat(tb, ".lastActionAt"))) + cooldown;
        string memory id = vm.parseJsonString(json, string.concat(tb, ".id"));
        if (now_ >= readyAt) {
            pc.rotations[pc.nRot++] = PlanItem({id: id, distance: distance, rotate: true});
        } else {
            pc.waits[pc.nWait++] = PlanItem({id: id, distance: readyAt, rotate: false});
        }
    }

    function _assertPlan(string memory json, string memory base, PlanCase memory pc) private view {

        // compare against expected action list
        uint256 nActions;
        while (vm.keyExistsJson(json, string.concat(base, ".expected.actions[", vm.toString(nActions), "]"))) {
            ++nActions;
        }
        assertEq(nActions, pc.nRot + pc.nWait, _ctx(json, base, "action count"));
        for (uint256 a; a < nActions; ++a) {
            string memory ab = string.concat(base, ".expected.actions[", vm.toString(a), "]");
            string memory expectedId = vm.parseJsonString(json, string.concat(ab, ".trancheId"));
            if (a < pc.nRot) {
                assertEq(vm.parseJsonString(json, string.concat(ab, ".kind")), "rotate", _ctx(json, base, "kind"));
                assertEq(pc.rotations[a].id, expectedId, _ctx(json, base, "rotate id"));
                // rotate allocation must equal the target exactly
                for (uint256 p; p < pc.targetPools.length; ++p) {
                    assertEq(
                        _u(json, string.concat(ab, ".allocation.", pc.targetPools[p])),
                        _u(json, string.concat(base, ".inputs.target.", pc.targetPools[p])),
                        _ctx(json, base, "rotate allocation")
                    );
                }
            } else {
                assertEq(vm.parseJsonString(json, string.concat(ab, ".kind")), "wait", _ctx(json, base, "kind"));
                assertEq(pc.waits[a - pc.nRot].id, expectedId, _ctx(json, base, "wait id"));
                assertEq(
                    pc.waits[a - pc.nRot].distance,
                    uint256(vm.parseJsonUint(json, string.concat(ab, ".until"))),
                    _ctx(json, base, "wait until")
                );
            }
        }
    }

    /// @dev L1 distance over the union of the tranche's allocation keys and target keys
    function _l1VsTarget(string memory json, string memory base, string memory tb, string[] memory targetPools)
        private
        view
        returns (uint256 distance)
    {
        string[] memory allocPools = vm.parseJsonKeys(json, string.concat(tb, ".allocation"));
        // pools in the allocation (target value 0 when absent)
        for (uint256 p; p < allocPools.length; ++p) {
            uint256 a = _u(json, string.concat(tb, ".allocation.", allocPools[p]));
            uint256 b = _targetWeight(json, base, allocPools[p]);
            distance += a > b ? a - b : b - a;
        }
        // pools only in the target
        for (uint256 p; p < targetPools.length; ++p) {
            if (_contains(allocPools, targetPools[p])) continue;
            distance += _u(json, string.concat(base, ".inputs.target.", targetPools[p]));
        }
    }

    function _targetWeight(string memory json, string memory base, string memory pool)
        private
        view
        returns (uint256)
    {
        string memory path = string.concat(base, ".inputs.target.", pool);
        if (!vm.keyExistsJson(json, path)) return 0;
        return _u(json, path);
    }

    // insertion sorts mirroring the TS comparators exactly
    function _sortRotations(PlanItem[] memory items, uint256 len) private pure {
        for (uint256 i = 1; i < len; ++i) {
            PlanItem memory key = items[i];
            uint256 j = i;
            while (j > 0 && _rotateAfter(items[j - 1], key)) {
                items[j] = items[j - 1];
                --j;
            }
            items[j] = key;
        }
    }

    /// @dev true when `a` should sort after `b`: smaller distance, or equal distance and
    ///      lexicographically greater id
    function _rotateAfter(PlanItem memory a, PlanItem memory b) private pure returns (bool) {
        if (a.distance != b.distance) return a.distance < b.distance;
        return _strGt(a.id, b.id);
    }

    function _sortWaits(PlanItem[] memory items, uint256 len) private pure {
        for (uint256 i = 1; i < len; ++i) {
            PlanItem memory key = items[i];
            uint256 j = i;
            while (j > 0 && _waitAfter(items[j - 1], key)) {
                items[j] = items[j - 1];
                --j;
            }
            items[j] = key;
        }
    }

    function _waitAfter(PlanItem memory a, PlanItem memory b) private pure returns (bool) {
        if (a.distance != b.distance) return a.distance > b.distance; // until asc
        return _strGt(a.id, b.id);
    }

    function _strGt(string memory a, string memory b) private pure returns (bool) {
        bytes memory ba = bytes(a);
        bytes memory bb = bytes(b);
        uint256 len = ba.length < bb.length ? ba.length : bb.length;
        for (uint256 i; i < len; ++i) {
            if (ba[i] != bb[i]) return ba[i] > bb[i];
        }
        return ba.length > bb.length;
    }

    function _contains(string[] memory arr, string memory s) private pure returns (bool) {
        bytes32 h = keccak256(bytes(s));
        for (uint256 i; i < arr.length; ++i) {
            if (keccak256(bytes(arr[i])) == h) return true;
        }
        return false;
    }

    // ------------------------------------------------------------------
    // json helpers, fixture bigints are decimal strings (JSON has no bigint)
    // ------------------------------------------------------------------

    function _load(string memory name) private returns (string memory json) {
        string memory path = string.concat(vm.projectRoot(), FIXTURE_DIR, name);
        try vm.readFile(path) returns (string memory contents) {
            return contents;
        } catch {
            emit log_string(string.concat("SKIP: fixture missing (run `pnpm fixtures`): ", name));
            vm.skip(true);
        }
    }

    function _caseCount(string memory json) private view returns (uint256 n) {
        while (vm.keyExistsJson(json, string.concat(".cases[", vm.toString(n), "]"))) {
            ++n;
        }
    }

    function _u(string memory json, string memory path) private pure returns (uint256) {
        return vm.parseUint(vm.parseJsonString(json, path));
    }

    function _uarr(string memory json, string memory path) private pure returns (uint256[] memory out) {
        string[] memory raw = vm.parseJsonStringArray(json, path);
        out = new uint256[](raw.length);
        for (uint256 i; i < raw.length; ++i) {
            out[i] = vm.parseUint(raw[i]);
        }
    }

    function _ctx(string memory json, string memory base, string memory what) private pure returns (string memory) {
        return string.concat(what, " @ ", vm.parseJsonString(json, string.concat(base, ".name")));
    }
}
