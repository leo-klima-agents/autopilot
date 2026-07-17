// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {LibVaultStorage} from "../libraries/LibVaultStorage.sol";
import {LibAccess} from "../libraries/LibAccess.sol";
import {LibDiamond} from "../libraries/LibDiamond.sol";
import {IProtocolFacet} from "../interfaces/IProtocolFacet.sol";

/// @title TrancheFacet
/// @notice Registry mapping trancheId → position NFT with per-tranche lastActionAt for
///         cooldown accounting. Positions are created as SEPARATE PERMANENT stakes from
///         the start: v3 positions cannot be split (ARCHITECTURE.md F3) and permanent
///         stakes avoid weight decay (F8), so staggered-cooldown tranche structure must
///         exist at stake time. The same discipline applies to v2 (lockPermanent, A7).
contract TrancheFacet {
    event TrancheCreated(uint256 indexed trancheId, uint256 indexed positionTokenId, uint256 amount);
    event TrancheRetired(uint256 indexed trancheId, uint256 indexed positionTokenId);

    error UnknownTranche(uint256 trancheId);

    /// @notice stake `amount` of the protocol token held by the diamond into a new
    ///         permanent position and register it as a tranche. Owner-only: tranche
    ///         structure is a custody decision, not a strategy decision.
    /// @param duration lock duration in seconds, forwarded to protocols that require one
    ///        even for permanent stakes (v2 creates a max-lock then locks permanent)
    function createTranche(uint256 amount, uint256 duration) external returns (uint256 trancheId) {
        LibDiamond.enforceIsContractOwner();
        uint256 tokenId = IProtocolFacet(address(this)).createStake(amount, duration, true);

        LibVaultStorage.TrancheStorage storage ts = LibVaultStorage.tranches();
        trancheId = ++ts.nextTrancheId;
        // lastActionAt = 0 ⇒ never allocated: a fresh tranche is immediately rotatable
        ts.tranches[trancheId] = LibVaultStorage.Tranche({positionTokenId: tokenId, lastActionAt: 0, exists: true});
        ts.trancheIds.push(trancheId);
        emit TrancheCreated(trancheId, tokenId, amount);
    }

    /// @notice unregister a tranche (position stays in custody — rescue/migration is
    ///         CustodyFacet's job). Used during the September migration runbook.
    function retireTranche(uint256 trancheId) external {
        LibDiamond.enforceIsContractOwner();
        LibVaultStorage.TrancheStorage storage ts = LibVaultStorage.tranches();
        LibVaultStorage.Tranche storage t = ts.tranches[trancheId];
        if (!t.exists) revert UnknownTranche(trancheId);
        uint256 tokenId = t.positionTokenId;
        t.exists = false;
        uint256 len = ts.trancheIds.length;
        for (uint256 i; i < len; ++i) {
            if (ts.trancheIds[i] == trancheId) {
                ts.trancheIds[i] = ts.trancheIds[len - 1];
                ts.trancheIds.pop();
                break;
            }
        }
        emit TrancheRetired(trancheId, tokenId);
    }

    function tranche(uint256 trancheId)
        external
        view
        returns (uint256 positionTokenId, uint64 lastActionAt, bool exists)
    {
        LibVaultStorage.Tranche storage t = LibVaultStorage.tranches().tranches[trancheId];
        return (t.positionTokenId, t.lastActionAt, t.exists);
    }

    function trancheIds() external view returns (uint256[] memory) {
        return LibVaultStorage.tranches().trancheIds;
    }
}
