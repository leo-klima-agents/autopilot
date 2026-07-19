/**
 * The strategies page: the four decision rules the console can run, at the
 * algorithm level, how each turns the public trailing signal into a target
 * and how reluctant it is to act. The sequel to Theory (which ends on
 * "prediction is the only edge on v3"); the Guide documents the console
 * controls that tune these. Content mirrors @aero-autopilot/core; when the
 * code and this page disagree, that is a bug.
 */

export function Strategies({ onClose }: { onClose: () => void }) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>The strategies</h2>
        <p>
          Theory ended on the thesis: once revenue streams to current weights (v3), mirroring past revenue stops
          winning and prediction is the only edge. These are the four decision rules that try: the options in the
          console's <code>engine</code> dropdown. This page is the <em>why</em> of each; the Guide documents the
          knobs that tune them.
        </p>
      </div>

      <div className="panel">
        <h2>How every strategy works</h2>
        <p>
          A strategy is a pure function that wakes on a fixed clock (its <em>cadence</em>, possibly phase-shifted;
          the weekly one wakes just before epoch flips) and, given the market right now, proposes a{" "}
          <em>target allocation</em>: what fraction of the portfolio should sit on each pool, summing to 100%. The
          only information it gets is public and backward-looking: each pool's current vote weight and its{" "}
          <em>trailing revenue</em>, the fees + incentives accrued over the strategy's lookback window. No strategy
          here sees the future; they differ in how they turn that trailing signal into a target and in how reluctant
          they are to act on it.
        </p>
        <p>
          Strategies never move weight themselves. The <em>scheduler</em> takes the proposed target, compares it to
          what each tranche currently holds, and rotates only the tranches whose cooldown has expired, so the
          portfolio converges to a new target in staggered steps across several wake-ups, and re-proposing the same
          target is a no-op. This makes rotations the scarce resource: every move spends that tranche's cooldown,
          locking it through whatever happens next.
        </p>
        <p>
          Two ideas from Theory recur across the strategies. First, <em>marginal yield</em>: what the next unit of
          weight actually earns on a pool, R·W/(W+w)² (Theory §4). It falls as your own weight w piles onto the
          crowd's W, which is why a modest pool nobody stands on can beat the biggest earner on the board; the
          optimal allocation is built from it (§7). Second, <em>restraint</em>: because acting costs a cooldown
          (and, live, gas), the better strategies carry an explicit device (a drift threshold, a dead-band) that
          refuses trades too small to pay for themselves.
        </p>
      </div>

      <div className="panel">
        <h2>Revenue mirror: weekly / 48h / 24h / 1h</h2>
        <p>
          <strong>Signal:</strong> trailing revenue per pool over <code>lookbackSec</code>.{" "}
          <strong>Target:</strong> exactly proportional: a pool that produced 12% of the lookback's revenue gets
          12% of the portfolio, dilution ignored. <strong>Moves:</strong> every wake-up, unconditionally; no
          restraint device at all. <strong>Why it exists:</strong> it is the investable twin of the revenue
          benchmark, lagged by one window: the honest baseline any cleverer strategy must justify itself against.
          The four variants share everything but the clock, so running them side by side isolates what acting more
          often is worth. The weekly variant wakes <code>submitOffsetSec</code> before the Thursday flip, making it
          the late voter of Theory §8 (nearly optimal on v2's retroactive payouts, pure lag-cost on v3's streaming),
          and is the only strategy that can run live against Aerodrome v2 today.
        </p>
      </div>

      <div className="panel">
        <h2>Persistence carry</h2>
        <p>
          <strong>Signal:</strong> trailing revenue, discounted by how erratically it arrived. The lookback is cut
          into <code>buckets</code> equal sub-windows; volatility is the mean absolute deviation of the bucket
          revenues over their mean, capped at 100%; each pool's revenue is then haircut in proportion, up to{" "}
          <code>haircutWad</code> at full volatility. Two pools with identical totals stop being identical: the one
          that earned steadily keeps its score, the one that earned everything in a single spike loses up to half of
          it. <strong>Target:</strong> proportional to the haircut scores. <strong>Moves:</strong> only when the new
          ideal has drifted more than <code>sWad</code> (in total allocation moved) from the last target it actually
          submitted, an (s,S) rule, and it is careful not to "spend" that trigger while every tranche is still
          locked. <strong>Why it exists:</strong> this is the prediction play for the v3 streaming world, where a
          48h cooldown makes every move a commitment. It takes weight before the lagged crowd arrives; the haircut
          is what refuses wash-bait (a pumped pool is maximally volatile); the drift threshold is what keeps
          turnover low enough that the cooldowns are spent on moves that matter.
        </p>
      </div>

      <div className="panel">
        <h2>Water-filling</h2>
        <p>
          <strong>Signal:</strong> trailing revenue per pool, plus each pool's current external weight; this is the
          one family that looks at the crowd, not just the fees. <strong>Target:</strong> the allocation that
          maximizes total expected revenue Σ wᵢRᵢ/(Wᵢ+wᵢ) for a portfolio of your size. At the optimum every funded
          pool has the same marginal yield (like pouring water into connected basins until one level holds), which
          the implementation finds exactly by binary-searching that common level (λ) in integer arithmetic. Pools
          whose marginal yield never reaches the level get nothing. <strong>Moves:</strong> every wake-up (default
          48h), no restraint device. <strong>Why it exists:</strong> it is the optimal response to a mispriced
          crowd, and the reason "captured" can exceed 100% (Theory §7): where the mirror family copies revenue
          shares, water-filling deliberately over-weights thin pools with real revenue and under-weights crowded
          ones: big portfolios spread out, small ones concentrate. It is the only strategy here that can
          legitimately beat the revenue benchmark, and it is also the sizing engine inside Continuous greedy.
        </p>
      </div>

      <div className="panel">
        <h2>Continuous greedy</h2>
        <p>
          <strong>Signal:</strong> the same inputs as Water-filling, re-read on every tick, down to one Base block
          (2 seconds). <strong>Target:</strong> the water-filled ideal. <strong>Moves:</strong> almost never, and
          that is the design. Each tick it measures how much better the best marginal yield anywhere is than the
          worst one it currently holds: exactly what moving one unit of weight would gain. If no tranche is off
          cooldown, nothing can move and it waits; if the gap is smaller than <code>thresholdWad + costWad</code>{" "}
          (the noise floor plus what a rotation costs), moving would be churn and it re-affirms the last target;
          only when the gap clears that dead-band does it jump to the full ideal. <strong>Why it exists:</strong> to
          answer whether block-speed reaction is worth anything. Run the "latency race" Logbook entry: against a
          fast crowd reading the same public signal the gap almost never clears the dead-band, and returns converge
          to the market average minus the few rotations' cost: design principle P3, demonstrated rather than
          asserted.
        </p>
      </div>

      <div className="panel">
        <h2>The operating doctrine</h2>
        <p>
          Condensed, the business case for running any of this is <em>captured × edge &gt; operating cost</em>.
          Edge (how much the crowd misprices) is exogenous and structurally decaying: crowds get faster, and v3's
          design (streaming, caps, cooldowns) is built to compress the very inefficiency these strategies feed on.
          So <em>capture</em> is the only term the autopilot controls, which is why the strategies that matter for
          v3 are the predictive, restraint-carrying ones (Persistence carry, Water-filling) rather than the mirror
          that merely follows revenue.
        </p>
      </div>
    </main>
  );
}
