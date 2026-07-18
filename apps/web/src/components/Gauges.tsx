/** Headline instruments: square gauges with EFIS color semantics —
 *  phosphor = good, amber = caution, red = negative. */
import type { DisplayResult } from "../lib/serialize.js";

function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function Gauges({ result }: { result: DisplayResult }) {
  const vs = result.returnVsPassive;
  const usd = result.revenueUnit === "usd";
  // USD runs are Alchemy-priced fees + bribes; index runs are synthetic units
  const money = (n: number, digits?: number) => (usd ? `$${fmt(n, digits)}` : fmt(n, digits));
  return (
    <div className="gauge-row">
      <div className="gauge">
        <p className="placard">Return</p>
        <div className="gauge-value">{money(result.totalReturn)}</div>
        <div className="sub">{usd ? "USD revenue / unit vote weight" : "revenue / unit weight"}</div>
      </div>
      <div className="gauge">
        <p className="placard">Vs bench</p>
        <div className={`gauge-value ${vs > 0 ? "good" : vs < 0 ? "bad" : ""}`}>
          {vs > 0 ? "+" : ""}
          {money(vs)}
        </div>
        <div className="sub">passive: {money(result.passiveReturn)}</div>
      </div>
      <div className="gauge">
        <p className="placard">Max DD vs bench</p>
        <div className={`gauge-value ${result.maxDrawdownVsBenchmark > 0 ? "caution" : ""}`}>
          {money(result.maxDrawdownVsBenchmark)}
        </div>
        <div className="sub">peak-to-trough of (equity − bench)</div>
      </div>
      <div className="gauge">
        <p className="placard">On target</p>
        <div className={`gauge-value ${result.onTargetPct >= 0.6 ? "good" : "caution"}`}>
          {pct(result.onTargetPct)}
        </div>
        <div className="sub">±2pp of revenue-optimal (F21)</div>
      </div>
      <div className="gauge">
        <p className="placard">Off target</p>
        <div className={`gauge-value ${result.offTargetPct > 0.15 ? "bad" : ""}`}>{pct(result.offTargetPct)}</div>
        <div className="sub">&gt;5pp off · {result.poolSamples} samples</div>
      </div>
      <div className="gauge">
        <p className="placard">Turnover</p>
        <div className="gauge-value">{fmt(result.turnover, 2)}</div>
        <div className="sub">
          {result.rotations} rotations · {result.blockedSubmissions} blocked
        </div>
      </div>
    </div>
  );
}
