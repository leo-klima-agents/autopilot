/**
 * The theory page: why the console measures what it measures. A synthesis of
 * the benchmark design: the zero-sum structure of vote revenue, what each
 * benchmark means, which one a strategy must beat, why revenue-proportional
 * is not the ceiling (water-filling is), and how Aerodrome v2's retroactive
 * payouts differ from Aero v3's streaming. Content mirrors the implementation
 * in @aero-autopilot/core; when the code and this page disagree, that is a
 * bug.
 */

export function Theory({ onClose }: { onClose: () => void }) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>Theory: benchmarks, ceilings, and where the edge comes from</h2>
        <p>
          Start here. This page owns the concepts everything else references: how these exchanges work, where
          returns come from, what the two benchmarks and the "captured" figure mean, and why the same strategy can
          look brilliant on Aerodrome v2 and merely competent on Aero v3. Everything is implemented literally in
          the deterministic core. Read next in order: the Strategies page turns this into the four decision rules
          the console can run, the Guide is the operator's manual for the controls and instruments, and the Logbook
          is a shelf of runs that demonstrate each claim made here. Sections 1–3 are the background: how these
          exchanges actually work; if you already live in ve(3,3) land, start at §4.
        </p>
      </div>

      <div className="panel">
        <h2>1. The machine: a ve(3,3) exchange in one loop</h2>
        <p>
          Aerodrome is a decentralized exchange on Base. Traders swap tokens in <em>pools</em> and pay fees.
          Liquidity providers fund those pools, but on a ve(3,3) exchange they are mostly paid in freshly emitted
          protocol tokens (AERO), not in the fees they generate. The fees go somewhere else, and that is the whole
          game: holders who <em>lock</em> AERO receive vote-escrowed voting weight (veAERO), and each week they vote
          that weight across the pools. Votes decide two things at once. First, they steer the week's AERO
          emissions: each pool's <em>gauge</em> receives emissions in proportion to the votes on it, which is what
          attracts liquidity providers to the pool. Second (and this is what the console simulates), voters are
          paid the <strong>trading fees plus incentives ("bribes")</strong> of exactly the pools they voted on, pro
          rata to their share of that pool's votes.
        </p>
        <p>
          The loop closes on itself: projects that want liquidity post bribes to attract votes, votes direct
          emissions, emissions attract liquidity, liquidity generates volume and fees, and fees plus bribes reward
          the voters. A veAERO position is therefore a claim on a slice of the venue's revenue:{" "}
          <em>which slice</em> depends entirely on where you place your votes. "Allocation" on this console means
          exactly that placement: spreading a fixed voting weight across pools to maximize the fees and bribes it
          collects. Locks can be made permanent, so the console treats your weight as constant; everything
          interesting is in where it sits.
        </p>
      </div>

      <div className="panel">
        <h2>2. Aerodrome v2: weekly epochs that pay backwards</h2>
        <p>
          v2 runs on a hard weekly clock. An <em>epoch</em> flips every Thursday 00:00 UTC. During the epoch,
          fees and bribes accumulate publicly in each pool's reward contracts, anyone can watch them grow. Each
          veAERO position may vote <strong>once per epoch</strong> (re-voting reverts); voting is blocked in the
          <strong> first hour after</strong> a flip (the distribute window), and, where the optional last-hour
          whitelist gate is enforced, in the <strong>last hour before</strong> the next flip for non-whitelisted
          positions. Votes <em>persist</em>: an untouched allocation keeps counting in later epochs at full weight.
          At the flip, the entire week's accumulated rewards are distributed to the vote weights standing{" "}
          <strong>at the end of the epoch</strong>, a vote cast Wednesday night earns the same share of the whole
          week's rewards as one cast the previous Thursday. Payouts are retroactive within the epoch, and that
          single property shapes every v2 strategy (§8).
        </p>
      </div>

      <div className="panel">
        <h2>3. Aero v3: continuous streaming (as published)</h2>
        <p>
          Aero replaces the weekly clock with continuous time. Revenue <em>streams</em> to allocators as it
          accrues, paid to whatever the weights are <strong>right now</strong>; there is no end-of-epoch
          checkpoint to arrive at late. Allocations can change at any moment, but each position carries a{" "}
          <strong>48-hour cooldown</strong> after acting. Emissions run per-second, and each gauge's emission rate
          is <em>capped</em> at a multiple (κ) of the pool's trailing revenue, emissions a pool "earns" above its
          cap are burned, which punishes vote weight parked where no revenue happens. An optional decay mechanism
          bleeds influence from stale allocations. One caveat this console is honest about: v3's code is not yet
          published; this description follows Aero's published articles, the model is rewritten against real code
          when it drops, and every deviation gets logged in the architecture fact table.
        </p>
      </div>

      <div className="panel">
        <h2>4. Zero-sum around the average, and the dilution that shapes it</h2>
        <p>
          Each pool's revenue (fees plus incentives) is split among allocators in proportion to the weight they have
          on that pool. Summed across all allocators, everyone's return per unit weight is, by construction, the
          global average: total revenue divided by total allocated weight. Nobody can beat the market{" "}
          <em>collectively</em>: one allocator's above-average return is exactly another's below-average one. Every
          strategy on this console is therefore playing a single game: <strong>take revenue share from other
          voters</strong>, specifically from the lagged, inattentive, or misallocated part of the crowd.
        </p>
        <p>
          The individual side of the same arithmetic is <strong>dilution</strong>. Put weight w on a pool with
          revenue rate R where everyone else holds W, and you earn R·w/(W+w); your own weight competes with
          itself. What the <em>next</em> unit of weight actually buys is the derivative of that,{" "}
          <strong>marginal yield = R·W/(W+w)²</strong>, and it falls as you pile on. Two consequences run through
          everything below: concentration is self-limiting (a modest pool nobody stands on can out-yield the
          biggest earner on the board), and the best allocation depends on <em>your size</em>: a small wallet and
          a large relay looking at the same market should not hold the same portfolio. Marginal yield is the
          quantity the water-filling result in §7 equalizes, and the quantity the Continuous greedy strategy's
          dead-band is measured in.
        </p>
      </div>

      <div className="panel">
        <h2>5. The two benchmarks</h2>
        <dl>
          <dt>Market benchmark (amber, dashed)</dt>
          <dd>
            A portfolio of your size holding every pool in proportion to its <em>global vote weight</em>, the
            market portfolio. It earns the global average by definition. It is investable: spread your votes like
            everyone else's, or park in a large relay, and you get approximately this. It carries no friction in the
            simulation (no cooldowns, instant rebalancing): it is the frictionless idealization of a passive
            hold, which a real static allocation tracks with small drift. Benchmarks are frictionless references;
            only the strategy pays friction.
          </dd>
          <dt>Revenue benchmark (cyan, dashed)</dt>
          <dd>
            A portfolio of your size holding every pool in proportion to <em>that week's total realized
            revenue</em>, a fixed weekly window in both economies. Its weight displaces yours pool-by-pool when
            computing earnings, so it answers: "what if this exact capital had been allocated revenue-proportionally
            instead?" Its weights require the window's revenue; on Aero v3 that means foresight (see §8), so it is a
            reference, not an investable alternative. It is also the allocation Aero's own on-target methodology scores against: in an
            efficient vote market, crowd weights converge to revenue shares, so this benchmark is simultaneously
            "the efficient market's portfolio".
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>6. Which benchmark must a strategy beat?</h2>
        <p>
          <strong>The market benchmark: it is the opportunity cost.</strong> If a strategy cannot beat it net of
          friction (cooldowns spent, keeper gas, operational risk), the rational move is to hold a broad,
          near-passive allocation and drop the active strategy. Cooldowns tax <em>changes</em>, not holding, so an
          allocation that barely rotates pays almost no friction; the benchmark itself is the frictionless
          idealization of that hold, and a real static allocation tracks it with small drift but negligible
          turnover. Because vote revenue is zero-sum around the average, beating the market benchmark is
          exactly equivalent to extracting revenue share from other voters, which is the product's entire purpose.
          This is the go/no-go criterion for real capital.
        </p>
        <p>
          <strong>The revenue benchmark is not a target; it is a ruler.</strong> It decomposes a result into two
          factors the raw vs-market number cannot separate:
        </p>
        <dl>
          <dt>edge = revenue bench − market bench</dt>
          <dd>
            How much inefficiency the crowd offered that run. When the crowd is fast and well-allocated, the two
            benchmarks converge and there was nothing to win; a flat vs-market is then the market's fault, not the
            strategy's, and turnover should be cut because activity has cost and no payoff.
          </dd>
          <dt>captured = (return − market bench) ÷ edge</dt>
          <dd>
            The fraction of the available edge the strategy collected: the engineering metric to optimize, because
            it is normalized against how much edge the market happened to offer. Falling capture with steady edge
            means the strategy degraded; falling edge with steady capture means the market got efficient.
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>7. Revenue-proportional is not the ceiling: water-filling is</h2>
        <p>
          The revenue benchmark is <em>not</em> the maximum a foresighted allocator could earn. Total earnings
          Σ wᵢRᵢ/(Wᵢ+wᵢ) are concave in each pool's w, so the maximum is where no reallocation helps: the marginal
          yield of §4, R·W/(W+w)², <em>equal across every funded pool</em>, like water poured into connected
          basins finding one level. That solution is a <strong>water-filling allocation</strong>: concentrate where
          revenue is high <em>relative to the crowd's weight</em>, skip pools where the crowd already sits, and
          fill thin pools first because a little weight there captures nearly all of their revenue.
          Revenue-proportional allocation coincides with the optimum only when the crowd is already efficient
          (weights proportional to revenue).
        </p>
        <p>
          This is measurable on the console: against a persistently mispriced crowd, the Water-filling strategy
          (with no foresight, only trailing signals) finishes <em>above</em> the revenue benchmark ("captured"
          exceeds 100%). That reading is meaningful, not a bug: it says the strategy did not merely follow the
          revenue, it exploited the crowd's mispricing beyond proportional tracking. The true ceiling would be
          foresight water-filling; the revenue benchmark is kept as the reference instead because it is the
          efficient-market mirror and matches the published on-target methodology.
        </p>
      </div>

      <div className="panel">
        <h2>8. Why the late voter works on v2 but not v3</h2>
        <p>
          <strong>On v2, retroactivity makes revenue-mirroring nearly optimal.</strong> Recall from §2 that the whole
          week's rewards go to end-of-epoch vote weights while the accruing revenue is observable on-chain in real
          time. So a voter who waits until just before the last-hour gate and votes proportional to
          revenue-so-far holds nearly all of the revenue benchmark's portfolio with zero foresight. This "late voter"
          play (the $/vote meta) makes the revenue benchmark <em>nearly investable on v2</em>, approximated here by
          the weekly Revenue mirror strategy phased late in the epoch. What still separates a real late voter from
          the benchmark: the final crowd weights (other late voters move the denominator simultaneously), revenue
          landing after the once-per-epoch vote is spent, and the last-hour whitelist gate.
        </p>
        <p>
          <strong>Aero v3 streams.</strong> Revenue pays to <em>current</em> weights as it accrues: allocating after
          observing revenue earns only what comes afterward, and the 48h cooldown delays even that. Retroactivity
          (and with it the late-voter exploit) is designed out. On v3 the revenue benchmark becomes a genuine
          foresight ceiling, and <em>prediction</em> becomes the only source of edge. That transition is the premise
          of this whole project: strategies that merely mirror trailing revenue stop winning, and
          persistence-aware, forward-looking allocation is what remains.
        </p>
      </div>

      <div className="panel">
        <h2>9. What the strategies do about it</h2>
        <p>
          That is the whole argument: on v3 the edge is prediction, it is exogenous and structurally decaying, and
          the business case reduces to <em>captured × edge &gt; operating cost</em>. The four decision rules that
          try to capture it (the mirror baseline, the persistence-aware predictor, the size-aware optimal response,
          and the block-speed reactor that argues against itself) each turn this theory into a concrete allocation
          policy. They get their own page: continue to <strong>Strategies</strong>.
        </p>
      </div>
    </main>
  );
}
