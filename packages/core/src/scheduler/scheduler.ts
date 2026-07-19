/**
 * Tranche/cooldown scheduler, the pure state machine used identically by
 * the simulator, the keeper, and fixture generation. Fixture-relevant (P2):
 * loop-simple, integer-only, deterministic under map insertion order (keys
 * are always sorted), replayable in Solidity.
 */

import { absDiff } from "../math/fixed.js";
import type { PoolId, TargetAllocation, Wad } from "../model/types.js";

/** One tranche (protocol position) as the scheduler sees it. */
export interface TrancheState {
  /** Stable id; ties in the plan are broken by ascending id. */
  id: string;
  /** Staking weight of the tranche's position. */
  positionWeight: Wad;
  /** Unix time of the tranche's last allocation action. */
  lastActionAt: number;
  /** Current allocation as Wad fractions per pool. */
  allocation: Map<PoolId, Wad>;
}

/** Rotate a tranche to a new allocation now. */
export interface RotateAction {
  kind: "rotate";
  trancheId: string;
  allocation: Map<PoolId, Wad>;
}

/** Tranche is off target but cooling down until `until`. */
export interface WaitAction {
  kind: "wait";
  trancheId: string;
  until: number;
}

export type Action = RotateAction | WaitAction;

/**
 * L1 distance between two allocations: Σ_p |a_p - b_p| over the sorted union
 * of keys. Exact, order-independent.
 */
export function l1Distance(
  a: ReadonlyMap<PoolId, Wad>,
  b: ReadonlyMap<PoolId, Wad>,
): bigint {
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  let dist = 0n;
  for (const k of keys) dist += absDiff(a.get(k) ?? 0n, b.get(k) ?? 0n);
  return dist;
}

/**
 * Plans actions moving `tranches` toward `target`:
 * - tranches whose cooldown has elapsed (now >= lastActionAt + cooldownSec)
 *   and whose allocation differs from the target are rotated fully to the
 *   target, greedily ordered farthest-first by L1 distance (ties by lowest
 *   id);
 * - tranches still cooling down and off target wait until
 *   lastActionAt + cooldownSec (ordered by until asc, then id asc);
 * - tranches already exactly on target produce no action.
 *
 * Pure and deterministic: map iteration order never matters (keys sorted),
 * inputs are never mutated.
 */
export function plan(
  tranches: readonly TrancheState[],
  target: TargetAllocation,
  now: number,
  cooldownSec: number,
): Action[] {
  if (!Number.isInteger(now) || !Number.isInteger(cooldownSec) || cooldownSec < 0) {
    throw new Error(`plan: now/cooldownSec must be integers with cooldownSec >= 0`);
  }
  const seen = new Set<string>();
  for (const tr of tranches) {
    if (seen.has(tr.id)) throw new Error(`plan: duplicate tranche id ${tr.id}`);
    seen.add(tr.id);
  }

  const rotations: { trancheId: string; distance: bigint }[] = [];
  const waits: WaitAction[] = [];
  for (const tranche of tranches) {
    const distance = l1Distance(tranche.allocation, target);
    if (distance === 0n) continue;
    const readyAt = tranche.lastActionAt + cooldownSec;
    if (now >= readyAt) {
      rotations.push({ trancheId: tranche.id, distance });
    } else {
      waits.push({ kind: "wait", trancheId: tranche.id, until: readyAt });
    }
  }

  rotations.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance > b.distance ? -1 : 1;
    return a.trancheId < b.trancheId ? -1 : 1;
  });
  waits.sort((a, b) => {
    if (a.until !== b.until) return a.until - b.until;
    return a.trancheId < b.trancheId ? -1 : 1;
  });

  return [
    ...rotations.map<Action>(({ trancheId }) => ({
      kind: "rotate",
      trancheId,
      allocation: new Map(target),
    })),
    ...waits,
  ];
}

/**
 * Applies a rotate action to a tranche, returning a new TrancheState with
 * the allocation replaced and lastActionAt set to `now`. Pure helper used
 * by the backtester and tests.
 */
export function applyRotation(
  tranche: TrancheState,
  allocation: ReadonlyMap<PoolId, Wad>,
  now: number,
): TrancheState {
  return {
    id: tranche.id,
    positionWeight: tranche.positionWeight,
    lastActionAt: now,
    allocation: new Map(allocation),
  };
}
