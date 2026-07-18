/**
 * Exact USD valuation of an epoch's reward amounts. Pure — prices and
 * decimals are injected — so the arithmetic is unit-testable offline.
 *
 * Per amount: usdWad = amountRaw × priceWad / 10^decimals (bigint floor).
 * The bucket totals are sums of independently-floored terms, so they are
 * deterministic and independent of token order. Amounts whose token has no
 * price for the epoch's date (or no cached decimals) are skipped and counted,
 * never guessed.
 */

import type { EpochRecord, TokenAmount } from "./schema.js";
import { parseAmount } from "./schema.js";
import { priceDateForEpoch } from "./prices.js";

export interface EpochUsdResult {
  /** Fee revenue in Wad USD. */
  feesUsd: bigint;
  /** Bribe (incentive) revenue in Wad USD. */
  bribesUsd: bigint;
  /** Non-zero TokenAmount entries successfully priced (fees + bribes). */
  pricedAmounts: number;
  /** Non-zero TokenAmount entries seen (fees + bribes). */
  totalAmounts: number;
}

export interface EpochUsdDeps {
  /** Token decimals from the token cache; undefined = unknown, skip. */
  decimalsOf: (addrLower: string) => number | undefined;
  /** Wad USD price for the token at a date; undefined = unpriced, skip. */
  priceWadAt: (addrLower: string, date: string) => bigint | undefined;
}

export function computeEpochUsd(epoch: EpochRecord, deps: EpochUsdDeps): EpochUsdResult {
  const date = priceDateForEpoch(epoch.ts);
  const result: EpochUsdResult = { feesUsd: 0n, bribesUsd: 0n, pricedAmounts: 0, totalAmounts: 0 };

  const value = (entries: readonly TokenAmount[]): bigint => {
    let total = 0n;
    for (const entry of entries) {
      const amount = parseAmount(entry.amount);
      if (amount === 0n) continue;
      result.totalAmounts += 1;
      const addr = entry.token.toLowerCase();
      const decimals = deps.decimalsOf(addr);
      const priceWad = deps.priceWadAt(addr, date);
      if (decimals === undefined || priceWad === undefined) continue;
      result.pricedAmounts += 1;
      total += (amount * priceWad) / 10n ** BigInt(decimals);
    }
    return total;
  };

  result.feesUsd = value(epoch.fees);
  result.bribesUsd = value(epoch.bribes);
  return result;
}

/** The per-amount conversion, exported so tests can document floor semantics. */
export function usdWadOf(amountRaw: bigint, priceWad: bigint, decimals: number): bigint {
  return (amountRaw * priceWad) / 10n ** BigInt(decimals);
}
