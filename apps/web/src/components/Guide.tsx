/**
 * The operator's guide: every term, input, strategy, and instrument on the
 * console, explained for someone who has never seen a ve(3,3) exchange from
 * the inside. Content mirrors the actual implementation in
 * @aero-autopilot/core — when the code and this page disagree, that is a bug.
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
          This console replays <em>allocation strategies</em> against the Aero/Aerodrome economy. You hold a fixed
          amount of staking weight, split into tranches. A strategy decides, over and over, how to spread that weight
          across liquidity pools. Pools generate revenue (trading fees plus incentives), and revenue flows back to
          allocators in proportion to the weight they have on each pool. The whole run is deterministic: the same
          flight plan always produces exactly the same result, which is why a copied link reproduces a run bit for
          bit.
        </p>
        <p>
          The question every run answers: <em>did this strategy earn more than doing nothing clever?</em> "Nothing
          clever" is the market benchmark — the return of simply holding the market-average allocation. For the full
          reasoning behind the benchmarks, see the Theory page.
        </p>
      </div>

      <div className="panel">
        <h2>Vocabulary</h2>
        <dl>
          <dt>Pool</dt>
          <dd>
            A trading pair on the exchange (e.g. vAMM-WETH/USDC). The prefix encodes the pool type: vAMM = volatile
            pair, sAMM = stable pair. Pools earn trading fees; those fees (plus any incentives) are the revenue that
            allocators compete for.
          </dd>
          <dt>Staking weight / allocation</dt>
          <dd>
            Your locked tokens give you weight; allocating it to a pool entitles you to a slice of that pool's
            revenue, pro-rata against everyone else's weight on the same pool. Allocating is free to hold — the cost
            of a bad allocation is the better revenue you didn't earn elsewhere.
          </dd>
          <dt>Epoch</dt>
          <dd>
            Aerodrome v2 runs on one-week cycles that flip every Thursday 00:00 UTC. Under v2 rules a position can
            change its allocation once per epoch, and revenue settles as a weekly lump sum at the flip. Chart time
            ticks land on these flips.
          </dd>
          <dt>Allocation cooldown</dt>
          <dd>
            The v3 (Aero) replacement for the epoch clock: allocations can change at any moment, but each change locks
            that position for a minimum period — planned at launch to be 48 hours, per position. The cooldown is the
            central constraint every strategy here works around.
          </dd>
          <dt>Cooldown scope</dt>
          <dd>
            "Per position" means each tranche's cooldown runs independently (the published plan), so staggered
            tranches let you reallocate in a pipeline. "Global" is the pessimistic what-if where one change locks
            everything — it exists to show how much of the tranche design's value depends on that one protocol detail.
          </dd>
          <dt>Tranche</dt>
          <dd>
            One separately-staked position. Positions can't be split after creation, so the tranche structure must
            exist from the start. With N tranches on per-position cooldowns, you can move 1/N of your weight every
            cooldown/N interval instead of everything at once every cooldown.
          </dd>
          <dt>Emissions</dt>
          <dd>
            New tokens the protocol streams to pools as liquidity rewards, split across pools by total allocated
            weight. Emissions don't go to allocators here — they matter because the on-target instrument measures how
            well allocation steered emissions toward where the revenue actually was.
          </dd>
          <dt>Gauge caps &amp; κ (kappa)</dt>
          <dd>
            v3's inflation brake: a pool's emission rate is capped at κ × its trailing revenue rate, recalibrated on
            an interval (48h default). Emissions above the cap are burned, never paid. κ = 1.2 is the number Aero has
            used in examples — treat it as a placeholder, not a commitment.
          </dd>
          <dt>Allocation decay</dt>
          <dd>
            An optional v3 behavior: an allocation left untouched slowly loses influence, so passive positions bleed
            weight relative to active ones. Off by default here (the decay rate is unpublished).
          </dd>
          <dt>Crowd</dt>
          <dd>
            Everyone else's weight. The <em>reactive herd</em> chases trailing revenue with an information lag — it
            sees the market as it was "lag" seconds ago and re-splits proportionally. A <em>static</em> crowd never
            moves. The crowd is what you are racing: being early only pays if someone arrives after you.
          </dd>
          <dt>Wash-bait</dt>
          <dd>
            An adversarial pool that pumps fake fees in short bursts to look attractive, then pulls them. Strategies
            that only read trailing revenue chase it and get nothing; persistence-aware scoring discounts it.
          </dd>
          <dt>Market benchmark</dt>
          <dd>
            The return per unit weight of holding the global average allocation: total market revenue divided by
            total allocated weight, accumulated over the run. USD-denominated on historical replays. Any strategy
            worth running must beat this after turnover.
          </dd>
          <dt>Wad</dt>
          <dd>
            A fixed-point number scaled by 10¹⁸ — the exchange's native precision. A few strategy fields take Wad
            decimal strings: <code>500000000000000000</code> means 0.5, i.e. 50%.
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>The flight plan, panel by panel</h2>

        <h3>Strategy</h3>
        <p>
          <strong>engine</strong> picks the decision rule (each explained in the next section). The fields below it
          are that strategy's own knobs:
        </p>
        <dl>
          <dt>lookbackSec</dt>
          <dd>
            How far back the strategy looks when measuring a pool's revenue. Short lookbacks react fast but chase
            noise; long ones are steady but late.
          </dd>
          <dt>cadenceSec</dt>
          <dd>How often the strategy re-evaluates and (possibly) proposes a new allocation.</dd>
          <dt>submitOffsetSec (weekly grid only)</dt>
          <dd>
            How many seconds before the Thursday flip to submit. Voting late uses the freshest information — voting
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
            still — churn costs turnover and burns cooldowns.
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
            The rule set, not the data. <em>Aero v3 — continuous</em>: revenue streams every second, allocations move
            any time subject to the cooldown. <em>Aerodrome v2 — weekly epochs</em>: one allocation change per epoch,
            revenue settles at each flip, voting blocked in the first hour after a flip. The timeline (real dates vs
            relative days) comes from the market data panel, not from this choice.
          </dd>
          <dt>allocation cooldown</dt>
          <dd>
            Minimum time between allocation changes per position: 7d mirrors v2's effective cadence, 48h is the v3
            launch plan, 1h and 1-block are what-ifs. At 1 block the "latency race" preset shows why faster isn't
            better.
          </dd>
          <dt>gauge caps + cap multiplier κ ×1000</dt>
          <dd>Enables the emission cap described above; 1200 = κ of 1.2×.</dd>
          <dt>allocation decay</dt>
          <dd>Enables stale-allocation decay (see vocabulary).</dd>
          <dt>emissions / day</dt>
          <dd>
            Whole tokens per day the protocol emits across all pools. Only affects the emission-steering instruments
            (on/off-target) and cap/burn accounting — allocator revenue comes from fees.
          </dd>
        </dl>

        <h3>Market data</h3>
        <dl>
          <dt>source</dt>
          <dd>
            <em>Aerodrome historical</em>: real per-epoch fees and bribes for the top ~30 pools by trailing
            revenue (Slipstream CL and v2 AMM pools alike), indexed on-chain and priced in USD from daily
            Alchemy price history — the x axis shows real dates and the instruments show dollars. <em>Synthetic scenario</em>: a generated market, exactly reproducible from
            the seed — the x axis shows relative days (d0, d7, …) because its calendar anchor is arbitrary.
          </dd>
          <dt>seed</dt>
          <dd>The random seed. Same seed, same market, always — this is what makes shared links exact.</dd>
          <dt>fee process</dt>
          <dd>
            The personality of synthetic fees. <em>persistent</em>: levels drift slowly — yesterday predicts today.
            <em> bursty</em>: occasional 5× fee weeks land at random. <em>regime-switching</em>: pools flip between a
            quiet state and a 4× hot state and stay there for a while.
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
            epoch and replay backwards from there — a 12-week run covers the latest 12 weeks, and the still-in-progress
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
        <h2>The strategies</h2>

        <h3>How every strategy works</h3>
        <p>
          A strategy is a pure function that wakes on a fixed clock (its <em>cadence</em>, possibly phase-shifted —
          the weekly one wakes just before epoch flips) and, given the market right now, proposes a{" "}
          <em>target allocation</em>: what fraction of the portfolio should sit on each pool, summing to 100%. The
          only information it gets is public and backward-looking — each pool's current vote weight and its{" "}
          <em>trailing revenue</em>, the fees + incentives accrued over the strategy's lookback window. No strategy
          here sees the future; they differ in how they turn that trailing signal into a target and in how reluctant
          they are to act on it.
        </p>
        <p>
          Strategies never move weight themselves. The <em>scheduler</em> takes the proposed target, compares it to
          what each tranche currently holds, and rotates only the tranches whose cooldown has expired — so the
          portfolio converges to a new target in staggered steps across several wake-ups, and re-proposing the same
          target is a no-op. This makes rotations the scarce resource: every move spends that tranche's cooldown,
          locking it through whatever happens next.
        </p>
        <p>
          Two ideas recur across the strategies. First, <em>marginal yield</em> — what the next unit of weight
          actually earns on a pool, R·W/(W+w)². It falls as your own weight w piles onto the crowd's W, which is
          why a modest pool nobody stands on can beat the biggest earner on the board; the Theory page (§4) derives
          it and builds the optimal allocation from it (§7). Second, <em>restraint</em>: because acting costs a
          cooldown (and, live, gas), the better strategies carry an explicit device — a drift threshold, a
          dead-band — that refuses trades too small to pay for themselves.
        </p>

        <h3>Revenue mirror — weekly / 48h / 24h / 1h</h3>
        <p>
          <strong>Signal:</strong> trailing revenue per pool over <code>lookbackSec</code>.{" "}
          <strong>Target:</strong> exactly proportional — a pool that produced 12% of the lookback's revenue gets
          12% of the portfolio, dilution ignored. <strong>Moves:</strong> every wake-up, unconditionally; no
          restraint device at all. <strong>Why it exists:</strong> it is the investable twin of the revenue
          benchmark, lagged by one window — the honest baseline any cleverer strategy must justify itself against.
          The four variants share everything but the clock, so running them side by side isolates what acting more
          often is worth. The weekly variant wakes <code>submitOffsetSec</code> before the Thursday flip, making it
          the late voter of Theory §8, and is the only strategy that can run live against Aerodrome v2 today.
        </p>

        <h3>Persistence carry</h3>
        <p>
          <strong>Signal:</strong> trailing revenue, discounted by how erratically it arrived. The lookback is cut
          into <code>buckets</code> equal sub-windows; volatility is the mean absolute deviation of the bucket
          revenues over their mean, capped at 100%; each pool's revenue is then haircut in proportion, up to{" "}
          <code>haircutWad</code> at full volatility. Two pools with identical totals stop being identical: the one
          that earned steadily keeps its score, the one that earned everything in a single spike loses up to half of
          it. <strong>Target:</strong> proportional to the haircut scores. <strong>Moves:</strong> only when the new
          ideal has drifted more than <code>sWad</code> (in total allocation moved) from the last target it actually
          submitted — an (s,S) rule, and it is careful not to "spend" that trigger while every tranche is still
          locked. <strong>Why it exists:</strong> this is the strategy shaped for the v3 world, where a 48h cooldown
          makes every move a commitment. The haircut is what refuses wash-bait (a pumped pool is maximally
          volatile); the drift threshold is what keeps turnover low enough that the cooldowns are spent on moves
          that matter.
        </p>

        <h3>Water-filling</h3>
        <p>
          <strong>Signal:</strong> trailing revenue per pool, plus each pool's current external weight — this is the
          one family that looks at the crowd, not just the fees. <strong>Target:</strong> the allocation that
          maximizes total expected revenue Σ wᵢRᵢ/(Wᵢ+wᵢ) for a portfolio of your size. At the optimum every funded
          pool has the same marginal yield — like pouring water into connected basins until one level holds — which
          the implementation finds exactly by binary-searching that common level (λ) in integer arithmetic. Pools
          whose marginal yield never reaches the level get nothing. <strong>Moves:</strong> every wake-up (default
          48h), no restraint device. <strong>Why it exists:</strong> it is the optimal response to a mispriced
          crowd, and the reason "captured" can exceed 100% (Theory §7): where the mirror family copies revenue
          shares, water-filling deliberately over-weights thin pools with real revenue and under-weights crowded
          ones — big portfolios spread out, small ones concentrate. It is also the sizing engine inside Continuous
          greedy.
        </p>

        <h3>Continuous greedy</h3>
        <p>
          <strong>Signal:</strong> the same inputs as Water-filling, re-read on every tick — down to one Base block
          (2 seconds). <strong>Target:</strong> the water-filled ideal. <strong>Moves:</strong> almost never, and
          that is the design. Each tick it measures how much better the best marginal yield anywhere is than the
          worst one it currently holds — exactly what moving one unit of weight would gain. If no tranche is off
          cooldown, nothing can move and it waits; if the gap is smaller than <code>thresholdWad + costWad</code>{" "}
          (the noise floor plus what a rotation costs), moving would be churn and it re-affirms the last target;
          only when the gap clears that dead-band does it jump to the full ideal. <strong>Why it exists:</strong> to
          answer whether block-speed reaction is worth anything. Run the "latency race" Logbook entry: against a
          fast crowd reading the same public signal the gap almost never clears the dead-band, and returns converge
          to the market average minus the few rotations' cost — design principle P3, demonstrated rather than
          asserted.
        </p>
      </div>

      <div className="panel">
        <h2>Reading the instruments</h2>
        <dl>
          <dt>Return</dt>
          <dd>Cumulative revenue earned per unit of your staking weight over the run.</dd>
          <dt>Vs bench</dt>
          <dd>
            Return minus the market benchmark. Green and positive means the strategy beat holding the market
            average; red means you paid for activity and got nothing.
          </dd>
          <dt>Max DD vs bench</dt>
          <dd>
            The deepest peak-to-trough fall of (your equity − benchmark). It measures the worst stretch of
            underperformance you'd have sat through, even if the run ends ahead.
          </dd>
          <dt>On target / Off target</dt>
          <dd>
            Aero's published emissions-accuracy methodology: at every sample, compare each pool's share of emissions
            with its revenue-optimal share. Within 2 percentage points counts as on-target; more than 5pp off counts
            as off-target. Aero's own backtests report ~48% on-target for weekly voting, ~64% with a 48h revote, ~70%
            with gauge caps added — this console reproduces the measurement so you can see where a strategy lands.
          </dd>
          <dt>Turnover</dt>
          <dd>
            Total allocation movement: half the L1 distance of every executed rotation, summed. High turnover with a
            thin vs-bench edge is a strategy that works only until costs exist.
          </dd>
          <dt>Rotations / blocked</dt>
          <dd>
            Executed reallocations, and submissions the protocol refused (cooldown not elapsed, or a v2 epoch rule).
            Persistent blocks mean the strategy's cadence is fighting the protocol's clock.
          </dd>
          <dt>Equity chart</dt>
          <dd>
            Solid phosphor line: your cumulative return. Dashed amber: the market benchmark. Dashed cyan:
            the revenue benchmark — the foresight ceiling (see the toggle entry below). Your line should live between
            the two dashed ones; how far up that band it sits is the strategy's skill. Time ticks land on epoch flips
            (Thursdays, UTC).
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
          <dt>strategy / market bench / revenue bench toggle</dt>
          <dd>
            Flips both heat-maps between three portfolios of the same size. <em>Strategy</em> is yours.{" "}
            <em>Market bench</em> is the market portfolio: every pool held in proportion to its global vote weight —
            what doing nothing earns. <em>Revenue bench</em> is the foresight benchmark: each weekly epoch it holds
            pools in proportion to that epoch's realized revenue, which no real allocator could know in advance — it is
            the ceiling, not an investable alternative. Its weight replaces yours in each pool when computing earnings,
            so it answers "what if this portfolio had been allocated revenue-optimally instead". The strategy's worth
            lives between the two benchmarks: the "captured" figure on the Vs-bench gauge is the fraction of the
            foresight edge (revenue bench − market bench) the strategy actually collected. Note that with a reactive
            herd the crowd itself chases revenue, so the foresight edge shrinks as the herd lag shortens — that is the
            market getting efficient, not a bug.
          </dd>
        </dl>
      </div>

      <div className="panel">
        <h2>Scenarios</h2>
        <dl>
          <dt>Early allocator</dt>
          <dd>
            A regime-switching market with a slow crowd (3-day lag). Persistence carry takes weight in a pool as it
            turns hot, earns an outsized revenue share while alone, and cedes it as the herd arrives — the cbBTC
            story from Aero's economic case, in miniature.
          </dd>
          <dt>Latency race</dt>
          <dd>
            Continuous greedy at one-block cooldown against a fast crowd. Watch vs-market hug zero: at this cadence
            reaction has no edge, only costs. This preset exists to argue against itself.
          </dd>
          <dt>Wash-bait</dt>
          <dd>
            One pool pumps fake fees in bursts (8× its organic rate, two days at a time). Persistence carry with a
            deep haircut refuses the bait a naive trailing-fee grid would chase into losses.
          </dd>
        </dl>
        <p>
          Every run — presets included — lives entirely in the URL. "Copy link to this run" hands someone your exact
          flight plan, and the deterministic core guarantees their replay matches yours to the last wei.
        </p>
      </div>
    </main>
  );
}
