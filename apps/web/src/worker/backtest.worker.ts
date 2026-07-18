/// <reference lib="webworker" />
/**
 * Backtests run off the main thread; the UI stays responsive. Input is the
 * full RunConfig (+ historical dataset JSON when selected); output is the
 * display-ready result (bigints already converted — see serialize.ts).
 */
import { buildAndRun } from "../lib/buildRun.js";
import { toDisplayResult, type WorkerRequest, type WorkerResponse } from "../lib/serialize.js";
import type { RunConfig } from "../lib/runConfig.js";

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.type !== "run") return;
  const started = performance.now();
  try {
    const run = buildAndRun(msg.config as RunConfig, msg.historical);
    const response: WorkerResponse = {
      type: "done",
      seq: msg.seq,
      result: toDisplayResult(run),
      elapsedMs: performance.now() - started,
    };
    self.postMessage(response);
  } catch (err) {
    const response: WorkerResponse = {
      type: "error",
      seq: msg.seq,
      message: err instanceof Error ? err.message : String(err),
    };
    self.postMessage(response);
  }
};
