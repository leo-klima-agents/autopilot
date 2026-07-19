/**
 * The full description of one replay run. Everything the simulator needs is in
 * this object, so serializing it into the URL hash makes every run reproducible
 * from a shared link (the core is deterministic; synthetic data is a pure
 * function of the seed).
 */

export type StrategyKind =
  | "fixedGridWeekly"
  | "fixedGrid48h"
  | "fixedGrid24h"
  | "fixedGrid1h"
  | "persistenceCarry"
  | "waterFilling"
  | "continuousGreedy";

export type ModelKind = "epoch" | "continuous";
export type SyntheticKind = "persistent" | "bursty" | "regime";
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
    | { kind: "historical" }
    | { kind: "synthetic"; seed: string; poolCount: number; epochCount: number; process: SyntheticKind };
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
  data: { kind: "synthetic", seed: "42", poolCount: 8, epochCount: 20, process: "persistent" },
  crowd: { kind: "herd", lagSec: 604_800, multiple: 10 },
  run: { durationWeeks: 12, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
};

/** One-click story scenarios (brief §9). */
export const PRESETS: { id: string; label: string; blurb: string; config: RunConfig }[] = [
  {
    id: "early-allocator",
    label: "Early allocator",
    blurb:
      "The cbBTC arc: a persistence-aware strategy takes weight in a growing pool before the lagged crowd arrives, earns an outsized revenue share, and cedes it as the herd catches up.",
    config: {
      strategy: { kind: "persistenceCarry", config: { lookbackSec: 172_800 } },
      model: {
        kind: "continuous",
        cooldownSec: 172_800,
        cooldownGranularity: "position",
        emissionPerDay: 100_000,
        caps: { enabled: true, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
        decay: { enabled: false, ratePerDayMilli: 10 },
      },
      data: { kind: "synthetic", seed: "7", poolCount: 6, epochCount: 20, process: "regime" },
      crowd: { kind: "herd", lagSec: 3 * 86_400, multiple: 12 },
      run: { durationWeeks: 14, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 },
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
        kind: "continuous",
        cooldownSec: 2,
        cooldownGranularity: "position",
        emissionPerDay: 100_000,
        caps: { enabled: false, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
        decay: { enabled: false, ratePerDayMilli: 10 },
      },
      data: { kind: "synthetic", seed: "99", poolCount: 8, epochCount: 8, process: "bursty" },
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
      model: {
        kind: "continuous",
        cooldownSec: 172_800,
        cooldownGranularity: "position",
        emissionPerDay: 100_000,
        caps: { enabled: true, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
        decay: { enabled: false, ratePerDayMilli: 10 },
      },
      data: { kind: "synthetic", seed: "13", poolCount: 6, epochCount: 16, process: "persistent" },
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
