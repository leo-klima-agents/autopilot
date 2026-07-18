/**
 * The theory page: why the console measures what it measures. A synthesis of
 * the benchmark design — the zero-sum structure of vote revenue, what each
 * benchmark means, which one a strategy must beat, why revenue-proportional
 * is not the ceiling (water-filling is), and how Aerodrome v2's retroactive
 * payouts differ from Aero v3's streaming. Content mirrors the implementation
 * in @aero-autopilot/core — when the code and this page disagree, that is a
 * bug.
 */

export function Theory({ onClose }: { onClose: () => void }) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>Theory — benchmarks, ceilings, and where the edge comes from</h2>
        <p>
          This page explains the reasoning behind the console's two benchmarks and the "captured" figure, and why
          the same strategy can look brilliant on Aerodrome v2 and merely competent on Aero v3. Everything here is
          implemented literally in the deterministic core; the Guide explains <em>what</em> each control does, this
          page explains <em>why</em> the instruments are built this way.
        </p>
      </div>

      <div className="panel">
        <h2>1. Vote revenue is zero-sum around the average</h2>
        <p>
          Each pool's revenue (fees plus incentives) is split among allocators in proportion to the weight they have
          on that pool. Summed across all allocators, everyone's return per unit weight is, by construction, the
          global average: total revenue divided by total allocated weight. Nobody can beat the market{" "}
          <em>collectively</em> — one allocator's above-average return is exactly another's below-average one. Every
          strategy on this console is therefore playing a single game: <strong>take revenue share from other
          voters</strong> — specifically from the lagged, inattentive, or misallocated part of the crowd.
        </p>
      </div>

      <div className="panel">
        <h2>2. The two benchmarks</h2>
        <dl>
          <dt>Market benchmark (amber, dashed)</dt>
          <dd>
            A portfolio of your size holding every pool in proportion to its <em>global vote weight</em> — the
            market portfolio. It earns the global average by definition. It is investable: spread your votes like
            everyone else's, or park in a large relay, and you get approximately this. It carries no friction in the
            simulation (no cooldowns, instant rebalancing) — benchmarks are frictionless references; only the
            strategy pays friction.
          </dd>
          <dt>Revenue benchmark (cyan, dashed)</dt>
          <dd>
            A portfolio of your size holding every pool in proportion to <em>that epoch's total realized
            revenue</em>, refreshed weekly. Its weight displaces yours pool-by-pool when computing earnings, so it
            answers: "what if this exact capital had been allocated revenue-proportionally instead?" Its weights
            require the epoch's revenue — on Aero v3 that means foresight (see §5), so it is a reference, not an
            investable alternative. It is also the allocation Aero's own on-target methodology scores against: in an
            efficient vote market, crowd weights converge to revenue shares, so this benchmark is simultaneously
            "the efficient market's portfolio".
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>3. Which benchmark must a strategy beat?</h2>
        <p>
          <strong>The market benchmark — it is the opportunity cost.</strong> If a strategy cannot beat it net of
          friction (cooldowns spent, keeper gas, operational risk), the rational move is to hold the market and
          delete the strategy. Because vote revenue is zero-sum around the average, beating the market benchmark is
          exactly equivalent to extracting revenue share from other voters, which is the product's entire purpose.
          This is the go/no-go criterion for real capital.
        </p>
        <p>
          <strong>The revenue benchmark is not a target — it is a ruler.</strong> It decomposes a result into two
          factors the raw vs-market number cannot separate:
        </p>
        <dl>
          <dt>edge = revenue bench − market bench</dt>
          <dd>
            How much inefficiency the crowd offered that run. When the crowd is fast and well-allocated, the two
            benchmarks converge and there was nothing to win — a flat vs-market is then the market's fault, not the
            strategy's, and turnover should be cut because activity has cost and no payoff.
          </dd>
          <dt>captured = (return − market bench) ÷ edge</dt>
          <dd>
            The fraction of the available edge the strategy collected — the engineering metric to optimize, because
            it is normalized against how much edge the market happened to offer. Falling capture with steady edge
            means the strategy degraded; falling edge with steady capture means the market got efficient.
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>4. The ceiling that isn't: revenue-proportional vs water-filling</h2>
        <p>
          The revenue benchmark is <em>not</em> the maximum a foresighted allocator could earn. With crowd weight
          w and your budget spread as x across pools, your earnings are Σ rev·x/(w+x) — concave in each pool. The
          maximum is characterized by equal marginal returns, rev·w/(w+x)² = λ, whose solution is a{" "}
          <strong>water-filling allocation</strong>: concentrate where revenue is high <em>relative to the crowd's
          weight</em>, skip pools where the crowd already sits, and fill thin pools first because a little weight
          there captures nearly all of their revenue. Revenue-proportional allocation coincides with the optimum
          only when the crowd is already efficient (weights proportional to revenue).
        </p>
        <p>
          This is measurable on the console: against a persistently mispriced crowd, the Water-filling strategy —
          with no foresight, only trailing signals — finishes <em>above</em> the revenue benchmark ("captured"
          exceeds 100%). That reading is meaningful, not a bug: it says the strategy did not merely follow the
          revenue, it exploited the crowd's mispricing beyond proportional tracking. The true ceiling would be
          foresight water-filling; the revenue benchmark is kept as the reference instead because it is the
          efficient-market mirror and matches the published on-target methodology.
        </p>
      </div>

      <div className="panel">
        <h2>5. v2 pays backwards; v3 doesn't — why this project exists</h2>
        <p>
          <strong>Aerodrome v2 is retroactive.</strong> Fees and bribes accrue publicly all week, but they are paid
          to vote weights checkpointed at the epoch flip — a Wednesday-night vote earns the same share of the whole
          week's rewards as one cast the previous Thursday. Since the accruing revenue is observable on-chain in
          real time, a voter who waits until just before the last-hour gate and votes proportional to
          revenue-so-far holds ~95–99% of the revenue benchmark's portfolio with zero foresight. This "late voter"
          play (the $/vote meta) makes the revenue benchmark <em>nearly investable on v2</em> — approximated here by
          the weekly Revenue mirror strategy phased late in the epoch. What still separates a real late voter from
          the benchmark: the final crowd weights (other late voters move the denominator simultaneously), revenue
          landing after the once-per-epoch vote is spent, and the last-hour whitelist gate.
        </p>
        <p>
          <strong>Aero v3 streams.</strong> Revenue pays to <em>current</em> weights as it accrues: allocating after
          observing revenue earns only what comes afterward, and the 48h cooldown delays even that. Retroactivity —
          and with it the late-voter exploit — is designed out. On v3 the revenue benchmark becomes a genuine
          foresight ceiling, and <em>prediction</em> becomes the only source of edge. That transition is the premise
          of this whole project: strategies that merely mirror trailing revenue stop winning, and
          persistence-aware, forward-looking allocation is what remains.
        </p>
      </div>

      <div className="panel">
        <h2>6. Where each strategy sits in this theory</h2>
        <dl>
          <dt>Revenue mirror — weekly / 48h / 24h / 1h</dt>
          <dd>
            Allocates proportional to trailing revenue at a fixed cadence — a realizable approximation of the
            revenue benchmark, lagged by one window. On v2, the weekly mirror phased late in the epoch is the late
            voter. On v3 its lag is a pure cost, which is exactly what the cadence ladder demonstrates.
          </dd>
          <dt>Water-filling</dt>
          <dd>
            The optimal-response allocator of §4, fed trailing signals: maximizes expected share against the
            observed crowd instead of mirroring revenue. The only strategy here that can legitimately exceed the
            revenue benchmark when the crowd misprices.
          </dd>
          <dt>Persistence carry</dt>
          <dd>
            A prediction play for the streaming regime: scores pools by how persistent their revenue is, takes
            weight before the lagged crowd arrives, and discounts wash-bait pumps that pure mirrors chase.
          </dd>
          <dt>Continuous greedy</dt>
          <dd>
            Event-driven rebalancing at minimal cooldown, using the water-filling allocator for sizing — probes how
            much of the theoretical edge survives execution constraints (cooldowns, caps, turnover).
          </dd>
        </dl>
        <p>
          The operating doctrine, condensed: the business case is <em>captured × edge &gt; operating cost</em>.
          Edge is exogenous and structurally decaying — faster crowds, and a v3 design built to compress
          inefficiency — so capture is the only term the autopilot controls.
        </p>
      </div>
    </main>
  );
}
