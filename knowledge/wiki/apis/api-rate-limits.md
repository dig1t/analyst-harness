---
tags: [scraping, apis, rate-limiting, quotas, retry-after]
aliases: [429 Too Many Requests, Retry-After, X-RateLimit headers, RateLimit header, API quota, API throttling]
---

# API Rate Limits and Quotas

> Sources: RFC 6585, section 4, 429 Too Many Requests (https://www.rfc-editor.org/rfc/rfc6585#section-4); RFC 9110, section 10.2.3, Retry-After (https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3); IETF HTTPAPI working group, RateLimit header fields for HTTP, draft-ietf-httpapi-ratelimit-headers (https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/); GitHub Docs, Rate limits for the REST API (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api); GitHub Docs, Rate limits and query limits for the GraphQL API (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api); Stripe engineering blog, Scaling your API with rate limiters (https://stripe.com/blog/rate-limiters); AWS Architecture Blog, Exponential Backoff And Jitter (https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Every serious API limits how fast and how much you may call it. Limits come as **rates** (requests per second or minute), **quotas** (per day or month), **concurrency caps**, and **cost budgets** where expensive queries spend more points. Servers signal them with `429 Too Many Requests` (RFC 6585), sometimes `503` or `403`, and with headers: the standard `Retry-After`, the de facto `X-RateLimit-Limit/Remaining/Reset` family, and the IETF draft `RateLimit-Policy` and `RateLimit` fields. A good client reads the documented limits, runs its own limiter below them, tracks the headers on every response, slows down before the budget hits zero, honors `Retry-After` exactly, backs off exponentially with jitter when there is no hint, and above all makes fewer calls: bigger pages, field selection, conditional requests, bulk downloads and webhooks. Working around limits with extra keys, accounts or IPs usually violates the provider's terms; ask for a higher limit instead.

## How servers limit

| Mechanism | Behavior you will see | Client implication |
|---|---|---|
| Fixed window (N per minute, reset on the minute) | bursts allowed right after reset | pace evenly; do not fire everything at the boundary |
| Sliding window | smooth limit over the trailing period | steady pacing works best |
| Token bucket | short bursts up to the bucket size, then the refill rate | small bursts fine, sustained rate must stay below refill |
| Leaky bucket or GCRA | requests spaced at a fixed interval | strict pacing |
| Concurrency limit | errors when too many requests are in flight | cap in-flight requests, not just rate |
| Cost or points | heavy queries consume more budget (for example GitHub GraphQL points) | measure cost per query; simplify queries |
| Quotas | daily or monthly totals | plan the job against the quota, keep a reserve |
| Secondary or abuse limits | undocumented thresholds on bursts, CPU time or content creation | slow, serial requests; wait at least a minute on violation |

Limits are keyed by API key, user, app, IP address, or several at once. Stripe's engineering post describes the common production combination: a token-bucket request limiter, a concurrent-request limiter, and load shedders that drop low-priority traffic when the fleet is under stress, which is why you can be limited even below the documented rate.

## How limits are signalled

**Status codes.** RFC 6585 defines 429 for "too many requests in a given amount of time"; the response SHOULD explain the condition, MAY include `Retry-After`, and MUST NOT be cached. `503 Service Unavailable` with `Retry-After` signals overload. GitHub returns 403 or 429 for rate-limit errors with `x-ratelimit-remaining: 0`. GraphQL servers often return 200 with an error object (see [GraphQL Endpoints](graphql.md)).

**Headers.**

| Header | Meaning |
|---|---|
| `Retry-After: 120` or `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` | wait this long (seconds or HTTP-date), RFC 9110 |
| `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` | de facto; `Reset` may be epoch seconds (GitHub) or seconds remaining, depending on the API |
| `x-ratelimit-used`, `x-ratelimit-resource` | GitHub: requests used in this window and which limit bucket (`core`, `search`, `graphql` and others) |
| `RateLimit-Policy: "hour";q=1000;w=3600, "day";q=5000;w=86400` | IETF draft: quota `q` per window `w` seconds, per named policy (optional `qu` quota unit, `pk` partition key) |
| `RateLimit: "day";r=100;t=36000` | IETF draft: remaining `r` in the named policy, `t` seconds until reset |
| `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` | earlier versions of the IETF draft, still common in API gateways |

The IETF draft is a working-group Internet-Draft (check the datatracker for its current status). It warns that a client MUST NOT assume future responses will carry the same fields, or any at all: treat headers as hints and keep your own limiter.

**GitHub as a worked example.** Unauthenticated REST requests get 60 per hour per IP; authenticated users 5,000 per hour (higher for some GitHub App and Enterprise Cloud cases); `GITHUB_TOKEN` in Actions 1,000 per hour per repository. Search has its own limit (30 per minute authenticated, 10 for unauthenticated requests and for code search). Secondary limits cap concurrency at 100 requests, REST endpoints at 900 points per minute, and CPU time at 90 seconds per 60 seconds of real time. `GET /rate_limit` does not count against the primary limit, and a 304 from a conditional request with valid authorization does not count either. GraphQL is budgeted in points: 5,000 per hour for users.

## Client strategy

1. **Read the docs and set a client-side limiter below the published rate** (a token bucket, see [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)). Share it across all workers that use the same key.
2. **Parse rate headers on every response** and keep the latest budget per key.
3. **Pace when low**: once remaining drops below a reserve (say 10%), spread the rest over the time until reset instead of spending it and stalling.
4. **On 429 or 503**: wait exactly `Retry-After` if present, else until the reset time, else exponential backoff with full jitter (random wait between zero and a growing cap), capped attempts.
5. **Retry only safe requests automatically.** GET is fine; POST without an idempotency key is not (see [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)).
6. **Spend fewer calls**: maximum page sizes, field selection, batch endpoints, conditional requests, caching, bulk dumps instead of item-by-item calls, webhooks instead of polling ([Consuming REST APIs Well](rest-api-consumption.md), [Webhooks and Push-Based Acquisition](webhooks-and-push.md)).

**Budget the job before running it.** Two million records at 100 per page is 20,000 requests; at 5,000 per hour that is four hours of a whole key's budget. Keep a reserve for retries and for other jobs sharing the key, schedule long jobs when interactive users are idle, and checkpoint progress so a quota stop resumes cleanly.

## Code: header parsing and a budget-aware client

Python 3.11 with `httpx`. Tested against the IETF draft examples (multiple named policies, partition keys), the older draft fields, GitHub-style epoch resets and both `Retry-After` forms, and against a mocked API that returned a 429 mid-run.

```python
import asyncio
import random
import re
import time
from dataclasses import dataclass
from email.utils import parsedate_to_datetime

import httpx


def retry_after_seconds(value: str | None) -> float | None:
    """Retry-After: delay-seconds or HTTP-date (RFC 9110, section 10.2.3)."""
    if not value:
        return None
    if value.strip().isdigit():
        return float(value)
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


def _int(value: str | None) -> int | None:
    return int(value) if value and value.strip().isdigit() else None


@dataclass
class Budget:
    limit: int | None = None
    remaining: int | None = None
    reset_in: float | None = None        # seconds until the window resets
    retry_after: float | None = None


def _policy_items(value: str) -> dict[str, dict[str, int]]:
    """'"hour";q=1000;w=3600, "day";q=5000' -> {"hour": {"q": 1000, "w": 3600}, "day": {...}}"""
    out = {}
    for item in filter(str.strip, value.split(",")):
        name = item.split(";", 1)[0].strip().strip('"')
        out[name] = {k: int(v) for k, v in re.findall(r";\s*(\w+)=(\d+)", item)}
    return out


def parse_rate_headers(h: httpx.Headers) -> Budget:
    """Normalize the IETF draft fields, the older draft fields and de facto X-RateLimit-*."""
    b = Budget(retry_after=retry_after_seconds(h.get("retry-after")))
    # Current IETF draft: RateLimit-Policy: "day";q=5000;w=86400   RateLimit: "day";r=100;t=36000
    policies = _policy_items(h.get("ratelimit-policy", ""))
    current = {n: p for n, p in _policy_items(h.get("ratelimit", "")).items() if "r" in p}
    if current:                                   # several policies: the tightest one wins
        name, p = min(current.items(), key=lambda kv: kv[1]["r"])
        b.remaining, b.reset_in = p["r"], float(p["t"]) if "t" in p else None
        b.limit = policies.get(name, {}).get("q")
    # Older drafts and many gateways: RateLimit-Limit / -Remaining / -Reset (delta seconds)
    b.limit = b.limit if b.limit is not None else _int(h.get("ratelimit-limit"))
    if b.remaining is None:
        b.remaining = _int(h.get("ratelimit-remaining"))
        reset = _int(h.get("ratelimit-reset"))
        b.reset_in = float(reset) if reset is not None else b.reset_in
    # De facto: X-RateLimit-* (GitHub sends reset as UTC epoch seconds)
    b.limit = b.limit if b.limit is not None else _int(h.get("x-ratelimit-limit"))
    if b.remaining is None:
        b.remaining = _int(h.get("x-ratelimit-remaining"))
    reset = _int(h.get("x-ratelimit-reset"))
    if b.reset_in is None and reset is not None:
        b.reset_in = max(0.0, reset - time.time()) if reset > 1_000_000_000 else float(reset)
    return b


class BudgetedClient:
    """Retries 429/503 (and 403 with an exhausted budget) using Retry-After or the reset time,
    and slows down when the remaining budget gets low instead of running it to zero."""

    def __init__(self, client: httpx.AsyncClient, reserve: float = 0.1, max_retries: int = 5):
        self.client, self.reserve, self.max_retries = client, reserve, max_retries
        self.budget = Budget()
        self.lock = asyncio.Lock()

    async def _pace(self) -> None:
        b = self.budget
        if b.remaining is None or b.reset_in is None or b.limit is None:
            return
        if b.remaining <= self.reserve * b.limit:            # low: spread what is left
            await asyncio.sleep(b.reset_in / max(b.remaining, 1))

    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        for attempt in range(self.max_retries + 1):
            async with self.lock:                            # serialize pacing decisions
                await self._pace()
            r = await self.client.request(method, url, **kwargs)
            self.budget = parse_rate_headers(r.headers)
            exhausted = r.status_code == 403 and self.budget.remaining == 0
            if r.status_code not in (429, 503) and not exhausted:
                return r
            if attempt == self.max_retries:
                break
            wait = self.budget.retry_after or self.budget.reset_in
            if wait is None:                                 # no hint: exponential backoff, full jitter
                wait = random.uniform(0, min(300, 2 ** attempt * 5))
            await asyncio.sleep(wait + random.uniform(0, 1))
        return r
```

Use one `BudgetedClient` per API key and share it between tasks. For several processes, keep the budget and limiter in Redis instead of memory (see [Distributed Crawling](../crawling/distributed-crawling.md)).

## Pitfalls

- Treating `X-RateLimit-Reset` as seconds when it is an epoch timestamp, or the reverse; check the docs per API.
- Retrying 429s immediately or in lockstep from many workers; always add jitter.
- Per-process limiters on a shared key, multiplying the real rate by the number of workers.
- Ignoring secondary limits: staying under the hourly quota while bursting 100 parallel requests.
- Burning quota on pages you could fetch conditionally or in bulk.
- Rotating keys, accounts or IPs to exceed a limit; besides breaking terms, it gets all of them banned.
- Assuming headers will always be present; fall back to your own limiter when they disappear.

## Checklist

- [ ] Documented limits recorded per API (rate, quota, concurrency, cost) with the source link.
- [ ] Client-side limiter below the limit, shared by every worker on the same key.
- [ ] `Retry-After`, `RateLimit`, `RateLimit-Policy` and `X-RateLimit-*` parsed on every response.
- [ ] Pacing when the remaining budget is low; capped retries with exponential backoff and jitter.
- [ ] Job budgeted in requests before it starts; progress checkpointed.
- [ ] Request count reduced with page size, field selection, conditional requests, bulk data or webhooks.

## See Also

- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [Consuming REST APIs Well](rest-api-consumption.md)
- [GraphQL Endpoints](graphql.md)
- [Catalog of Useful Open APIs](official-apis-catalog.md)
- [HTTP Status Codes and How to React](../http/http-status-codes.md)
