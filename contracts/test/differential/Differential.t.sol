// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {LibDeterministic} from "../../src/libraries/LibDeterministic.sol";

/// @notice Differential suite (P2): the TypeScript core generates fixture vectors
///         (packages/core/src/fixtures → contracts/test/differential/fixtures/); this
///         harness replays each through the Solidity twin and asserts EXACT equality.
///         TS generates, Solidity verifies. Tests skip (loudly) when a fixture file is
///         missing so the contracts suite stays runnable before `pnpm fixtures`.
contract DifferentialTest is Test {
    string private constant FIXTURE_DIR = "/test/differential/fixtures/";

    function _load(string memory name) private view returns (string memory json, bool ok) {
        string memory path = string.concat(vm.projectRoot(), FIXTURE_DIR, name);
        try vm.readFile(path) returns (string memory contents) {
            return (contents, true);
        } catch {
            return ("", false);
        }
    }

    function _skipIfMissing(bool ok, string memory name) private {
        if (!ok) {
            emit log_string(string.concat("SKIP: fixture missing (run `pnpm fixtures`): ", name));
            vm.skip(true);
        }
    }

    // ------------------------------------------------------------------
    // pro-rata revenue distribution
    // ------------------------------------------------------------------

    function test_differential_proRata() public {
        (string memory json, bool ok) = _load("pro-rata.json");
        _skipIfMissing(ok, "pro-rata.json");

        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256 reward = _u(json, string.concat(base, ".inputs.reward"));
            uint256[] memory weights = _uarr(json, string.concat(base, ".inputs.weights"));
            uint256[] memory expectedPayouts = _uarr(json, string.concat(base, ".expected.payouts"));
            uint256 expectedDust = _u(json, string.concat(base, ".expected.dust"));

            (uint256[] memory payouts, uint256 dust) = LibDeterministic.proRata(reward, weights);
            assertEq(payouts.length, expectedPayouts.length, _ctx("proRata len", i));
            for (uint256 j; j < payouts.length; ++j) {
                assertEq(payouts[j], expectedPayouts[j], _ctx("proRata payout", i));
            }
            assertEq(dust, expectedDust, _ctx("proRata dust", i));
        }
    }

    // ------------------------------------------------------------------
    // gauge cap / burn arithmetic
    // ------------------------------------------------------------------

    function test_differential_capStream() public {
        (string memory json, bool ok) = _load("cap-stream.json");
        _skipIfMissing(ok, "cap-stream.json");

        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            (uint256 emitted, uint256 streamed, uint256 burned) = LibDeterministic.capStream(
                _u(json, string.concat(base, ".inputs.allocatedRate")),
                _u(json, string.concat(base, ".inputs.capRate")),
                _u(json, string.concat(base, ".inputs.dt"))
            );
            assertEq(emitted, _u(json, string.concat(base, ".expected.emitted")), _ctx("capStream emitted", i));
            assertEq(streamed, _u(json, string.concat(base, ".expected.streamed")), _ctx("capStream streamed", i));
            assertEq(burned, _u(json, string.concat(base, ".expected.burned")), _ctx("capStream burned", i));
        }
    }

    // ------------------------------------------------------------------
    // rotation selection (cooldown scheduler)
    // ------------------------------------------------------------------

    function test_differential_selectRotation() public {
        (string memory json, bool ok) = _load("scheduler-select.json");
        _skipIfMissing(ok, "scheduler-select.json");

        uint256 n = _caseCount(json);
        assertGt(n, 0, "empty fixture");
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256[] memory lastRaw = _uarr(json, string.concat(base, ".inputs.lastActionAt"));
            uint64[] memory lastActionAt = new uint64[](lastRaw.length);
            for (uint256 j; j < lastRaw.length; ++j) {
                lastActionAt[j] = uint64(lastRaw[j]);
            }
            (bool found, uint256 index) = LibDeterministic.selectRotation(
                lastActionAt,
                _uarr(json, string.concat(base, ".inputs.distances")),
                uint64(_u(json, string.concat(base, ".inputs.now"))),
                uint64(_u(json, string.concat(base, ".inputs.cooldown")))
            );
            assertEq(found, vm.parseJsonBool(json, string.concat(base, ".expected.found")), _ctx("select found", i));
            if (found) {
                assertEq(index, _u(json, string.concat(base, ".expected.index")), _ctx("select index", i));
            }
        }
    }

    // ------------------------------------------------------------------
    // L1 distance
    // ------------------------------------------------------------------

    function test_differential_l1Distance() public {
        (string memory json, bool ok) = _load("l1-distance.json");
        _skipIfMissing(ok, "l1-distance.json");

        uint256 n = _caseCount(json);
        for (uint256 i; i < n; ++i) {
            string memory base = string.concat(".cases[", vm.toString(i), "]");
            uint256 got = LibDeterministic.l1Distance(
                _uarr(json, string.concat(base, ".inputs.current")), _uarr(json, string.concat(base, ".inputs.target"))
            );
            assertEq(got, _u(json, string.concat(base, ".expected.distance")), _ctx("l1", i));
        }
    }

    // ------------------------------------------------------------------
    // json helpers — fixture numbers are decimal strings (JSON has no bigint)
    // ------------------------------------------------------------------

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

    function _ctx(string memory what, uint256 i) private pure returns (string memory) {
        return string.concat(what, " case ", vm.toString(i));
    }
}
