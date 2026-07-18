/**
 * Time-axis labeling: historical runs carry real unix timestamps, so ticks
 * and tooltips show real UTC dates; synthetic runs are anchored to an
 * arbitrary constant date, where real dates would mislead — they keep
 * relative day labels (d0, d7, …). All formatting is UTC: the underlying
 * epochs flip at Thursday 00:00 UTC, and a viewer's local zone must not
 * shift which week a point appears in.
 */
import type { DisplayResult } from "./serialize.js";

export interface TimeAxis {
  /** Short tick label ("14 Aug" / "d42"). */
  tick(ts: number): string;
  /** Full tooltip label ("Thu 14 Aug 2025" / "day 42.5"). */
  label(ts: number): string;
}

const TICK_FMT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
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
    };
  }
  const t0 = result.startTime;
  return {
    tick: (ts) => `d${Math.round((ts - t0) / 86_400)}`,
    label: (ts) => `day ${((ts - t0) / 86_400).toFixed(1)}`,
  };
}
