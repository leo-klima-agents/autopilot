/**
 * Explicit worker-boundary serialization. BacktestResult carries bigints
 * (Wads), which structured clone supports but our chart layer wants plain
 * floats, so the worker sends a display-ready shape and nothing downstream
 * touches bigint again. Conversion Wad → float is analytics-only (P2 allows
 * floats outside fixture paths).
 */
import type { BuiltRun } from "./buildRun.js";

export interface DisplayResult {
  totalReturn: number;
  marketBenchmarkReturn: number;
  /** Foresight (revenue-proportional) benchmark return, the ceiling reference. */
  revenueBenchmarkReturn: number;
  returnVsMarket: number;
  maxDrawdownVsMarket: number;
  turnover: number;
  rotations: number;
  blockedSubmissions: number;
  onTargetPct: number;
  offTargetPct: number;
  poolSamples: number;
  equity: { times: number[]; equity: number[]; marketBenchmark: number[]; revenueBenchmark: number[] };
  allocation: {
    times: number[];
    pools: string[];
    poolNames: string[];
    weights: number[][];
    /** Cumulative revenue earned from each pool (raw units, not per weight). */
    earned: number[][];
    /** Pool share of GLOBAL weight, the market benchmark's holdings. */
    marketBenchmarkWeights: number[][];
    /** Cumulative revenue the market benchmark portfolio of our size earned. */
    marketBenchmarkEarned: number[][];
    /** The foresight benchmark's holdings: each epoch's revenue shares. */
    revenueBenchmarkWeights: number[][];
    /** Cumulative revenue the foresight benchmark earned per pool. */
    revenueBenchmarkEarned: number[][];
  };
  datasetGeneratedAt: string | undefined;
  /** Historical timestamps are real dates; synthetic ones are an arbitrary anchor. */
  dataKind: "historical" | "synthetic";
  /** "usd" when revenue is Alchemy-priced USD; "index" for synthetic units. */
  revenueUnit: "usd" | "index";
  startTime: number;
  durationSec: number;
}

const WAD = 1e18;

export function toDisplayResult(run: BuiltRun): DisplayResult {
  const { result } = run;
  return {
    totalReturn: Number(result.totalReturn) / WAD,
    marketBenchmarkReturn: Number(result.marketBenchmarkReturn) / WAD,
    revenueBenchmarkReturn: Number(result.revenueBenchmarkReturn) / WAD,
    returnVsMarket: Number(result.returnVsMarket) / WAD,
    maxDrawdownVsMarket: Number(result.maxDrawdownVsMarket) / WAD,
    turnover: Number(result.turnover) / WAD,
    rotations: result.rotations,
    blockedSubmissions: result.blockedSubmissions,
    onTargetPct: result.onTargetPct,
    offTargetPct: result.offTargetPct,
    poolSamples: result.poolSamples,
    equity: {
      times: result.equityCurve.times,
      equity: result.equityCurve.equity.map((w) => Number(w) / WAD),
      marketBenchmark: result.equityCurve.marketBenchmark.map((w) => Number(w) / WAD),
      revenueBenchmark: result.equityCurve.revenueBenchmark.map((w) => Number(w) / WAD),
    },
    allocation: {
      times: result.allocationHistory.times,
      pools: result.allocationHistory.pools,
      poolNames: result.allocationHistory.pools.map((p) => run.poolNames.get(p) ?? p),
      weights: result.allocationHistory.weights.map((row) => row.map((w) => Number(w) / WAD)),
      earned: result.allocationHistory.earned.map((row) => row.map((w) => Number(w) / WAD)),
      marketBenchmarkWeights: result.allocationHistory.marketBenchmarkWeights.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      marketBenchmarkEarned: result.allocationHistory.marketBenchmarkEarned.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      revenueBenchmarkWeights: result.allocationHistory.revenueBenchmarkWeights.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
      revenueBenchmarkEarned: result.allocationHistory.revenueBenchmarkEarned.map((row) =>
        row.map((w) => Number(w) / WAD),
      ),
    },
    datasetGeneratedAt: run.datasetGeneratedAt,
    dataKind: run.dataKind,
    revenueUnit: run.revenueUnit,
    startTime: run.startTime,
    durationSec: run.durationSec,
  };
}

export type WorkerRequest = { type: "run"; seq: number; config: unknown; historical: unknown | null };
export type WorkerResponse =
  | { type: "done"; seq: number; result: DisplayResult; elapsedMs: number }
  | { type: "error"; seq: number; message: string };
