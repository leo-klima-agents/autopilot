/**
 * The operator's guide: every term, input, strategy, and instrument on the
 * console, explained for someone who has never seen a ve(3,3) exchange from
 * the inside. Content mirrors the actual implementation in
 * @aero-autopilot/core, when the code and this page disagree, that is a bug.
 */

export function Guide({ onClose }: { onClose: () => void }) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>Operator's guide</h2>
        <p>
          The operator's manual for the replay console: every control and instrument, in the order you meet them on
          screen. It assumes the concepts, the Theory page develops them, the Strategies page covers the decision
          rules in the <code>engine</code> dropdown, and the Vocabulary page defines every term. If this is your
          first visit, read those first.
        </p>
        <p>
          One property matters everywhere here: runs are deterministic. The same flight plan always produces exactly
          the same result, which is why a copied link reproduces a run bit for bit.
        </p>
      </div>

      <div className="panel">
        <h2>The flight plan, panel by panel</h2>

        <h3>Strategy</h3>
        <p>
          <strong>engine</strong> picks the decision rule, the four are explained on the Strategies page. The
          fields below it are the selected strategy's own knobs:
        </p>
        <dl>
          <dt>lookbackSec</dt>
          <dd>
            How far back the strategy looks when measuring a pool's revenue. Short lookbacks react fast but chase
            noise; long ones are steady but late.
          </dd>
          <dt>cadenceSec</dt>
          <dd>How often the strategy re-evaluates and (possibly) proposes a new allocation.</dd>
          <dt>submitOffsetSec (Revenue mirror, weekly variant only)</dt>
          <dd>
            How many seconds before the Thursday flip to submit. Voting late uses the freshest information; voting
            early locks you in while better information keeps arriving.
          </dd>
          <dt>buckets (Persistence carry)</dt>
          <dd>The lookback window is cut into this many equal sub-windows to estimate revenue volatility.</dd>
          <dt>haircutWad (Persistence carry)</dt>
          <dd>
            Maximum score penalty applied at 100% volatility, as a Wad fraction. 0.5 = a maximally-noisy pool keeps
            only half its raw score.
          </dd>
          <dt>sWad (Persistence carry)</dt>
          <dd>
            The (s,S) trigger: a new target is only proposed when it differs from the last one by more than this L1
            distance (sum of absolute per-pool weight changes). Below the threshold, the strategy deliberately sits
            still; churn costs turnover and burns cooldowns.
          </dd>
          <dt>thresholdWad / costWad (Continuous greedy)</dt>
          <dd>
            The move trigger: reallocate only when the marginal-yield gap between the best pool and the worst pool
            you hold exceeds threshold + cost. Cost stands in for gas and slippage.
          </dd>
        </dl>

        <h3>Protocol model</h3>
        <dl>
          <dt>economy</dt>
          <dd>
            The rule set, not the data. <em>Aero v3 (continuous)</em>: revenue streams every second, allocations move
            any time subject to the cooldown. <em>Aerodrome v2 (weekly epochs)</em>: one allocation change per epoch,
            revenue settles at each flip, voting blocked in the first hour after a flip (the distribute window; the
            last-hour whitelist gate is a separate, optional restriction; see Theory §2). The timeline (real dates vs
            relative days) comes from the market data panel, not from this choice.
          </dd>
          <dt>allocation cooldown</dt>
          <dd>
            Minimum time between allocation changes per position: 7d mirrors v2's effective cadence, 48h is the v3
            launch plan, and 24h / 1h / 1-block are what-ifs. At 1 block the "latency race" preset shows why faster
            isn't better.
          </dd>
          <dt>gauge caps + cap multiplier κ ×1000</dt>
          <dd>Enables the emission cap described above; 1200 = κ of 1.2×.</dd>
          <dt>allocation decay</dt>
          <dd>Enables stale-allocation decay (see vocabulary).</dd>
          <dt>emissions / day</dt>
          <dd>
            Whole tokens per day the protocol emits across all pools. Only affects the emission-steering instruments
            (on/off-target) and cap/burn accounting; allocator revenue comes from fees.
          </dd>
        </dl>

        <h3>Market data</h3>
        <dl>
          <dt>source</dt>
          <dd>
            <em>Aerodrome historical</em>: 30 months of real per-epoch fees and bribes for the top ~40 pools by
            trailing revenue (Slipstream CL and v2 AMM pools alike), indexed on-chain and priced in USD from daily
            Alchemy price history; the x axis shows real dates and the instruments show dollars. The window end
            offset moves the replay window's END into the past (its start follows from the duration — reaching
            the Sep 2024 cbBTC launch takes an end near Mar 2025 <em>plus</em> a ~26-week duration, which is why
            the cbBTC-backtest preset pins the window to absolute dates instead of an offset).{" "}
            <em>Synthetic scenario</em>: a generated market, exactly reproducible from
            the seed; the x axis shows relative days (d0, d7, …) because its calendar anchor is arbitrary.
          </dd>
          <dt>seed</dt>
          <dd>The random seed. Same seed, same market, always; this is what makes shared links exact.</dd>
          <dt>fee process</dt>
          <dd>
            The personality of synthetic fees. <em>mixed</em> (the realistic default): every pool runs its own
            archetype from a roster calibrated to the real top pools — recognizable names, fee scales from ~$365k
            down to ~$1k a week, bribe-dominant pools, and one cbBTC-like growth pool that ramps ~20× over ten
            weeks. <em>persistent</em>: levels drift slowly; yesterday predicts today.
            <em> bursty</em>: occasional 5× fee weeks land at random. <em>regime-switching</em>: pools flip between a
            quiet state and a 4× hot state and stay there for a while. The single-process kinds apply one
            personality to the whole (still realistically scaled) universe.
          </dd>
          <dt>crowd / herd lag / crowd ÷ portfolio</dt>
          <dd>
            Which crowd model runs against you, how stale its information is, and how big it is relative to your
            portfolio. A big, fast crowd erases your edge quickly; a laggy crowd is what early allocators profit
            from.
          </dd>
        </dl>

        <h3>Run</h3>
        <dl>
          <dt>duration, weeks</dt>
          <dd>
            Simulated length (clamped to the dataset's coverage). Historical runs anchor at the most recent complete
            epoch and replay backwards from there; a 12-week run covers the latest 12 weeks, and the still-in-progress
            week at indexing time is excluded. Synthetic runs always start at the beginning of the generated series.
          </dd>
          <dt>tranches / tokens per tranche</dt>
          <dd>
            How many separate positions you stake and their size. More tranches = smoother reallocation pipeline but
            each move carries less weight.
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>Reading the instruments</h2>
        <dl>
          <dt>Return</dt>
          <dd>Cumulative revenue earned per unit of your staking weight over the run.</dd>
          <dt>Vs market</dt>
          <dd>
            Return minus the market benchmark. Green and positive means the strategy beat holding the market
            average; red means you paid for activity and got nothing.
          </dd>
          <dt>Max DD vs market</dt>
          <dd>
            The deepest peak-to-trough fall of (your equity − market benchmark). It measures the worst stretch of
            underperformance you'd have sat through, even if the run ends ahead.
          </dd>
          <dt>On target / Off target</dt>
          <dd>
            Aero's published emissions-accuracy methodology: at every sample, compare each pool's share of emissions
            with its revenue-optimal share. Within 2 percentage points counts as on-target; more than 5pp off counts
            as off-target. Aero's own backtests report ~48% on-target for weekly voting, ~64% with a 48h revote, ~70%
            with gauge caps added; this console reproduces the measurement so you can see where a strategy lands.
          </dd>
          <dt>Turnover</dt>
          <dd>
            Total allocation movement: half the L1 distance of every executed rotation, summed. High turnover with a
            thin vs-market edge is a strategy that works only until costs exist.
          </dd>
          <dt>Rotations / blocked</dt>
          <dd>
            Executed reallocations, and submissions the protocol refused (cooldown not elapsed, or a v2 epoch rule).
            Persistent blocks mean the strategy's cadence is fighting the protocol's clock.
          </dd>
          <dt>Equity chart</dt>
          <dd>
            Solid phosphor line: your cumulative return. Dashed amber: the market benchmark. Dashed cyan: the
            revenue benchmark. Your line should live between the two dashed ones; how far up that band it sits is
            the strategy's skill (Theory §6). Time ticks land on epoch flips (Thursdays, UTC).
          </dd>
          <dt>Allocation heat-map</dt>
          <dd>
            Pools × time; brighter cells mean more of your weight on that pool at that moment. Vertical banding shows
            rotation waves; a bright row that starts before the crowd's arrival is the early-allocator pattern.
          </dd>
          <dt>Earned-revenue heat-map</dt>
          <dd>
            The allocation map's payoff twin: same pools, same timeline, but amber intensity is the revenue your
            portfolio actually earned from that pool during each interval. The figure at the right end of a row is that
            pool's cumulative contribution over the whole run (USD on historical replays). A bright allocation row over
            a dark revenue row is weight parked where the fees never showed up.
          </dd>
          <dt>Captured vs expected table</dt>
          <dd>
            Per pool: the revenue your portfolio earned against what a passive market-cap portfolio of the same
            total weight would have earned from the same pool, and their ratio, the capture multiple. Above 1×
            you took more than your share; the published cbBTC early-allocator backtest reads 1.43× in exactly
            this column. Mature, efficiently-voted pools sit near 1× — the multiple only moves where the crowd's
            weights trail the revenue.
          </dd>
          <dt>strategy / market bench / revenue bench toggle</dt>
          <dd>
            Flips both heat-maps between three same-size portfolios: yours and the two benchmarks (Theory §5). Use
            it as a diff. A row bright in the strategy view but dark in the revenue-bench view is weight the revenue
            never justified; bright in revenue-bench but dark in yours is a pool the strategy missed. The "captured"
            figure on the Vs-market gauge condenses that comparison into one number; if it looks oddly low, check
            whether the edge itself collapsed before blaming the strategy (Theory §6).
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>Scenarios</h2>
        <dl>
          <dt>Early allocator</dt>
          <dd>
            The mixed universe's cbBTC-like growth pool ramps ~20× while a two-week-lagged crowd trails it.
            Persistence carry on a 24h signal takes weight early, earns an outsized revenue share while alone, and
            cedes it as the herd arrives: the cbBTC story from Aero's economic case, in miniature. The capture
            table reads ~1.4× on that pool, the published 43% early-allocator edge.
          </dd>
          <dt>cbBTC backtest</dt>
          <dd>
            The same story on the real dataset: the replay window parks over Sep 2024 – Mar 2025, when cbBTC
            launched on Base and its pools' fees ramped from zero to ~$800k/week. The heat-map rows ignite and the
            capture table shows the cbBTC pools well above 1×.
          </dd>
          <dt>Latency race</dt>
          <dd>
            Continuous greedy at one-block cooldown against a fast crowd. Watch vs-market hug zero: at this cadence
            reaction has no edge, only costs.
          </dd>
          <dt>Wash-bait</dt>
          <dd>
            One pool pumps fake fees in bursts (8× its organic rate, two days at a time). Persistence carry with a
            deep haircut refuses the bait a naive trailing-fee grid would chase into losses.
          </dd>
        </dl>
        <p>
          Every run (presets included) lives entirely in the URL. "Copy link to this run" hands someone your exact
          flight plan, and the deterministic core guarantees their replay reproduces yours exactly.
        </p>
      </div>
    </main>
  );
}
