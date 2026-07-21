import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfigPanel } from "./components/ConfigPanel.js";
import { Guide } from "./components/Guide.js";
import { Theory } from "./components/Theory.js";
import { Strategies } from "./components/Strategies.js";
import { Vocabulary } from "./components/Vocabulary.js";
import { Logbook } from "./components/Logbook.js";
import { Gauges } from "./components/Gauges.js";
import { EquityChart } from "./components/EquityChart.js";
import { AllocationHeatmap, type HeatmapView } from "./components/AllocationHeatmap.js";
import { EarningsHeatmap } from "./components/EarningsHeatmap.js";
import { CaptureTable } from "./components/CaptureTable.js";
import { SYNTHETIC_GENERATOR_VERSION } from "@aero-autopilot/core/data/synthetic";
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

/** The doc pages, in reading order. Each is a real path under the site base
 *  (e.g. /theory/), so links behave like an ordinary multi-page site. The
 *  console lives at the base path; its run config still travels in the
 *  `#run=` hash. Static hosts serve a per-page index.html + a 404.html copy
 *  of the SPA (see vite.config), so deep links resolve without a server. */
type DocView = "theory" | "strategies" | "guide" | "vocabulary" | "logbook";
const DOC_PAGES: { view: DocView; segment: string; label: string }[] = [
  { view: "theory", segment: "theory", label: "theory" },
  { view: "strategies", segment: "strategies", label: "strategies" },
  { view: "guide", segment: "guide", label: "guide" },
  { view: "vocabulary", segment: "vocabulary", label: "vocabulary" },
  { view: "logbook", segment: "logbook", label: "logbook" },
];
type View = "console" | DocView;

/** Vite's configured base path ("/" in dev, "/<repo>/" on Pages). */
const BASE = import.meta.env.BASE_URL;

/** The path segment below BASE, trailing slashes stripped ("" = console). */
function currentSegment(): string {
  let p = location.pathname;
  p = p.startsWith(BASE) ? p.slice(BASE.length) : p.replace(/^\//, "");
  return p.replace(/\/+$/, "");
}
function viewFromPath(): View {
  const page = DOC_PAGES.find((d) => d.segment === currentSegment());
  return page ? page.view : "console";
}
function pageUrl(view: DocView): string {
  return BASE + DOC_PAGES.find((d) => d.view === view)!.segment + "/";
}
/** Console URL at the base path, carrying the run hash (e.g. "#run=…"). */
function consoleUrl(hash = ""): string {
  return BASE + hash;
}

/** Strategy / market-bench / revenue-bench switch on both heat-map panels; the
 *  controls share one state so the maps always show the same portfolio. */
function ViewToggle({
  view,
  onChange,
}: {
  view: HeatmapView;
  onChange: (view: HeatmapView) => void;
}) {
  return (
    <div className="seg-toggle" role="group" aria-label="heatmap portfolio">
      {(["strategy", "market", "revenue"] as const).map((v) => (
        <button key={v} className={view === v ? "active" : ""} onClick={() => onChange(v)}>
          {v === "strategy" ? "strategy" : v === "market" ? "market bench" : "revenue bench"}
        </button>
      ))}
    </div>
  );
}

/** Placard suffix for the non-strategy heat-map views. */
function viewSuffix(view: HeatmapView): string {
  if (view === "market") return ": market benchmark";
  if (view === "revenue") return ": revenue benchmark (foresight)";
  return "";
}

/** Live replay state: the last good result stays on the instruments while a
 *  newer run computes (or a half-typed config errors), no flicker, no button. */
interface LiveState {
  result: DisplayResult | null;
  elapsedMs: number;
  running: boolean;
  error: string | null;
}

export function App() {
  const [config, setConfig] = useState<RunConfig>(() => configFromHash(location.hash) ?? DEFAULT_RUN);
  const [view, setView] = useState<View>(() => viewFromPath());
  const [heatmapView, setHeatmapView] = useState<HeatmapView>("strategy");

  // browser back/forward: resync the page from the URL, and (on the console)
  // the run config from its hash. In-app navigation uses pushState below.
  useEffect(() => {
    const onPop = () => {
      const v = viewFromPath();
      setView(v);
      if (v === "console") {
        const c = configFromHash(location.hash);
        if (c) setConfig(c);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
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
      if (msg.seq !== seqRef.current) return; // stale run, a newer config superseded it
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
              if (!res.ok) throw new Error("historical dataset not published yet, run `pnpm data` and redeploy");
              datasetRef.current = await res.json();
            }
            historical = datasetRef.current;
          }
          if (seq !== seqRef.current) return; // superseded while fetching
          // keep the console's shareable URL current, but only while it is the
          // visible page, never rewrite a doc-page path
          if (viewFromPath() === "console") {
            history.replaceState(null, "", configToHash(config)); // replace, never push, no history spam
          }
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
    history.replaceState(null, "", consoleUrl(configToHash(config)));
    void navigator.clipboard.writeText(location.href).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [config]);

  /** Navigate to a doc page (real path, pushed so back/forward works). */
  const openPage = useCallback((v: DocView) => {
    history.pushState(null, "", pageUrl(v));
    setView(v);
  }, []);
  /** Return to the console at the base path, carrying the current run hash. */
  const openConsole = useCallback(
    (runConfig: RunConfig) => {
      history.pushState(null, "", consoleUrl(configToHash(runConfig)));
      setView("console");
    },
    [],
  );

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

  // A synthetic link stamped with an older generator version (or none, i.e.
  // pre-versioning) replays under today's generator and produces different
  // numbers than when it was shared; say so instead of silently differing.
  // Holds the link's generator version when stale, null otherwise.
  const staleGeneratorVersion =
    config.data.kind === "synthetic" && (config.data.gen ?? 1) !== SYNTHETIC_GENERATOR_VERSION
      ? (config.data.gen ?? 1)
      : null;

  return (
    <>
      <header className="masthead">
        <h1>
          Aero Autopilot <span className="thin">/ strategy replay console</span>
        </h1>
        <span className="links">
          live replay · deterministic core · shared links replay exactly ·{" "}
          {DOC_PAGES.map((page) => (
            <span key={page.view}>
              <a
                href={pageUrl(page.view)}
                onClick={(e) => {
                  // let modified clicks (new tab, etc.) behave like a real link
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  openPage(page.view);
                }}
              >
                {page.label}
              </a>{" "}
              ·{" "}
            </span>
          ))}
          <a href="https://github.com/leo-klima-agents/autopilot" rel="noreferrer">
            source
          </a>
        </span>
      </header>
      <div className={`flight-director ${live.running ? "running" : ""}`} aria-hidden>
        <div className="horizon" />
      </div>

      {view !== "console" ? (
        (() => {
          const closeDoc = () => openConsole(config);
          if (view === "theory") return <Theory onClose={closeDoc} />;
          if (view === "strategies") return <Strategies onClose={closeDoc} />;
          if (view === "guide") return <Guide onClose={closeDoc} />;
          if (view === "vocabulary") return <Vocabulary onClose={closeDoc} />;
          return (
            <Logbook
              onClose={closeDoc}
              onOpenRun={(runConfig) => {
                setConfig(runConfig);
                setActivePreset(null);
                openConsole(runConfig);
              }}
            />
          );
        })()
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
                : "Pick a story scenario, or file your own flight plan, the instruments replay live as you adjust it."}
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
              Historical dataset is {staleness} days old, replaying the last published data (the data pipeline
              refreshes weekly).
            </div>
          )}
          {staleGeneratorVersion !== null && (
            <div className="banner">
              This run was shared under synthetic generator v{staleGeneratorVersion} (current: v
              {SYNTHETIC_GENERATOR_VERSION}): the same seed now replays a recalibrated market, so the numbers
              differ from when the link was made.
            </div>
          )}
          {live.error && (
            <div className="banner alert" role="status">
              Replay failed: {live.error}
              {live.result ? ", showing the last good run." : ""}
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
                <p className="placard">Equity vs benchmarks</p>
                <EquityChart result={live.result} />
                <div className="legend">
                  <span>
                    <span className="chip" style={{ background: "#6FD3A6" }} />
                    strategy: cumulative {live.result.revenueUnit === "usd" ? "USD " : ""}revenue per unit weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#E8B44F" }} />
                    market bench: global revenue ÷ global weight
                  </span>
                  <span>
                    <span className="chip" style={{ background: "#6FB8D3" }} />
                    revenue bench: each week's revenue shares, held with foresight
                  </span>
                </div>
              </div>
              <div className="panel">
                <div className="panel-head">
                  <p className="placard">Allocation over time{viewSuffix(heatmapView)}</p>
                  <ViewToggle view={heatmapView} onChange={setHeatmapView} />
                </div>
                <AllocationHeatmap result={live.result} view={heatmapView} />
              </div>
              <div className="panel">
                <div className="panel-head">
                  <p className="placard">Earned revenue per pool{viewSuffix(heatmapView)}</p>
                  <ViewToggle view={heatmapView} onChange={setHeatmapView} />
                </div>
                <EarningsHeatmap result={live.result} view={heatmapView} />
              </div>
              <div className="panel">
                <p className="placard">Captured vs expected, per pool</p>
                <CaptureTable result={live.result} />
              </div>
            </>
          ) : (
            !live.error && (
              <div className="panel">
                <div className="empty">
                  {live.running ? "Replaying the market in a worker; the panel stays live." : "Warming up…"}
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
