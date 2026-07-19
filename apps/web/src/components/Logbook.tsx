/**
 * The logbook: curated, reproducible runs that each demonstrate one load-
 * bearing fact about the Aero economy or the instruments. Every entry is a
 * complete RunConfig, "open run" replays it live, and the link is the same
 * URL-hash any shared run uses, so entries stay bit-reproducible. Synthetic
 * entries are seeded and reproduce forever; historical figures cited in the
 * notes were read from the July 2026 dataset and drift as the weekly data
 * refresh moves the replay window.
 */
import { configToHash, DEFAULT_RUN, PRESETS, type RunConfig } from "../lib/runConfig.js";

const presetConfig = (id: string): RunConfig => {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) throw new Error(`unknown preset: ${id}`);
  return preset.config;
};

const MODEL_V3 = {
  kind: "continuous",
  cooldownSec: 172_800,
  cooldownGranularity: "position",
  emissionPerDay: 100_000,
  caps: { enabled: true, kappaMilli: 1200, intervalSec: 172_800, windowSec: 172_800 },
  decay: { enabled: false, ratePerDayMilli: 10 },
} as const;
const MODEL_V2 = { ...MODEL_V3, kind: "epoch" } as const;
const RUN_12W = { durationWeeks: 12, stepSec: 3600, trancheCount: 4, trancheTokens: 250_000 } as const;
const HERD_7D = { kind: "herd", lagSec: 604_800, multiple: 10 } as const;

interface LogEntry {
  id: string;
  title: string;
  config: RunConfig;
  why: string;
  read: string;
}

/** Exported for the round-trip test: every config must survive the URL hash. */
export const LOGBOOK: LogEntry[] = [
  {
    id: "venue-replayed",
    title: "The venue, replayed",
    config: { ...DEFAULT_RUN, data: { kind: "historical" } },
    why: "The baseline: Persistence carry against the latest twelve weeks of real Aerodrome data with a week-lagged herd. This is the run every other entry should be compared to.",
    read:
      "Start at the Vs-market gauge: the strategy beats the market benchmark and captures roughly half of the " +
      "foresight edge. Then flip the heat-map toggle through all three portfolios, the strategy's allocation is " +
      "visibly more concentrated than the market's, and the earned map shows CL pools carrying most of the venue's " +
      "revenue. USD figures are Alchemy-priced fees plus bribes.",
  },
  {
    id: "late-voter-v2",
    title: "The late voter (v2 pays backwards)",
    config: {
      strategy: { kind: "fixedGridWeekly", config: {} },
      model: MODEL_V2,
      data: { kind: "historical" },
      crowd: HERD_7D,
      run: RUN_12W,
    },
    why:
      "The weekly Revenue mirror votes an hour before each flip using the trailing week's revenue, the classic " +
      "$/vote late-voter play. Because Aerodrome v2 pays the WHOLE epoch's rewards to end-of-epoch vote weights, " +
      "this near-zero-effort strategy captures almost the entire foresight edge (~97% on the July 2026 dataset).",
    read:
      "The phosphor equity line runs almost on top of the cyan revenue benchmark, mirroring realized revenue is " +
      "nearly optimal when payouts are retroactive. Note how few rotations the turnover gauge shows: one vote per " +
      "epoch is all it takes. This is the run that explains why v2 needed no autopilot.",
  },
  {
    id: "same-plan-v3",
    title: "The same plan on v3 (streaming)",
    config: {
      strategy: { kind: "fixedGridWeekly", config: {} },
      model: MODEL_V3,
      data: { kind: "historical" },
      crowd: HERD_7D,
      run: RUN_12W,
    },
    why:
      "The identical weekly mirror, same data, same crowd, only the economy is switched from v2 epochs to v3 " +
      "continuous streaming. Capture collapses (~97% → ~25% on the July 2026 dataset) because revenue now pays " +
      "current weights: allocating after you observe revenue earns only what comes afterward.",
    read:
      "Open this back-to-back with the late-voter entry and compare the captured figure, the difference is " +
      "retroactivity, nothing else. This pair is the project's thesis in two links: v3's design converts " +
      "\"vote where revenue was\" from a winning strategy into a losing one, leaving prediction as the only edge.",
  },
  {
    id: "beating-the-ruler",
    title: "Beating the ruler",
    config: {
      strategy: { kind: "waterFilling", config: {} },
      model: { ...MODEL_V3, cooldownSec: 3600 },
      data: { kind: "synthetic", seed: "42", poolCount: 8, epochCount: 20, process: "persistent" },
      crowd: { kind: "static", lagSec: 604_800, multiple: 10 },
      run: { ...RUN_12W, durationWeeks: 16 },
    },
    why:
      "Water-filling against a static equal-weight crowd on persistent synthetic revenue: captured exceeds 100%, " +
      "the strategy finishes ABOVE the revenue benchmark, with no foresight. Proof that revenue-proportional is " +
      "not the ceiling (Theory §7): the optimal response concentrates where revenue is high relative to the " +
      "crowd's weight, and a static crowd is maximally exploitable.",
    read:
      "The phosphor line crosses and stays above the cyan one. In the earned heat-map, compare the strategy view " +
      "against the revenue-bench view: water-filling takes MORE than proportional share from thin high-revenue " +
      "pools and skips crowded ones. Seeded and synthetic, so these numbers reproduce exactly, forever.",
  },
  {
    id: "edge-decays",
    title: "The edge decays",
    config: {
      ...DEFAULT_RUN,
      data: { kind: "historical" },
      crowd: { kind: "herd", lagSec: 86_400, multiple: 10 },
    },
    why:
      "The baseline run with one change: the herd's information lag drops from seven days to one. The foresight " +
      "edge (revenue bench − market bench) shrinks by roughly two thirds and capture collapses to near zero, the " +
      "market got efficient, and there was almost nothing left to win.",
    read:
      "Compare the gap between the two dashed lines here and in the baseline entry: that gap IS the edge, and it " +
      "belongs to the market, not the strategy. A flat vs-market with a collapsed edge is not strategy failure, " +
      "it is the signal to cut turnover. This is the structural trend to expect as the venue's tooling matures.",
  },
  {
    id: "latency-race",
    title: "Latency race (fast is not smart)",
    config: presetConfig("latency-race"),
    why:
      "Continuous greedy at a one-block cooldown against a one-hour-lagged crowd on bursty revenue. It captures a " +
      "high fraction of the edge, but look at how small the edge is: with a crowd this fast, the benchmarks " +
      "nearly touch, and reactive returns converge to the system average. Speed alone demonstrates its own " +
      "futility (design principle P3: sub-weekly value is simulation-only).",
    read:
      "The three equity lines almost coincide, read the absolute vs-market number, not the captured percentage. " +
      "A high capture of a vanishing edge pays for no infrastructure. Compare with the edge-decays entry: same " +
      "lesson from the crowd side instead of the strategy side.",
  },
  {
    id: "early-allocator",
    title: "Early allocator (the cbBTC arc)",
    config: presetConfig("early-allocator"),
    why:
      "A regime-switching market with a three-day-lagged crowd: persistence scoring takes weight in a pool as its " +
      "revenue regime turns on, earns an outsized share while alone, and cedes it as the herd arrives, the " +
      "published cbBTC early-allocator story, reproduced synthetically.",
    read:
      "Watch the allocation heat-map for a row that lights up before the same row brightens in the market-bench " +
      "view; that lead time is the whole trade. The equity gap over the market benchmark opens exactly during " +
      "the solo window and plateaus once the crowd catches up.",
  },
  {
    id: "wash-bait",
    title: "Wash-bait (the ruler can be lied to)",
    config: presetConfig("wash-bait"),
    why:
      "One pool pumps fake fees in two-day bursts at 8× its organic rate. Persistence-aware scoring with a heavy " +
      "haircut mostly refuses the bait, but notice the captured figure goes NEGATIVE. The revenue benchmark " +
      "counts the pumped revenue as real, so the ruler itself is corrupted by adversarial data.",
    read:
      "In the earned heat-map, the baited pool's row flashes in the revenue-bench view (the benchmark chases every " +
      "burst) while staying dim in the strategy view. The lesson is a caveat, not a victory: when revenue can be " +
      "manufactured, capture is only as trustworthy as the revenue signal, which is why persistence filtering " +
      "exists at all.",
  },
];

export function Logbook({
  onClose,
  onOpenRun,
}: {
  onClose: () => void;
  onOpenRun: (config: RunConfig) => void;
}) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>Logbook, notable flights</h2>
        <p>
          Curated runs that each demonstrate one load-bearing fact about the economy or the instruments. Every
          entry replays live from its config, the "open run" button loads it into the console, and the link is an
          ordinary shareable run URL. Synthetic entries are seeded and reproduce bit-for-bit forever; figures
          quoted for historical entries were read from the July 2026 dataset and drift as the weekly data refresh
          moves the replay window. Background for all of them is on the Theory page.
        </p>
      </div>

      {LOGBOOK.map((entry) => (
        <div className="panel" key={entry.id}>
          <div className="panel-head">
            <h2>{entry.title}</h2>
            <a
              className="copy-link"
              href={configToHash(entry.config)}
              onClick={(e) => {
                e.preventDefault();
                onOpenRun(entry.config);
              }}
            >
              open run →
            </a>
          </div>
          <p>{entry.why}</p>
          <p>
            <strong>How to read it:</strong> {entry.read}
          </p>
        </div>
      ))}
    </main>
  );
}
