import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel.js";
import { Gauges } from "./components/Gauges.js";
import { EquityChart } from "./components/EquityChart.js";
import { AllocationHeatmap } from "./components/AllocationHeatmap.js";
import {
  DEFAULT_RUN,
  PRESETS,
  configFromHash,
  configToHash,
  type RunConfig,
} from "./lib/runConfig.js";
import type { DisplayResult, WorkerResponse } from "./lib/serialize.js";

type RunState =
  | { phase: "idle" }
  | { phase: "running" }
  | { phase: "done"; result: DisplayResult; elapsedMs: number }
  | { phase: "error"; message: string };

const STALE_AFTER_DAYS = 14;

export function App() {
  const [config, setConfig] = useState<RunConfig>(() => configFromHash(location.hash) ?? DEFAULT_RUN);
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const datasetRef = useRef<unknown | null>(null);

  useEffect(() => {
    const worker = new Worker(new URL("./worker/backtest.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.type === "done") setRun({ phase: "done", result: msg.result, elapsedMs: msg.elapsedMs });
      else setRun({ phase: "error", message: msg.message });
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  const engage = useCallback(async () => {
    if (!workerRef.current) return;
    setRun({ phase: "running" });
    try {
      let historical: unknown | null = null;
      if (config.data.kind === "historical") {
        if (datasetRef.current === null) {
          const res = await fetch(`${import.meta.env.BASE_URL}data/aerodrome-epochs.v1.json`);
          if (!res.ok) throw new Error("historical dataset not published yet — run `pnpm data` and redeploy");
          datasetRef.current = await res.json();
        }
        historical = datasetRef.current;
      }
      history.replaceState(null, "", configToHash(config));
      workerRef.current.postMessage({ type: "run", config, historical });
    } catch (err) {
      setRun({ phase: "error", message: err instanceof Error ? err.message : String(err) });
    }
  }, [config]);

  const copyLink = useCallback(() => {
    history.replaceState(null, "", configToHash(config));
    void navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [config]);

  const staleness = useMemo(() => {
    // only meaningful for the published historical dataset (synthetic data is
    // deterministic and carries no real generation time)
    if (config.data.kind !== "historical") return null;
    if (run.phase !== "done" || !run.result.datasetGeneratedAt) return null;
    const age = Date.now() - Date.parse(run.result.datasetGeneratedAt);
    if (!Number.isFinite(age)) return null;
    const ageDays = age / 86_400_000;
    return ageDays > STALE_AFTER_DAYS ? Math.floor(ageDays) : null;
  }, [run, config.data.kind]);

  const preset = PRESETS.find((p) => p.id === activePreset);

  return (
    <>
      <header className="masthead">
        <h1>
          Aero Autopilot <span className="thin">/ strategy replay console</span>
        </h1>
        <span className="links">
          deterministic core · shared links replay exactly ·{" "}
          <a href="https://github.com/leo-klima-agents/autopilot" rel="noreferrer">
            source
          </a>
        </span>
      </header>
      <div className={`flight-director ${run.phase === "running" ? "running" : ""}`} aria-hidden>
        <div className="horizon" />
      </div>

      <main className="deck">
        <section aria-label="flight plan">
          <div className="panel">
            <p className="placard">Scenarios</p>
            <div className="preset-bar">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={activePreset === p.id ? "active" : ""}
                  onClick={() => {
                    setConfig(p.config);
                    setActivePreset(p.id);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="preset-blurb">
              {preset ? preset.blurb : "Pick a story scenario, or file your own flight plan below."}
            </p>
          </div>

          <ConfigPanel
            config={config}
            onChange={(next) => {
              setConfig(next);
              setActivePreset(null);
            }}
          />

          <div className="panel">
            <button className="engage" onClick={() => void engage()} disabled={run.phase === "running"}>
              {run.phase === "running" ? "Replay in progress…" : "Engage replay"}
            </button>
          </div>
        </section>

        <section aria-label="instruments">
          {staleness !== null && (
            <div className="banner">
              Historical dataset is {staleness} days old — replaying the last published data (the data pipeline
              refreshes weekly).
            </div>
          )}
          {run.phase === "error" && <div className="banner alert">Replay failed: {run.message}</div>}

          {run.phase === "done" ? (
            <>
              <div className="panel">
                <button className="copy-link" onClick={copyLink}>
                  {copied ? "Copied" : "Copy link to this run"}
                </button>
                <p className="placard">
                  Instruments <span className="unit">· computed in {Math.round(run.elapsedMs)} ms</span>
                </p>
                <Gauges result={run.result} />
              </div>
              <div className="panel">
                <p className="placard">Equity vs passive benchmark</p>
                <EquityChart result={run.result} />
                <div className="legend">
                  <span>
                    <span className="chip" style={{ background: "#6FD3A6" }} />
                    strategy — cumulative revenue per unit weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#E8B44F" }} />
                    passive — global revenue ÷ global weight
                  </span>
                </div>
              </div>
              <div className="panel">
                <p className="placard">Allocation over time</p>
                <AllocationHeatmap result={run.result} />
              </div>
            </>
          ) : (
            run.phase !== "error" && (
              <div className="panel">
                <div className="empty">
                  {run.phase === "running"
                    ? "Replaying the market in a worker — the panel stays live."
                    : "No replay yet. Set a flight plan and engage."}
                </div>
              </div>
            )
          )}
        </section>
      </main>
    </>
  );
}
