---
tags: [scraping, operations, retries, backoff, idempotency]
aliases: [exponential backoff, jitter, full jitter, retry budget, idempotent writes, Retry-After]
---

# Retries, Backoff and Idempotency

> Sources: AWS Architecture Blog, Exponential Backoff And Jitter (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/); Amazon Builders' Library, Timeouts, retries, and backoff with jitter (https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/); RFC 9110 HTTP Semantics, sections 9.2.2 and 10.2.3 (https://www.rfc-editor.org/rfc/rfc9110); gRPC proposal A6, client retries and throttling (https://github.com/grpc/proposal/blob/master/A6-client-retries.md); urllib3 Retry reference (https://urllib3.readthedocs.io/en/stable/reference/urllib3.util.html); tenacity documentation (https://tenacity.readthedocs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Networks fail, servers shed load, and sites rate limit. A scraper that never retries loses data; one that retries badly turns a short outage on the target into a self-inflicted denial of service. Retry only failures that can succeed on a second try, wait with capped exponential backoff and random jitter, honor `Retry-After`, put a budget on retries so they cannot multiply, and make every write idempotent so that a repeated request or a re-run job never creates duplicates.

## What to retry

| Outcome | Retry? | How |
|---|---|---|
| Connection refused or reset, DNS failure, timeout | Yes | Backoff with jitter |
| `429 Too Many Requests` | Yes, slowly | Honor `Retry-After`; lower your request rate for the whole host |
| `503 Service Unavailable` | Yes | Honor `Retry-After` if present |
| `408`, `500`, `502`, `504` | Yes | Backoff with jitter |
| `520` to `524` (CDN-specific) | Usually | Treat like 5xx (curl and Scrapy retry 522 and 524) |
| `400`, `404`, `405`, `410`, `422` | No | Fix the request, or record the URL as gone |
| `401` | No | Refresh credentials once, then stop |
| `403` | No, not in a loop | Often a block or policy decision, see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md) |
| `200` with a challenge page or empty listing | Not immediately | Detect by content validation; back off for a long period |
| Parser exception | No refetch | Keep the raw response and fix the parser |

The full status-code playbook is in [HTTP Status Codes and How to React](../http/http-status-codes.md).

## Backoff formulas

From the AWS Architecture Blog analysis (`base` is the first delay, `cap` the maximum, `attempt` starts at 0):

| Strategy | Sleep before the next attempt |
|---|---|
| Exponential, no jitter | `min(cap, base * 2 ** attempt)` |
| **Full jitter** | `random_between(0, min(cap, base * 2 ** attempt))` |
| Equal jitter | `t = min(cap, base * 2 ** attempt); t / 2 + random_between(0, t / 2)` |
| Decorrelated jitter | `min(cap, random_between(base, previous_sleep * 3))` |

Without jitter, every client that failed together retries together, so load arrives in synchronized waves. The blog's simulations found the no-jitter variant clearly worst, and full jitter a good default that completes the work with few calls. With `base = 1 s` and `cap = 60 s`, the upper bounds grow 1, 2, 4, 8, 16, 32, 60, 60 seconds.

## TypeScript implementation

Uses the built-in `fetch` (Node 18+). Tested against a server that answers 503 with `Retry-After` twice, then 200.

```typescript
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** AWS "Full Jitter": sleep = random_between(0, min(cap, base * 2 ** attempt)). */
export function fullJitter(attempt: number, baseMs = 1_000, capMs = 60_000): number {
  return Math.random() * Math.min(capMs, baseMs * 2 ** attempt);
}

/** Retry-After is either delay-seconds or an HTTP-date (RFC 9110, section 10.2.3). */
export function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  if (/^\s*\d+\s*$/.test(value)) return Number(value) * 1_000;
  const when = Date.parse(value);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(
  url: string,
  init: RequestInit = {},
  { maxAttempts = 5, timeoutMs = 15_000, maxWaitMs = 120_000 } = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= maxAttempts - 1;
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (last) throw err; // network error or timeout on the final attempt
      await sleep(fullJitter(attempt));
      continue;
    }
    if (!RETRYABLE_STATUS.has(res.status) || last) return res;
    const waitMs = retryAfterMs(res.headers.get("retry-after")) ?? fullJitter(attempt);
    if (waitMs > maxWaitMs) return res; // too long: give up and reschedule the job
    await res.body?.cancel(); // release the connection before sleeping
    await sleep(waitMs);
  }
}
```

## Python implementation with a retry budget

`httpx` async version. The budget allows retries only while they stay below 10 percent of first attempts (plus a small floor), so a dead host cannot turn one run into thousands of retries.

```python
import asyncio
import email.utils
import random
import time

import httpx

RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504}
RETRYABLE_ERRORS = (httpx.TimeoutException, httpx.NetworkError, httpx.RemoteProtocolError)


def full_jitter(attempt: int, base: float = 1.0, cap: float = 60.0) -> float:
    return random.uniform(0, min(cap, base * 2**attempt))


def retry_after_seconds(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, when.timestamp() - time.time())


class RetryBudget:
    def __init__(self, ratio: float = 0.1, floor: int = 10) -> None:
        self.ratio, self.floor = ratio, floor
        self.attempts = 0
        self.retries = 0

    def note_attempt(self) -> None:
        self.attempts += 1

    def try_spend(self) -> bool:
        if self.retries >= self.floor + self.ratio * self.attempts:
            return False
        self.retries += 1
        return True


async def get_with_retries(client: httpx.AsyncClient, url: str, budget: RetryBudget,
                           max_attempts: int = 5, max_wait: float = 120.0) -> httpx.Response:
    budget.note_attempt()
    for attempt in range(max_attempts):
        last = attempt == max_attempts - 1
        try:
            resp = await client.get(url)
        except RETRYABLE_ERRORS:
            if last or not budget.try_spend():
                raise
            await asyncio.sleep(full_jitter(attempt))
            continue
        if resp.status_code not in RETRYABLE_STATUS or last:
            return resp
        delay = retry_after_seconds(resp.headers.get("Retry-After"))
        if delay is None:
            delay = full_jitter(attempt)
        if delay > max_wait or not budget.try_spend():
            return resp  # caller records the failure; the scheduler retries later
        await asyncio.sleep(delay)
    raise AssertionError("unreachable")
```

## Library equivalents

| Library | Default behavior | Notes |
|---|---|---|
| urllib3 `Retry` (requests) | `backoff_factor=0`, so no sleep until you set it | Delay is `backoff_factor * 2 ** (n - 1)`, the first retry is immediate, `backoff_jitter` adds jitter on top; `respect_retry_after_header=True` for 413, 429, 503; POST is not retried by default |
| tenacity | Nothing until configured | `wait_random_exponential(multiplier=1, max=60)` is full jitter |
| httpx | `HTTPTransport(retries=n)` retries only connect errors and connect timeouts | Use your own loop or tenacity for status codes |
| got | 2 retries for 408, 413, 429, 500, 502, 503, 504, 521, 522, 524 | No default timeout: always set one |
| Scrapy | `RETRY_TIMES = 2` for 500, 502, 503, 504, 522, 524, 408, 429 | Retries go back into the scheduler |
| Crawlee | `maxRequestRetries: 3` | Per request, plus session rotation |
| BullMQ | Retries only with `attempts` | `backoff: { type: "exponential", delay, jitter }` |
| Celery | Autoretry only for exceptions listed in `autoretry_for`; `max_retries` defaults to 3 | `retry_backoff=True` enables exponential delays (capped by `retry_backoff_max`, default 600 s); `retry_jitter` defaults to `True` |
| curl | `--retry N`: 1 s, doubling to 10 minutes | Honors `Retry-After` since 7.66.0 |

## Retry budgets and layering

Retries multiply across layers. An HTTP client that retries 3 times, inside a task queue that retries 3 times, inside a scheduler that re-runs failed jobs, sends up to 27 requests for one URL. The Builders' Library recommends retrying at a single point in the stack, and limiting retries locally with a token bucket so that, once tokens run out, retries continue only at a fixed rate (the AWS SDKs have done this since 2016). gRPC's retry throttling is a precise version of the same idea: each failure removes 1 token, each success adds `tokenRatio`, and no retries happen while the count is at or below half of `maxTokens`.

For scrapers, add two run-level budgets on top: an error-rate stop (for example abort the run when more than 20 percent of the last 200 requests failed; Scrapy has `CLOSESPIDER_ERRORCOUNT`) and a total deadline per run. A run that stops early and alerts is cheaper, and politer, than one that grinds through every URL against a failing site.

## Idempotency

Retries and re-runs are only safe if repeating an action has the same effect as doing it once.

- **HTTP methods.** RFC 9110 defines GET, HEAD, OPTIONS, TRACE, PUT and DELETE as idempotent; POST is not. Client libraries refuse to retry POST by default for this reason. If an API accepts an `Idempotency-Key` header, send one per logical operation.
- **Stable identity.** Derive record keys from the source (`source`, `source_id`) or from a canonical URL (see [URL Normalization and Canonicalization](../crawling/url-normalization.md)), never from an auto-increment counter assigned at insert time.
- **Upserts.** Write with `INSERT ... ON CONFLICT ... DO UPDATE`, keyed on that identity plus the observation period, so a retried batch overwrites instead of duplicating:

```sql
INSERT INTO product_observation AS o
  (source, source_id, observed_on, price_cents, currency, content_hash, fetched_at)
VALUES ($1, $2, $3, $4, $5, $6, now())
ON CONFLICT (source, source_id, observed_on) DO UPDATE
  SET price_cents  = EXCLUDED.price_cents,
      currency     = EXCLUDED.currency,
      content_hash = EXCLUDED.content_hash,
      fetched_at   = EXCLUDED.fetched_at
  WHERE o.content_hash IS DISTINCT FROM EXCLUDED.content_hash;
```

- **Side effects.** Alerts, webhooks and messages are not idempotent. Keep a ledger of what was sent (keyed by entity and event) and check it before sending, so a retried job does not page someone twice.
- **At-least-once.** Queues redeliver messages after crashes and visibility timeouts (see [Queues and Workers](queues-and-workers.md)). Design consumers for duplicates instead of hoping for exactly-once delivery.

Storage-side patterns are covered in [PostgreSQL for Scraped Data](../storage/postgres-for-scraped-data.md) and [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md).

## Pitfalls

- Retrying 403s and challenge pages in a tight loop: that escalates a block instead of resolving it.
- Ignoring `Retry-After`, or obeying a value of hours inside a worker that holds a lock. Cap the wait and reschedule.
- Fixed delays without jitter, so all workers retry in lockstep.
- Retrying at several layers and multiplying traffic.
- Assuming urllib3's backoff starts at the first retry: with `backoff_factor` set, the first retry still happens immediately.
- Retrying non-idempotent POSTs (search forms, cart actions) without an idempotency key.
- Insert-only writes with surrogate keys, so every retry adds a duplicate row.
- Not consuming or cancelling response bodies in Node before sleeping, which holds connections from the pool.

## Checklist

- [ ] Retryable outcomes listed explicitly; 4xx (except 408 and 429) not retried
- [ ] Capped exponential backoff with full jitter
- [ ] `Retry-After` parsed (seconds and HTTP-date), with a maximum wait
- [ ] Retries happen at one layer only
- [ ] Retry budget and a run-level error-rate stop
- [ ] Natural or deterministic keys, upsert writes
- [ ] Ledger for side effects such as alerts and webhooks

## See Also

- [HTTP Status Codes and How to React](../http/http-status-codes.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
- [Queues and Workers](queues-and-workers.md)
- [Concurrency and Async IO](concurrency-and-async.md)
- [PostgreSQL for Scraped Data](../storage/postgres-for-scraped-data.md)
