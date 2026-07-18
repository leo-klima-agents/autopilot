/**
 * Shared retry/pacing helpers for the data pipeline (indexer + price fetcher).
 * Injectable sleep/log so retry paths are unit-testable without real timers.
 */

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface RetryOptions {
  /** Attempts before giving up. Default 3 (backoff 1s/2s/4s). */
  retries?: number;
  log?: (message: string) => void;
  sleepFn?: (ms: number) => Promise<void>;
}

/** Retries `fn` with exponential backoff, rethrowing the last error. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  { retries = 3, log = console.warn, sleepFn = sleep }: RetryOptions = {},
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const backoff = 1_000 * 2 ** (attempt - 1);
      log(`  retry ${attempt}/${retries} for ${label} in ${backoff}ms: ${String(err)}`);
      await sleepFn(backoff);
    }
  }
  throw lastError;
}
