/** Captured vs expected, per pool: the strategy's cumulative revenue from
 *  each pool against what a passive market-cap portfolio of the same size
 *  would have earned from it (the per-pool market benchmark). The multiple
 *  is the reading: the published cbBTC early-allocator statistic — earliest
 *  allocators realized ~1.43× the fees a trailing-performance expectation
 *  predicted (Sep 2024 – Feb 2025) — is exactly this number on the growing
 *  pool's row. Mirrors core's poolCaptures() definition on display floats.
 */
import type { DisplayResult } from "../lib/serialize.js";
import { moneyFor } from "../lib/format.js";

const GOOD_AT = 1.05;
const BAD_AT = 0.95;

export function CaptureTable({ result }: { result: DisplayResult }) {
  const { poolNames, earned, marketBenchmarkEarned } = result.allocation;
  const earnedRow = earned.at(-1);
  const benchRow = marketBenchmarkEarned.at(-1);
  if (!earnedRow || !benchRow || poolNames.length === 0) return null;
  const money = moneyFor(result.revenueUnit);

  const rows = poolNames
    .map((name, i) => {
      const e = earnedRow[i] ?? 0;
      const b = benchRow[i] ?? 0;
      return { name, earned: e, bench: b, multiple: b > 0 ? e / b : null };
    })
    .sort((a, b) => b.earned - a.earned);

  return (
    <div className="capture-wrap">
      <table className="capture-table">
        <thead>
          <tr>
            <th>pool</th>
            <th className="num">strategy earned</th>
            <th className="num">expected (market bench)</th>
            <th className="num">capture ×</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td className="num">{money(row.earned, 0)}</td>
              <td className="num">{money(row.bench, 0)}</td>
              <td
                className={`num mult ${
                  row.multiple === null ? "" : row.multiple >= GOOD_AT ? "good" : row.multiple <= BAD_AT ? "bad" : ""
                }`}
              >
                {row.multiple === null ? "—" : `${row.multiple.toFixed(2)}×`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="capture-note">
        captured vs expected: revenue earned per pool relative to a passive market-cap portfolio of the same
        total weight. The published cbBTC early-allocator backtest reads 1.43× in this column.
      </p>
    </div>
  );
}
