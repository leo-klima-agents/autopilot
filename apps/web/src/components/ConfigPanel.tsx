/** The flight plan: strategy, model, data, crowd, run sizing. Every control
 *  writes into one RunConfig object. Nothing here computes; the worker does. */
import { probeStrategy } from "../lib/buildRun.js";
import type { RunConfig, StrategyKind } from "../lib/runConfig.js";
import { SchemaForm } from "./SchemaForm.js";

// Display labels only; the `kind` ids are serialized into share URLs and
// must stay stable. "Revenue mirror" names the POLICY (allocate proportional
// to trailing revenue, see the Theory page); the suffix is the cadence.
const STRATEGIES: { kind: StrategyKind; label: string }[] = [
  { kind: "fixedGridWeekly", label: "Revenue mirror: weekly (live on v2)" },
  { kind: "fixedGrid48h", label: "Revenue mirror, 48h" },
  { kind: "fixedGrid24h", label: "Revenue mirror, 24h" },
  { kind: "fixedGrid1h", label: "Revenue mirror, 1h" },
  { kind: "persistenceCarry", label: "Persistence carry" },
  { kind: "waterFilling", label: "Water-filling (optimal response)" },
  { kind: "continuousGreedy", label: "Continuous greedy" },
];

const COOLDOWNS: { sec: number; label: string }[] = [
  { sec: 604_800, label: "7 d (v2 epoch)" },
  { sec: 172_800, label: "48 h (v3 launch plan)" },
  { sec: 86_400, label: "24 h" },
  { sec: 3_600, label: "1 h" },
  { sec: 2, label: "1 block (2 s)" },
];

interface Props {
  config: RunConfig;
  onChange: (next: RunConfig) => void;
}

export function ConfigPanel({ config, onChange }: Props) {
  const strategy = probeStrategy(config.strategy.kind);
  const patch = (p: Partial<RunConfig>) => onChange({ ...config, ...p });
  const syn = config.data.kind === "synthetic" ? config.data : null;

  return (
    <>
      <div className="panel">
        <p className="placard">Strategy</p>
        <div className="field">
          <label htmlFor="strategy">engine</label>
          <select
            id="strategy"
            value={config.strategy.kind}
            onChange={(e) => patch({ strategy: { kind: e.target.value as StrategyKind, config: {} } })}
          >
            {STRATEGIES.map((s) => (
              <option key={s.kind} value={s.kind}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <SchemaForm
          schema={strategy.configSchema}
          value={config.strategy.config}
          onChange={(c) => patch({ strategy: { ...config.strategy, config: c } })}
        />
      </div>

      <div className="panel">
        <p className="placard">Protocol model</p>
        <div className="field">
          <label htmlFor="model">economy</label>
          <select
            id="model"
            value={config.model.kind}
            onChange={(e) => patch({ model: { ...config.model, kind: e.target.value as "epoch" | "continuous" } })}
          >
            <option value="continuous">Aero v3 (continuous)</option>
            <option value="epoch">Aerodrome v2 (weekly epochs)</option>
          </select>
        </div>
        {config.model.kind === "continuous" && (
          <>
            <div className="field">
              <label htmlFor="cooldown">allocation cooldown</label>
              <select
                id="cooldown"
                value={config.model.cooldownSec}
                onChange={(e) => patch({ model: { ...config.model, cooldownSec: Number(e.target.value) } })}
              >
                {COOLDOWNS.map((c) => (
                  <option key={c.sec} value={c.sec}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="granularity">
                cooldown scope
                <span className="hint">per-position is the published plan (F2)</span>
              </label>
              <select
                id="granularity"
                value={config.model.cooldownGranularity}
                onChange={(e) =>
                  patch({
                    model: { ...config.model, cooldownGranularity: e.target.value as "position" | "global" },
                  })
                }
              >
                <option value="position">per position</option>
                <option value="global">global</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="caps">gauge caps</label>
              <input
                id="caps"
                type="checkbox"
                checked={config.model.caps.enabled}
                onChange={(e) =>
                  patch({ model: { ...config.model, caps: { ...config.model.caps, enabled: e.target.checked } } })
                }
              />
            </div>
            {config.model.caps.enabled && (
              <div className="field">
                <label htmlFor="kappa">
                  cap multiplier κ ×1000
                  <span className="hint">1200 = 1.2×, a placeholder, not a published value (F14)</span>
                </label>
                <input
                  id="kappa"
                  type="number"
                  min={100}
                  step={50}
                  value={config.model.caps.kappaMilli}
                  onChange={(e) =>
                    patch({
                      model: {
                        ...config.model,
                        caps: { ...config.model.caps, kappaMilli: Math.round(e.target.valueAsNumber) },
                      },
                    })
                  }
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="decay">
                allocation decay
                <span className="hint">stale allocations lose influence (F5)</span>
              </label>
              <input
                id="decay"
                type="checkbox"
                checked={config.model.decay.enabled}
                onChange={(e) =>
                  patch({ model: { ...config.model, decay: { ...config.model.decay, enabled: e.target.checked } } })
                }
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="emissions">emissions / day</label>
          <input
            id="emissions"
            type="number"
            min={0}
            value={config.model.emissionPerDay}
            onChange={(e) => patch({ model: { ...config.model, emissionPerDay: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      </div>

      <div className="panel">
        <p className="placard">Market data</p>
        <div className="field">
          <label htmlFor="datakind">source</label>
          <select
            id="datakind"
            value={config.data.kind}
            onChange={(e) =>
              patch({
                data:
                  e.target.value === "historical"
                    ? { kind: "historical" }
                    : { kind: "synthetic", seed: "42", poolCount: 8, epochCount: 20, process: "mixed" },
              })
            }
          >
            <option value="synthetic">synthetic scenario (seeded)</option>
            <option value="historical">Aerodrome historical (top 40 pools, 24 months)</option>
          </select>
        </div>
        {config.data.kind === "historical" && (
          <div className="field">
            <label htmlFor="endoffset">
              window end offset
              <span className="hint">weeks back from the dataset end (0 = latest)</span>
            </label>
            <input
              id="endoffset"
              type="number"
              min={0}
              max={100}
              value={config.data.endOffsetWeeks ?? 0}
              onChange={(e) =>
                patch({
                  data: { kind: "historical", endOffsetWeeks: Math.max(0, Math.round(e.target.valueAsNumber) || 0) },
                })
              }
            />
          </div>
        )}
        {syn && (
          <>
            <div className="field">
              <label htmlFor="seed">seed</label>
              <input
                id="seed"
                value={syn.seed}
                onChange={(e) => patch({ data: { ...syn, seed: e.target.value.replace(/\D/g, "") || "0" } })}
              />
            </div>
            <div className="field">
              <label htmlFor="process">fee process</label>
              <select
                id="process"
                value={syn.process}
                onChange={(e) =>
                  patch({
                    data: { ...syn, process: e.target.value as "persistent" | "bursty" | "regime" | "mixed" },
                  })
                }
              >
                <option value="mixed">mixed (realistic archetypes)</option>
                <option value="persistent">persistent</option>
                <option value="bursty">bursty</option>
                <option value="regime">regime-switching</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pools">pools</label>
              <input
                id="pools"
                type="number"
                min={2}
                max={30}
                value={syn.poolCount}
                onChange={(e) => patch({ data: { ...syn, poolCount: Math.round(e.target.valueAsNumber) } })}
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="crowd">crowd</label>
          <select
            id="crowd"
            value={config.crowd.kind}
            onChange={(e) => patch({ crowd: { ...config.crowd, kind: e.target.value as "none" | "static" | "herd" } })}
          >
            <option value="herd">reactive herd</option>
            <option value="static">static</option>
            <option value="none">none</option>
          </select>
        </div>
        {config.crowd.kind === "herd" && (
          <div className="field">
            <label htmlFor="lag">
              herd lag
              <span className="hint">seconds behind live revenue</span>
            </label>
            <input
              id="lag"
              type="number"
              min={0}
              step={3600}
              value={config.crowd.lagSec}
              onChange={(e) => patch({ crowd: { ...config.crowd, lagSec: Math.round(e.target.valueAsNumber) } })}
            />
          </div>
        )}
        {config.crowd.kind !== "none" && (
          <div className="field">
            <label htmlFor="multiple">crowd ÷ portfolio</label>
            <input
              id="multiple"
              type="number"
              min={0}
              value={config.crowd.multiple}
              onChange={(e) => patch({ crowd: { ...config.crowd, multiple: Math.round(e.target.valueAsNumber) } })}
            />
          </div>
        )}
      </div>

      <div className="panel">
        <p className="placard">Run</p>
        <div className="field">
          <label htmlFor="weeks">duration, weeks</label>
          <input
            id="weeks"
            type="number"
            min={1}
            max={52}
            value={config.run.durationWeeks}
            onChange={(e) => patch({ run: { ...config.run, durationWeeks: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="tranches">
            tranches
            <span className="hint">separate permanent stakes; staggered cooldowns</span>
          </label>
          <input
            id="tranches"
            type="number"
            min={1}
            max={16}
            value={config.run.trancheCount}
            onChange={(e) => patch({ run: { ...config.run, trancheCount: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="tokens">tokens / tranche</label>
          <input
            id="tokens"
            type="number"
            min={1}
            value={config.run.trancheTokens}
            onChange={(e) => patch({ run: { ...config.run, trancheTokens: Math.round(e.target.valueAsNumber) } })}
          />
        </div>
      </div>
    </>
  );
}
