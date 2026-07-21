/**
 * The full description of one replay run. Everything the simulator needs is in
 * this object, so serializing it into the URL hash makes every run reproducible
 * from a shared link (the core is deterministic; synthetic data is a pure
 * function of the seed AND the generator version — configs stamp
 * `gen: SYNTHETIC_GENERATOR_VERSION` so links produced under an older
 * generator can be detected instead of silently replaying different numbers).
 */

import { SYNTHETIC_GENERATOR_VERSION } from "@aero-autopilot/core/data/synthetic";

export type StrategyKind =
  | "fixedGridWeekly"
  | "fixedGrid48h"
  | "fixedGrid24h"
  | "fixedGrid1h"
  | "persistenceCarry"
  | "waterFilling"
  | "continuousGreedy";

export type ModelKind = "epoch" | "continuous";
/** Single source for the accepted process kinds: the decode validator and
 *  the ConfigPanel options both derive from this list. */
export const SYNTHETIC_KINDS = ["mixed", "persistent", "bursty", "regime"] as const;
export type SyntheticKind = (typeof SYNTHETIC_KINDS)[number];
export type CrowdKind = "none" | "static" | "herd";

export interface RunConfig {
  strategy: { kind: StrategyKind; config: Record<string, unknown> };
  model: {
    kind: ModelKind;
    /** v3 allocation cooldown, seconds (48h default; 2 = one Base block). */
    cooldownSec: number;
    /** F2 breakage probe: per-position (published intent) vs global. */
    cooldownGranularity: "position" | "global";
    /** Global emission rate, whole tokens per day (Wad-scaled in the model). */
    emissionPerDay: number;
    caps: { enabled: boolean; kappaMilli: number; intervalSec: number; windowSec: number };
    decay: { enabled: boolean; ratePerDayMilli: number };
  };
  data:
    | {
        kind: "historical";
        /** Shift the replay window's END this many weeks back from the
         *  dataset end (0/absent = the latest weeks). The relative,
         *  user-facing control; drifts with each weekly data refresh. */
        endOffsetWeeks?: number;
        /** Absolute window end (unix seconds, snapped to an epoch start),
         *  taking precedence over endOffsetWeeks. Presets that replay a
         *  fixed calendar episode (the Sep 2024 – Mar 2025 cbBTC ramp) use
         *  this so weekly dataset refreshes cannot slide them off it. */
        windowEndTs?: number;
      }
    | {
        kind: "synthetic";
        seed: string;
        poolCount: number;
        epochCount: number;
        process: SyntheticKind;
        /** Generator version stamped at config creation; a mismatch with
         *  the running core means the link predates a recalibration and
         *  reproduces different numbers (surfaced as a banner). */
        gen?: number;
      };
  crowd: {
    kind: CrowdKind;
    /** Herd information lag, seconds. */
    lagSec: number;
    /** Crowd weight as a multiple of our portfolio weight. */
    multiple: number;
    /** Optional wash-bait overlay on one pool (by index into the sorted universe). */
    washBait?: { poolIndex: number; rateMultiple: number };
  };
  run: { durationWeeks: number; stepSec: number; trancheCount: number; trancheTokens: number };
}

/** Fresh synthetic data config stamped with the running generator version. */
export function syntheticData(
  overrides: Partial<Omit<Extract<RunConfig["data"], { kind: "synthetic" }>, "kind" | "gen">> = {},
): RunConfig["data"] {
  return {
    kind: "synthetic",
    seed: "42",
    poolCount: 8,
    epochCount: 20,
    process: "mixed",
    gen: SYNTHETIC_GENERATOR_VERSION,
    ...overrides,
  };
}

export const DEFAULT_RUN: RunConfig = {
  strategy: { kind: "persistenceCarry", config: {} },
  model: {
    kind: "continuous",
    cooldownSec: 172_800,
    cooldownGranularity: "position",
    emissionPerDay: 100_000,
    caps: { enabled: true, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
    decay: { enabled: false, ratePerDayMilli: 10 },
  },
  data: syntheticData(),
  crowd: { kind: "herd", lagSec: 604_800, multiple: 10 },
  run: { durationWeeks: 12, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
};

/** Thu 2025-03-06 00:00 UTC: the end of the published cbBTC study window
 *  (launch Sep 2024 + 26 weeks). An absolute anchor, deliberately not an
 *  offset from the dataset end — see `windowEndTs` above. */
const CBBTC_WINDOW_END_TS = 1_741_219_200;

/** One-click story scenarios (brief §9). */
export const PRESETS: { id: string; label: string; blurb: string; config: RunConfig }[] = [
  {
    id: "early-allocator",
    label: "Early allocator",
    blurb:
      "The cbBTC arc, synthetically: the mixed universe's CL100-USDC/cbBTC pool ramps ~20× over ten weeks. A 24h-signal allocator on a 48h cooldown takes weight before the two-week-lagged crowd arrives — the capture table shows it earning ~1.4× the passive expectation from that pool (the published 43% early-allocator edge), decaying as the herd catches up.",
    config: {
      strategy: { kind: "persistenceCarry", config: { lookbackSec: 86_400 } },
      model: { ...DEFAULT_RUN.model },
      data: syntheticData({ seed: "13" }),
      crowd: { kind: "herd", lagSec: 14 * 86_400, multiple: 12 },
      run: { durationWeeks: 16, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
    },
  },
  {
    id: "cbbtc-backtest",
    label: "cbBTC backtest",
    blurb:
      "The real thing: the replay window is pinned to Sep 2024 – Mar 2025, when cbBTC launched on Base and CL100-WETH/cbBTC fees ramped from zero to ~$800k/week. Watch the cbBTC rows light up in the heat-maps and read the capture table — the same arc the published early-allocator backtest measured at 1.43×.",
    config: {
      strategy: { kind: "persistenceCarry", config: { lookbackSec: 86_400 } },
      model: { ...DEFAULT_RUN.model },
      data: { kind: "historical", windowEndTs: CBBTC_WINDOW_END_TS },
      crowd: { kind: "herd", lagSec: 14 * 86_400, multiple: 12 },
      run: { durationWeeks: 26, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
    },
  },
  {
    id: "latency-race",
    label: "Latency race",
    blurb:
      "ContinuousGreedy at a one-block cooldown: reactive returns at this cadence converge to the system average minus costs, the demonstration of its own futility (P3).",
    config: {
      strategy: { kind: "continuousGreedy", config: {} },
      model: {
        ...DEFAULT_RUN.model,
        cooldownSec: 2,
        caps: { ...DEFAULT_RUN.model.caps, enabled: false },
      },
      data: syntheticData({ seed: "99", epochCount: 8, process: "persistent" }),
      crowd: { kind: "herd", lagSec: 3600, multiple: 10 },
      run: { durationWeeks: 4, stepSec: 1800, trancheCount: 2, trancheTokens: 500_000 },
    },
  },
  {
    id: "wash-bait",
    label: "Wash-bait",
    blurb:
      "An adversarial pool pumps fake fees in bursts. The volatility haircut in PersistenceCarry (the organic-flow filter's ancestor) refuses the bait that a naive trailing-fee grid would chase.",
    config: {
      strategy: { kind: "persistenceCarry", config: { haircutWad: "900000000000000000" } },
      model: { ...DEFAULT_RUN.model },
      data: syntheticData({ seed: "13", poolCount: 6, epochCount: 16, process: "persistent" }),
      crowd: { kind: "herd", lagSec: 604_800, multiple: 10, washBait: { poolIndex: 2, rateMultiple: 8 } },
      run: { durationWeeks: 10, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
    },
  },
];

// ---------------------------------------------------------------------------
// URL hash serialization, the whole config, base64url-encoded JSON
// ---------------------------------------------------------------------------

function toBase64Url(s: string): string {
  const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(s)));
  return b64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(s: string): string {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeRunConfig(config: RunConfig): string {
  return toBase64Url(JSON.stringify(config));
}

export function decodeRunConfig(encoded: string): RunConfig {
  const parsed: unknown = JSON.parse(fromBase64Url(encoded));
  if (typeof parsed !== "object" || parsed === null) throw new Error("invalid run config");
  const cfg = parsed as RunConfig;
  if (!cfg.strategy?.kind || !cfg.model?.kind || !cfg.data?.kind || !cfg.run) {
    throw new Error("invalid run config");
  }
  // Validate the data variant at the boundary: a malformed hash should fall
  // back to DEFAULT_RUN (configFromHash catches this throw), not fail deep
  // inside the worker with a raw generator error.
  if (cfg.data.kind === "synthetic") {
    if (!SYNTHETIC_KINDS.includes(cfg.data.process)) throw new Error("invalid run config");
  } else if (cfg.data.kind === "historical") {
    // Window fields: keep well-formed values, silently DROPPING nothing —
    // a malformed value invalidates the whole config (same policy as an
    // unknown process kind) so the run never quietly ignores an intent.
    for (const field of ["endOffsetWeeks", "windowEndTs"] as const) {
      const value = cfg.data[field];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new Error("invalid run config");
      }
    }
  } else {
    throw new Error("invalid run config");
  }
  return cfg;
}

export function configToHash(config: RunConfig): string {
  return `#run=${encodeRunConfig(config)}`;
}

export function configFromHash(hash: string): RunConfig | undefined {
  const match = /#run=([A-Za-z0-9_-]+)/.exec(hash);
  if (!match?.[1]) return undefined;
  try {
    return decodeRunConfig(match[1]);
  } catch {
    return undefined;
  }
}
