/** Headline instruments: square gauges with EFIS color semantics
 *  (phosphor = good, amber = caution, red = negative). */
import type { DisplayResult } from "../lib/serialize.js";
import { fmt, moneyFor, pct } from "../lib/format.js";

export function Gauges({ result }: { result: DisplayResult }) {
  const vs = result.returnVsMarket;
  const usd = result.revenueUnit === "usd";
  // USD runs are priced fees + bribes (historical or dollar-calibrated
  // synthetic); index runs are unpriced datasets
  const money = moneyFor(result.revenueUnit);
  return (
    <div className="gauge-row">
      <div className="gauge">
        <p className="placard">Return</p>
        <div className="gauge-value">{money(result.totalReturn)}</div>
        <div className="sub">{usd ? "USD revenue / unit vote weight" : "revenue / unit weight"}</div>
      </div>
      <div className="gauge">
        <p className="placard">Vs market</p>
        <div className={`gauge-value ${vs > 0 ? "good" : vs < 0 ? "bad" : ""}`}>
          {vs > 0 ? "+" : ""}
          {money(vs)}
        </div>
        <div className="sub">
          market: {money(result.marketBenchmarkReturn)} · rev bench: {money(result.revenueBenchmarkReturn)}
          {(() => {
            // capture: the fraction of the foresight edge the strategy took
            const edge = result.revenueBenchmarkReturn - result.marketBenchmarkReturn;
            return edge > 1e-12 ? ` · captured ${pct(vs / edge)}` : "";
          })()}
        </div>
      </div>
      <div className="gauge">
        <p className="placard">Max DD vs market</p>
        <div className={`gauge-value ${result.maxDrawdownVsMarket > 0 ? "caution" : ""}`}>
          {money(result.maxDrawdownVsMarket)}
        </div>
        <div className="sub">peak-to-trough of (equity − market bench)</div>
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
