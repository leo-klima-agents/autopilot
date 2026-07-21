/** Shared number formatting for the instruments. `moneyFor` applies the
 *  revenueUnit convention: "$" prefix for USD-denominated runs (priced
 *  historical data and the dollar-calibrated synthetic scenarios), plain
 *  index units otherwise, every panel must agree on this. */

export function fmt(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "n/a";
  if (Math.abs(n) >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function moneyFor(unit: "usd" | "index"): (n: number, digits?: number) => string {
  return (n, digits) => (unit === "usd" ? `$${fmt(n, digits)}` : fmt(n, digits));
}
