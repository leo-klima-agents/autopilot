/**
 * Turns a RunConfig (+ optional historical dataset JSON) into a finished
 * BacktestResult. Pure with respect to its inputs, the core is deterministic,
 * so the same config + dataset always replays identically (URL reproducibility).
 * Runs inside the web worker.
 */
import { WAD } from "@aero-autopilot/core/math";
import {
  WEEK,
  HOUR,
  epochStart,
  createContinuousModel,
  createEpochModel,
  reactiveHerd,
  staticCrowd,
  adversarialWashBait,
  type CrowdModel,
  type ProtocolModel,
  type RevenueProcess,
  type Wad,
} from "@aero-autopilot/core/model";
import {
  fixedGridWeekly,
  fixedGrid48h,
  fixedGrid24h,
  fixedGrid1h,
  persistenceCarry,
  waterFilling,
  continuousGreedy,
  type Strategy,
} from "@aero-autopilot/core/strategies";
import { runBacktest, type BacktestResult } from "@aero-autopilot/core/backtest";
// deep imports: the /data barrel pulls in node-only modules (fs-backed token
// cache, indexer CLI) that cannot bundle for the browser
import { validateDataset, type DatasetV1 } from "@aero-autopilot/core/data/schema";
import { generateSyntheticDataset } from "@aero-autopilot/core/data/synthetic";
import { revenueProcessFromDataset } from "@aero-autopilot/core/data/revenue";
import type { RunConfig, StrategyKind } from "./runConfig.js";

const STRATEGY_FACTORIES: Record<StrategyKind, (config: Record<string, unknown>) => Strategy> = {
  fixedGridWeekly: (c) => fixedGridWeekly(c),
  fixedGrid48h: (c) => fixedGrid48h(c),
  fixedGrid24h: (c) => fixedGrid24h(c),
  fixedGrid1h: (c) => fixedGrid1h(c),
  persistenceCarry: (c) => persistenceCarry(c),
  waterFilling: (c) => waterFilling(c),
  continuousGreedy: (c) => continuousGreedy(c),
};

/** Probe instances used by the UI to read configSchema + defaults. */
export function probeStrategy(kind: StrategyKind): Strategy {
  return STRATEGY_FACTORIES[kind]({});
}

/** Wad-typed config fields travel as decimal strings in JSON; convert here. */
function reviveStrategyConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = key.endsWith("Wad") && typeof value === "string" ? BigInt(value) : value;
  }
  return out;
}

export interface BuiltRun {
  result: BacktestResult;
  poolNames: Map<string, string>;
  datasetGeneratedAt: string | undefined;
  /** Historical timestamps are real dates; synthetic ones are an arbitrary anchor. */
  dataKind: "historical" | "synthetic";
  /** "usd" when the dataset carries Alchemy-priced revenue; "index" otherwise
   *  (synthetic data sets feesUsd too, but its values are index units). */
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

export function buildAndRun(config: RunConfig, historical: unknown | null): BuiltRun {
  // -- dataset --------------------------------------------------------------
  let dataset: DatasetV1;
  if (config.data.kind === "historical") {
    if (historical === null) throw new Error("historical dataset not loaded");
    dataset = validateDataset(historical);
  } else {
    dataset = generateSyntheticDataset({
      seed: BigInt(config.data.seed),
      poolCount: config.data.poolCount,
      epochCount: config.data.epochCount,
      kind: config.data.process,
    });
  }
  const poolNames = new Map(dataset.pools.map((p) => [p.address, p.displayName]));

  // -- revenue process (+ optional wash-bait overlay) ------------------------
  let revenue: RevenueProcess = revenueProcessFromDataset(dataset);
  const epochs = dataset.pools[0]?.epochs ?? [];
  if (epochs.length < 3) throw new Error("dataset needs at least 3 epochs");
  // epoch order is source-dependent (sugar returns newest-first), scan all
  const allTs = dataset.pools.flatMap((p) => p.epochs.map((e) => e.ts));
  if (allTs.length === 0) throw new Error("dataset has no epochs");
  const dataStart = Math.min(...allTs);
  const lastEpochStart = Math.max(...allTs);
  // The newest historical epoch is usually still in progress at index time
  // (generatedAt falls inside it): its rewards are partially accumulated and
  // its week extends past "now". Replay only through complete epochs.
  const generatedAtSec = Date.parse(dataset.generatedAt) / 1000;
  const lastEpochPartial =
    config.data.kind === "historical" && generatedAtSec < lastEpochStart + WEEK;
  const naturalEnd = lastEpochPartial ? lastEpochStart : lastEpochStart + WEEK;
  // Historical runs may park the window's end in the past to replay a
  // specific episode: `windowEndTs` pins an absolute date (refresh-proof,
  // what presets use), `endOffsetWeeks` is the relative UI control.
  // Synthetic runs ignore both (their start is already fixed).
  const windowEndTs = config.data.kind === "historical" ? config.data.windowEndTs : undefined;
  const endOffsetWeeks =
    config.data.kind === "historical" ? Math.floor(config.data.endOffsetWeeks ?? 0) : 0;
  const explicitEnd = windowEndTs !== undefined || endOffsetWeeks > 0;
  // The window ends AT the pinned timestamp (snapped down to an epoch
  // boundary), never past the dataset's own end.
  const dataEnd =
    windowEndTs !== undefined
      ? Math.min(naturalEnd, epochStart(windowEndTs))
      : naturalEnd - endOffsetWeeks * WEEK;
  if (explicitEnd && dataEnd <= dataStart + WEEK) {
    throw new Error("window end offset reaches past the start of the dataset");
  }

  const wash = config.crowd.washBait;
  if (wash) {
    const pools = [...revenue.pools].sort();
    const target = pools[Math.min(wash.poolIndex, pools.length - 1)]!;
    // baseline: the pool's own average revenue rate over the dataset
    const baseRate = revenue.revenueBetween(target, dataStart, dataEnd) / BigInt(dataEnd - dataStart);
    const pump = baseRate * BigInt(Math.max(1, wash.rateMultiple));
    // alternating 2-day pumps starting in week 2
    const schedule = [];
    for (let ts = dataStart + 2 * WEEK; ts + 2 * 86_400 < dataEnd; ts += 2 * WEEK) {
      schedule.push({ start: ts, end: ts + 2 * 86_400, ratePerSecWad: pump });
    }
    revenue = adversarialWashBait(revenue, target, schedule);
  }

  // -- timing ----------------------------------------------------------------
  const stepSec = config.run.stepSec;
  // Earliest allowed start: one week of history for signals. Historical runs
  // anchor the window at its effective END (the dataset's end, unless a
  // window pin moved it into the past) so a short duration replays the weeks
  // leading up to that end, not the oldest ones; synthetic processes are
  // stationary, so they keep the fixed start.
  const earliestStart = dataStart + WEEK;
  const anchoredStart =
    config.data.kind === "historical"
      ? Math.max(earliestStart, dataEnd - config.run.durationWeeks * WEEK)
      : earliestStart;
  // +2h clears the v2 distribute window at the epoch flip
  const startTime = anchoredStart + 2 * HOUR;
  const maxDuration = dataEnd - startTime;
  let durationSec = Math.min(config.run.durationWeeks * WEEK, maxDuration);
  durationSec -= durationSec % stepSec;
  if (durationSec <= 0) throw new Error("duration too short for the dataset");
  // A pinned window end that cannot fit the requested duration would
  // otherwise clamp silently and replay a much shorter span than the user
  // asked for (metrics over the wrong window). The +2h start shave and step
  // rounding legitimately cost < 1 week; anything more is an error. Runs
  // without an explicit end keep the documented benign clamping ("asked for
  // more weeks than exist, got everything").
  if (explicitEnd && durationSec < config.run.durationWeeks * WEEK - WEEK) {
    throw new Error(
      "window end offset leaves less history than the requested duration; shorten the run or reduce the offset",
    );
  }

  // -- model -----------------------------------------------------------------
  const emissionRatePerSec = (BigInt(config.model.emissionPerDay) * WAD) / 86_400n;
  let model: ProtocolModel;
  if (config.model.kind === "epoch") {
    model = createEpochModel({ revenue, startTime });
  } else {
    model = createContinuousModel({
      revenue,
      startTime,
      cooldownSec: config.model.cooldownSec,
      cooldownGranularity: config.model.cooldownGranularity,
      emissionRatePerSec,
      caps: config.model.caps.enabled
        ? {
            enabled: true,
            kappaWad: (BigInt(config.model.caps.kappaMilli) * WAD) / 1000n,
            intervalSec: config.model.caps.intervalSec,
            windowSec: config.model.caps.windowSec,
          }
        : { enabled: false },
      decay: config.model.decay.enabled
        ? {
            enabled: true,
            ratePerSecWad: (BigInt(config.model.decay.ratePerDayMilli) * WAD) / 1000n / 86_400n,
          }
        : { enabled: false, ratePerSecWad: 0n },
    });
  }

  // -- crowd -----------------------------------------------------------------
  const trancheWeight: Wad = BigInt(config.run.trancheTokens) * WAD;
  const portfolioWeight = trancheWeight * BigInt(config.run.trancheCount);
  let crowd: CrowdModel | undefined;
  if (config.crowd.kind === "herd") {
    crowd = reactiveHerd({
      revenue,
      totalWeight: portfolioWeight * BigInt(config.crowd.multiple),
      lagSeconds: config.crowd.lagSec,
    });
  } else if (config.crowd.kind === "static") {
    const pools = [...revenue.pools].sort();
    const per = (portfolioWeight * BigInt(config.crowd.multiple)) / BigInt(pools.length);
    crowd = staticCrowd(new Map(pools.map((p) => [p, per])));
  }

  // -- strategy + run ----------------------------------------------------------
  const strategy = STRATEGY_FACTORIES[config.strategy.kind](reviveStrategyConfig(config.strategy.config));
  const cooldownSec = config.model.kind === "epoch" ? WEEK : config.model.cooldownSec;
  const steps = durationSec / stepSec;
  const sampleEvery = Math.max(1, Math.floor(steps / 400));
  // herd re-weighting every 6h of sim time (not every step), the dominant
  // cost of a run; negligible fidelity change at day-scale information lags
  const crowdUpdateSec = Math.max(stepSec, Math.floor(21_600 / stepSec) * stepSec);

  const result = runBacktest(strategy, model, {
    startTime,
    durationSec,
    stepSec,
    trancheCount: config.run.trancheCount,
    trancheWeight,
    cooldownSec,
    sampleIntervalSec: sampleEvery * stepSec,
    crowdUpdateSec,
    ...(crowd ? { crowd } : {}),
  });

  const revenueUnit: "usd" | "index" =
    dataset.source === "sugar" && dataset.pools.some((p) => p.epochs.some((e) => e.feesUsd !== undefined))
      ? "usd"
      : "index";

  return {
    result,
    poolNames,
    datasetGeneratedAt: (dataset as { generatedAt?: string }).generatedAt,
    dataKind: config.data.kind,
    revenueUnit,
    startTime,
    durationSec,
  };
}
