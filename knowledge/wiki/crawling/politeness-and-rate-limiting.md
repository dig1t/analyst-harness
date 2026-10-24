---
tags: [scraping, crawling, politeness, rate-limiting, token-bucket]
aliases: [crawl politeness, throttling, per-host rate limit, token bucket, crawl delay, AutoThrottle, AIMD]
---

# Politeness and Rate Limiting

> Sources: Manning, Raghavan and Schütze, Introduction to Information Retrieval, chapter 20, Web crawling and indexes (https://nlp.stanford.edu/IR-book/); Heydon and Najork, Mercator: A scalable, extensible Web crawler, 1999 (https://doi.org/10.1023/A:1019213109274); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); RFC 6585, section 4, 429 Too Many Requests (https://www.rfc-editor.org/rfc/rfc6585#section-4); RFC 9110, section 10.2.3, Retry-After (https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3); Scrapy documentation, AutoThrottle extension (https://docs.scrapy.org/en/latest/topics/autothrottle.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Politeness means your crawler never degrades a site for its human users. In practice that is a small set of controls applied **per host**: a cap on concurrent connections (usually 1 or 2), a request rate or minimum interval (often one request every one to several seconds for sites you do not know), automatic slow-down when the server signals stress (429, 503, rising latency, errors), strict honoring of `Retry-After`, robots.txt and `Crawl-delay`, and avoiding unnecessary requests altogether through caching and conditional GETs. A token bucket per host is the standard mechanism for the rate part. None of the numbers below are standards; they are conservative defaults to start from and tighten when a site asks.

## What counts as "a host"

Rate limits protect servers, so key them by what shares a server:

- **Hostname** is the default (Mercator kept one queue per host).
- **Registrable domain** (eTLD+1, computed with the Public Suffix List, for example via the `tldextract` package) is safer when a site fans out over `img1.`, `img2.`, `api.` subdomains served by the same backend.
- **IP address** catches unrelated hostnames on one shared server. Large CDNs put thousands of sites behind the same IPs, so use IP keys as an additional cap, not the only one.

With HTTP/2 a single connection can carry many concurrent streams, so cap **in-flight requests** per host, not connections (see [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)).

## Starting budgets

| Situation | Starting point |
|---|---|
| Unknown or small site | 1 in-flight request, one request every 2 to 5 seconds |
| Large site behind a CDN, static pages | 1 to 2 in-flight, about 1 request per second |
| Expensive endpoints (search, filters, reports) | slower than static pages; consider an hour-long budget instead of a rate |
| robots.txt `Crawl-delay: N` | at least N seconds between requests, even though the directive is non-standard |
| Documented API | the published limit, minus headroom (see [API Rate Limits and Quotas](../apis/api-rate-limits.md)) |

Scrapy's global defaults are 8 concurrent requests per domain with no delay, but its `startproject` template ships with `CONCURRENT_REQUESTS_PER_DOMAIN = 1` and `DOWNLOAD_DELAY = 1`, which is the better default for scraping someone else's site.

## Adaptive throttling

Fixed rates are a guess; the server's behavior is the evidence. Two classic heuristics make a crawler slow down automatically when the server slows down:

- **Proportional gap** (Mercator lineage, described in the IR book): wait about ten times as long as the last fetch from that host took before fetching from it again. A page that took 0.3 s implies a 3 s gap.
- **Scrapy AutoThrottle**: target delay = latency / `AUTOTHROTTLE_TARGET_CONCURRENCY`; the next delay is the average of the previous and target delays; non-200 responses are not allowed to shrink the delay; the delay stays between `DOWNLOAD_DELAY` and `AUTOTHROTTLE_MAX_DELAY`.

A general pattern borrowed from TCP congestion control is **AIMD**: additive increase while responses are fast and successful, multiplicative decrease on a stress signal.

| Signal | Reaction |
|---|---|
| 429 or 503, with `Retry-After` | pause the host for that long (seconds or HTTP-date), then halve the rate |
| 429 or 503 without `Retry-After` | pause for a minute or more, halve the rate, back off exponentially on repeats |
| Latency well above the host's baseline | reduce the rate by a quarter |
| 5xx burst, timeouts, connection resets | reduce sharply; stop the host after a threshold |
| 403, CAPTCHA or "unusual traffic" pages | stop and investigate; do not retry faster or from elsewhere (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)) |

## Token buckets

A token bucket refills at `rate` tokens per second up to `capacity`; each request spends one token and waits when the bucket is empty. Capacity 1 gives strict spacing; larger capacities allow short bursts while keeping the long-run average. Compared with `sleep(delay)` between requests, a bucket accounts for request duration and works with concurrency, because all tasks for a host share one bucket.

## Code: a per-host polite client

Python 3.11 with `httpx`. Per-host token bucket, concurrency cap, `Retry-After` parsing (both forms), AIMD adaptation and a `Crawl-delay` ceiling. In a test with a mocked server, a 429 carrying `Retry-After: 2` paused that host for exactly two seconds and halved its rate while a second host kept its pace.

```python
import asyncio
import time
from email.utils import parsedate_to_datetime
from urllib.parse import urlsplit

import httpx


class TokenBucket:
    """Refills `rate` tokens per second up to `capacity`; acquire() waits for a token."""

    def __init__(self, rate: float, capacity: float = 1.0):
        self.rate, self.capacity = rate, capacity
        self.tokens, self.updated = capacity, time.monotonic()
        self.lock = asyncio.Lock()

    async def acquire(self, cost: float = 1.0) -> None:
        async with self.lock:                     # waiters queue up in order
            while True:
                now = time.monotonic()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= cost:
                    self.tokens -= cost
                    return
                await asyncio.sleep((cost - self.tokens) / self.rate)


def retry_after_seconds(value: str | None) -> float | None:
    """Retry-After is either delay-seconds or an HTTP-date (RFC 9110, 10.2.3)."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        return max(0.0, parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return None


class HostState:
    def __init__(self, rate: float, concurrency: int):
        self.bucket = TokenBucket(rate)
        self.slots = asyncio.Semaphore(concurrency)
        self.paused_until = 0.0


class PoliteClient:
    """Per-host token bucket + concurrency cap + AIMD rate adaptation + Retry-After."""

    def __init__(self, client: httpx.AsyncClient, rate: float = 1.0, max_rate: float = 2.0,
                 min_rate: float = 0.05, concurrency: int = 1, slow_latency: float = 2.0):
        self.client, self.hosts = client, {}
        self.rate, self.max_rate, self.min_rate = rate, max_rate, min_rate
        self.concurrency, self.slow_latency = concurrency, slow_latency

    def state(self, url: str) -> HostState:
        host = urlsplit(url).hostname or ""
        if host not in self.hosts:
            self.hosts[host] = HostState(self.rate, self.concurrency)
        return self.hosts[host]

    def set_crawl_delay(self, url: str, seconds: float) -> None:
        st = self.state(url)                       # robots.txt Crawl-delay as a ceiling on rate
        st.bucket.rate = min(st.bucket.rate, 1.0 / seconds)
        self.max_rate = min(self.max_rate, 1.0 / seconds)

    async def get(self, url: str, **kwargs) -> httpx.Response:
        st = self.state(url)
        async with st.slots:
            while True:
                pause = st.paused_until - time.monotonic()
                if pause > 0:
                    await asyncio.sleep(pause)
                await st.bucket.acquire()
                if st.paused_until <= time.monotonic():
                    break                          # no new pause while we waited for a token
            started = time.monotonic()
            response = await self.client.get(url, **kwargs)
            self._adapt(st, response, time.monotonic() - started)
            return response

    def _adapt(self, st: HostState, r: httpx.Response, latency: float) -> None:
        b = st.bucket
        if r.status_code in (429, 503):
            wait = retry_after_seconds(r.headers.get("retry-after")) or 60.0
            st.paused_until = time.monotonic() + wait
            b.rate = max(self.min_rate, b.rate / 2)          # multiplicative decrease
        elif latency > self.slow_latency or r.status_code >= 500:
            b.rate = max(self.min_rate, b.rate * 0.75)       # server is struggling
        else:
            b.rate = min(self.max_rate, b.rate + 0.05)       # additive increase
```

Usage:

```python
# continues the module above
async def crawl(urls: list[str]) -> list[httpx.Response]:
    headers = {"User-Agent": "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)"}
    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        polite = PoliteClient(client, rate=0.5, max_rate=1.0, concurrency=1)
        return await asyncio.gather(*(polite.get(u) for u in urls))
```

`max_rate` is a ceiling, not a target: the client only climbs toward it while the server stays fast and error-free. The `set_crawl_delay` method lowers both the current rate and the ceiling. In a multi-process or multi-machine crawler, per-host state must live in one place, either by routing each host to a single worker or with a shared bucket in Redis (see [Distributed Crawling](distributed-crawling.md)).

## Fewer requests is the best politeness

- Conditional requests (`If-None-Match`, `If-Modified-Since`) turn unchanged pages into cheap 304s ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)).
- Accept compression, reuse connections, cache DNS and robots.txt.
- Use sitemaps, feeds and APIs instead of crawling listing pages ([XML Sitemaps](sitemaps.md)).
- In browsers, block images, fonts and media you do not need ([Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)).
- Schedule heavy crawls for the site's off-peak hours in its own time zone, and add jitter so many jobs do not start on the same minute.

## Pitfalls

- A global rate limit with no per-host limit: one slow host and one fast host get the same budget, and 50 concurrent tasks can all hit the same host.
- Retrying 429s immediately or on a fixed short interval; retries are requests too and count against politeness.
- Treating HTTP/2 as one connection and then running 100 parallel streams against one origin.
- Ignoring `Retry-After` given as an HTTP-date.
- Per-process limits in a fleet of workers, multiplying the real rate by the worker count.
- Rotating IPs or identities to get around a site's limit. That is evasion, not throttling (see [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md)).

## Checklist

- [ ] Per-host (or per registrable domain) concurrency cap and token bucket.
- [ ] Conservative starting rate; climbs only while responses are fast and successful.
- [ ] `Retry-After` honored in both formats; 429 and 503 pause the host and cut the rate.
- [ ] robots.txt rules and `Crawl-delay` applied before scheduling.
- [ ] Limits enforced globally when running several workers.
- [ ] Conditional requests, compression and caching enabled; crawl windows set for off-peak hours.
- [ ] A stop condition for repeated 403s, CAPTCHAs or error bursts, with an alert to a human.

## See Also

- [robots.txt (RFC 9309)](robots-txt.md)
- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
- [Scrapy](../tools/scrapy.md)
