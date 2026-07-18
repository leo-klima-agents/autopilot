import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel.js";
import { Guide } from "./components/Guide.js";
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

const STALE_AFTER_DAYS = 14;
const DEBOUNCE_MS = 300;

/** Live replay state: the last good result stays on the instruments while a
 *  newer run computes (or a half-typed config errors) — no flicker, no button. */
interface LiveState {
  result: DisplayResult | null;
  elapsedMs: number;
  running: boolean;
  error: string | null;
}

export function App() {
  const [config, setConfig] = useState<RunConfig>(() => configFromHash(location.hash) ?? DEFAULT_RUN);
  const [view, setView] = useState<"console" | "guide">(() =>
    location.hash === "#guide" ? "guide" : "console",
  );

  // hash navigation (back button, pasted #guide links on an already-open page)
  useEffect(() => {
    const onHashChange = () => {
      if (location.hash === "#guide") setView("guide");
      else if (location.hash.startsWith("#run=")) setView("console");
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const [live, setLive] = useState<LiveState>({ result: null, elapsedMs: 0, running: false, error: null });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const datasetRef = useRef<unknown | null>(null);
  // generation counter: responses older than the latest request are dropped
  const seqRef = useRef(0);

  const busyRef = useRef(false);

  const spawnWorker = useCallback(() => {
    const worker = new Worker(new URL("./worker/backtest.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const msg = event.data;
      if (msg.seq !== seqRef.current) return; // stale run — a newer config superseded it
      busyRef.current = false;
      if (msg.type === "done") {
        setLive({ result: msg.result, elapsedMs: msg.elapsedMs, running: false, error: null });
      } else {
        setLive((prev) => ({ ...prev, running: false, error: msg.message }));
      }
    };
    workerRef.current = worker;
    return worker;
  }, []);

  useEffect(() => {
    const worker = spawnWorker();
    return () => worker.terminate();
  }, [spawnWorker]);

  // live replay: every config change re-runs after a short debounce
  useEffect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        if (!workerRef.current) return;
        const seq = ++seqRef.current;
        setLive((prev) => ({ ...prev, running: true }));
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
          if (seq !== seqRef.current) return; // superseded while fetching
          history.replaceState(null, "", configToHash(config)); // replace, never push — no history spam
          // true cancellation: a worker mid-computation can't be interrupted, so a
          // superseding run kills it and posts to a fresh one instead of queueing
          if (busyRef.current) {
            workerRef.current?.terminate();
            spawnWorker();
          }
          busyRef.current = true;
          workerRef.current?.postMessage({ type: "run", seq, config, historical });
        } catch (err) {
          if (seq !== seqRef.current) return;
          setLive((prev) => ({
            ...prev,
            running: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      })();
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [config, spawnWorker]);

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
    if (!live.result?.datasetGeneratedAt) return null;
    const age = Date.now() - Date.parse(live.result.datasetGeneratedAt);
    if (!Number.isFinite(age)) return null;
    const ageDays = age / 86_400_000;
    return ageDays > STALE_AFTER_DAYS ? Math.floor(ageDays) : null;
  }, [live.result, config.data.kind]);

  const preset = PRESETS.find((p) => p.id === activePreset);

  return (
    <>
      <header className="masthead">
        <h1>
          Aero Autopilot <span className="thin">/ strategy replay console</span>
        </h1>
        <span className="links">
          live replay · deterministic core · shared links replay exactly ·{" "}
          <a
            href="#guide"
            onClick={(e) => {
              e.preventDefault();
              history.replaceState(null, "", "#guide");
              setView("guide");
            }}
          >
            guide
          </a>{" "}
          ·{" "}
          <a href="https://github.com/leo-klima-agents/autopilot" rel="noreferrer">
            source
          </a>
        </span>
      </header>
      <div className={`flight-director ${live.running ? "running" : ""}`} aria-hidden>
        <div className="horizon" />
      </div>

      {view === "guide" ? (
        <Guide
          onClose={() => {
            history.replaceState(null, "", configToHash(config));
            setView("console");
          }}
        />
      ) : (
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
              {preset
                ? preset.blurb
                : "Pick a story scenario, or file your own flight plan — the instruments replay live as you adjust it."}
            </p>
          </div>

          <ConfigPanel
            config={config}
            onChange={(next) => {
              setConfig(next);
              setActivePreset(null);
            }}
          />
        </section>

        <section aria-label="instruments">
          {staleness !== null && (
            <div className="banner">
              Historical dataset is {staleness} days old — replaying the last published data (the data pipeline
              refreshes weekly).
            </div>
          )}
          {live.error && (
            <div className="banner alert" role="status">
              Replay failed: {live.error}
              {live.result ? " — showing the last good run." : ""}
            </div>
          )}

          {live.result ? (
            <>
              <div className="panel">
                <button className="copy-link" onClick={copyLink}>
                  {copied ? "Copied" : "Copy link to this run"}
                </button>
                <p className="placard">
                  Instruments{" "}
                  <span className="unit">
                    · {live.running ? "recomputing…" : `computed in ${Math.round(live.elapsedMs)} ms`}
                  </span>
                </p>
                <Gauges result={live.result} />
              </div>
              <div className="panel">
                <p className="placard">Equity vs passive benchmark</p>
                <EquityChart result={live.result} />
                <div className="legend">
                  <span>
                    <span className="chip" style={{ background: "#6FD3A6" }} />
                    strategy — cumulative {live.result.revenueUnit === "usd" ? "USD " : ""}revenue per unit weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#E8B44F" }} />
                    passive — global revenue ÷ global weight
                  </span>
                </div>
              </div>
              <div className="panel">
                <p className="placard">Allocation over time</p>
                <AllocationHeatmap result={live.result} />
              </div>
            </>
          ) : (
            !live.error && (
              <div className="panel">
                <div className="empty">
                  {live.running ? "Replaying the market in a worker — the panel stays live." : "Warming up…"}
                </div>
              </div>
            )
          )}
        </section>
      </main>
      )}
    </>
  );
}
