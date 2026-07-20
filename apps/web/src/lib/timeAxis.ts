/**
 * Time-axis labeling: historical runs carry real unix timestamps, so ticks
 * and tooltips show real UTC dates; synthetic runs are anchored to an
 * arbitrary constant date, where real dates would mislead; they keep
 * relative day labels (d0, d7, …). All formatting is UTC: the underlying
 * epochs flip at Thursday 00:00 UTC, and a viewer's local zone must not
 * shift which week a point appears in.
 */
import { WEEK } from "@aero-autopilot/core/model";
import type { DisplayResult } from "./serialize.js";

export interface TimeAxis {
  /** Short tick label ("14 Aug" / "d42"). */
  tick(ts: number): string;
  /** Full tooltip label ("Thu 14 Aug 2025" / "day 42.5"). */
  label(ts: number): string;
  /**
   * Tick positions over [minTs, maxTs], aligned to the protocol's week grid:
   * historical runs tick exactly on epoch flips (Thursday 00:00 UTC, ts %
   * WEEK == 0); synthetic runs tick on week multiples of the run start (the
   * start sits 2h past a flip, so raw flips would label as "d6.9"). Thinned
   * to at most `maxTicks` by taking every k-th flip.
   */
  epochTicks(minTs: number, maxTs: number, maxTicks?: number): number[];
}

function weekGridTicks(anchor: number, minTs: number, maxTs: number, maxTicks: number): number[] {
  if (maxTs <= minTs) return [];
  // first grid point >= minTs on the grid { anchor + k·WEEK }
  const first = anchor + Math.ceil((minTs - anchor) / WEEK) * WEEK;
  const all: number[] = [];
  for (let ts = first; ts <= maxTs; ts += WEEK) all.push(ts);
  const stride = Math.max(1, Math.ceil(all.length / maxTicks));
  return all.filter((_, i) => i % stride === 0);
}

const TICK_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const LABEL_FMT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export function timeAxisFor(result: Pick<DisplayResult, "dataKind" | "startTime">): TimeAxis {
  if (result.dataKind === "historical") {
    return {
      tick: (ts) => TICK_FMT.format(new Date(ts * 1000)),
      label: (ts) => LABEL_FMT.format(new Date(ts * 1000)),
      // anchor 0: epoch flips are exactly ts % WEEK == 0 (Thu 00:00 UTC, A1)
      epochTicks: (minTs, maxTs, maxTicks = 8) => weekGridTicks(0, minTs, maxTs, maxTicks),
    };
  }
  const t0 = result.startTime;
  return {
    tick: (ts) => `d${Math.round((ts - t0) / 86_400)}`,
    label: (ts) => `day ${((ts - t0) / 86_400).toFixed(1)}`,
    epochTicks: (minTs, maxTs, maxTicks = 8) => weekGridTicks(t0, minTs, maxTs, maxTicks),
  };
}
