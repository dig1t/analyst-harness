export interface BackoffOptions {
  /** Base delay in milliseconds for the first retry. */
  baseMs: number;
  /** Upper bound for any single delay. */
  maxMs: number;
}

/**
 * Exponential backoff with "full jitter": a uniform random delay in
 * [0, min(maxMs, baseMs * 2^attempt)]. Spreads retries from many clients apart.
 */
export function computeBackoff(
  attempt: number,
  opts: BackoffOptions,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

export interface RetryOptions extends BackoffOptions {
  retries: number;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Override the computed delay (for example from a Retry-After header). */
  delayFor?: (err: unknown, attempt: number) => number | undefined;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying failures that `shouldRetry` accepts, up to `retries` extra attempts. */
export async function retry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const canRetry = attempt < opts.retries && (opts.shouldRetry ? opts.shouldRetry(err, attempt) : true);
      if (!canRetry) throw err;
      const delay = opts.delayFor?.(err, attempt) ?? computeBackoff(attempt, opts, opts.random);
      opts.onRetry?.(err, attempt, delay);
      await doSleep(delay);
    }
  }
}

/** Parse an HTTP Retry-After header (seconds or HTTP-date) into milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now: Date = new Date(),
): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now.getTime());
}
