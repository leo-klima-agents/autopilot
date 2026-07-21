/** Captured vs expected, per pool: the strategy's cumulative revenue from
 *  each pool against what a passive market-cap portfolio of the same size
 *  would have earned from it, and their ratio. The rows arrive precomputed
 *  on DisplayResult.captures — core's poolCaptures() is the single
 *  definition of the statistic; this component only sorts, formats, and
 *  colors. The published cbBTC early-allocator backtest (earliest
 *  allocators realized ~1.43× the fees a trailing-performance expectation
 *  predicted, Sep 2024 – Feb 2025) reads as this multiple on the growing
 *  pool's row.
 */
import type { DisplayResult } from "../lib/serialize.js";
import { moneyFor } from "../lib/format.js";

const GOOD_AT = 1.05;
const BAD_AT = 0.95;

export function CaptureTable({ result }: { result: DisplayResult }) {
  if (result.captures.length === 0) return null;
  const money = moneyFor(result.revenueUnit);
  const rows = [...result.captures].sort((a, b) => b.earned - a.earned);

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
            <tr key={row.pool}>
              <td>{row.name}</td>
              <td className="num">{money(row.earned, 0)}</td>
              <td className="num">{money(row.benchmarkEarned, 0)}</td>
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
