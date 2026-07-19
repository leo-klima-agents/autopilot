/**
 * The glossary: every term used across the console, Theory, Strategies, and
 * Guide, defined once. A dip-in reference, not a read-through, ordered
 * roughly from the exchange outward to the simulator's own concepts.
 */

export function Vocabulary({ onClose }: { onClose: () => void }) {
  return (
    <main className="guide">
      <div className="panel">
        <button className="copy-link" onClick={onClose}>
          Back to the console
        </button>
        <h2>Vocabulary</h2>
        <p>
          Every term used across the console and its other pages, defined once. Dip in as needed; the Theory page is
          where these concepts are actually developed.
        </p>
        <dl>
          <dt>Pool</dt>
          <dd>
            A trading pair on the exchange (e.g. vAMM-WETH/USDC). The prefix encodes the pool type: vAMM = volatile
            pair, sAMM = stable pair, CL&lt;n&gt; = concentrated-liquidity (Slipstream) pool with tick spacing n.
            Pools earn trading fees; those fees (plus any incentives) are the revenue that allocators compete for.
          </dd>
          <dt>Staking weight / allocation</dt>
          <dd>
            Your locked tokens give you weight; allocating it to a pool entitles you to a slice of that pool's
            revenue, pro-rata against everyone else's weight on the same pool. Allocating is free to hold, the cost
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
            that position for a minimum period, planned at launch to be 48 hours, per position. The cooldown is the
            central constraint every strategy here works around.
          </dd>
          <dt>Cooldown scope</dt>
          <dd>
            "Per position" means each tranche's cooldown runs independently (the published plan), so staggered
            tranches let you reallocate in a pipeline. "Global" is the pessimistic what-if where one change locks
            everything; it exists to show how much of the tranche design's value depends on that one protocol detail.
          </dd>
          <dt>Tranche</dt>
          <dd>
            One separately-staked position. Positions can't be split after creation, so the tranche structure must
            exist from the start. With N tranches on per-position cooldowns, you can move 1/N of your weight every
            cooldown/N interval instead of everything at once every cooldown.
          </dd>
          <dt>Marginal yield</dt>
          <dd>
            What the <em>next</em> unit of weight actually earns on a pool: R·W/(W+w)², with R the pool's revenue
            rate, W everyone else's weight, w yours. It falls as you pile weight on, which is why a modest pool
            nobody stands on can out-yield the biggest earner on the board. Theory §4 derives it; Water-filling
            equalizes it.
          </dd>
          <dt>Emissions</dt>
          <dd>
            New tokens the protocol streams to pools as liquidity rewards, split across pools by total allocated
            weight. Emissions don't go to allocators here; they matter because the on-target instrument measures how
            well allocation steered emissions toward where the revenue actually was.
          </dd>
          <dt>Gauge caps &amp; κ (kappa)</dt>
          <dd>
            v3's inflation brake: a pool's emission rate is capped at κ × its trailing revenue rate, recalibrated on
            an interval (48h default). Emissions above the cap are burned, never paid. κ = 1.2 is the number Aero has
            used in examples, treat it as a placeholder, not a commitment.
          </dd>
          <dt>Allocation decay</dt>
          <dd>
            An optional v3 behavior: an allocation left untouched slowly loses influence, so passive positions bleed
            weight relative to active ones. Off by default here (the decay rate is unpublished).
          </dd>
          <dt>Crowd</dt>
          <dd>
            Everyone else's weight. The <em>reactive herd</em> chases trailing revenue with an information lag; it
            sees the market as it was "lag" seconds ago and re-splits proportionally. A <em>static</em> crowd never
            moves. The crowd is what you are racing: being early only pays if someone arrives after you.
          </dd>
          <dt>Wash-bait</dt>
          <dd>
            An adversarial pool that pumps fake fees in short bursts to look attractive, then pulls them. Strategies
            that only read trailing revenue chase it and get nothing; persistence-aware scoring discounts it.
          </dd>
          <dt>Market / revenue benchmark</dt>
          <dd>
            The two dashed reference portfolios on every instrument: the market benchmark holds pools in proportion
            to global vote weight, the revenue benchmark holds each week's realized revenue shares with foresight.
            USD-denominated on historical replays. What they mean and which one a strategy must beat is Theory §5–6.
          </dd>
          <dt>Captured</dt>
          <dd>
            The fraction of the available edge (revenue benchmark − market benchmark) that the strategy actually
            collected: (return − market bench) ÷ edge. The engineering metric to optimize; can exceed 100% when a
            strategy beats the revenue benchmark against a mispriced crowd (Theory §6–7).
          </dd>
          <dt>Wad</dt>
          <dd>
            A fixed-point number scaled by 10¹⁸, the exchange's native precision. A few strategy fields take Wad
            decimal strings: <code>500000000000000000</code> means 0.5, i.e. 50%.
          </dd>
        </dl>
      </div>
    </main>
  );
}
