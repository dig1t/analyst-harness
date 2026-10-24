---
tags: [scraping, operations, concurrency, asyncio, nodejs]
aliases: [async scraping, asyncio semaphore, p-limit, worker pool, event loop, backpressure]
---

# Concurrency and Async IO

> Sources: Python docs, asyncio synchronization primitives (https://docs.python.org/3/library/asyncio-sync.html); Python docs, asyncio tasks, TaskGroup and timeouts (https://docs.python.org/3/library/asyncio-task.html); HTTPX, resource limits (https://www.python-httpx.org/advanced/resource-limits/); Node.js, the event loop, timers and process.nextTick (https://nodejs.org/en/learn/asynchronous-work/event-loop-timers-and-nexttick); p-limit (https://github.com/sindresorhus/p-limit); p-queue (https://github.com/sindresorhus/p-queue); undici, garbage collection note (https://github.com/nodejs/undici#garbage-collection); What's New in Python 3.14, free-threaded build (https://docs.python.org/3/whatsnew/3.14.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scraping is mostly waiting: on DNS, TLS handshakes and slow servers. Async IO lets one thread keep many requests in flight, which is where throughput comes from. The same power needs limits: a global cap to bound memory and sockets, a per-host cap and pacing so one site never sees a burst, and bounded queues so producers cannot outrun consumers. CPU-heavy parsing is different work and belongs in processes or worker threads, not in more coroutines.

## Four separate knobs

| Knob | Protects | Typical tool |
|---|---|---|
| Global concurrency | Your memory, file descriptors, proxy bill | `asyncio.Semaphore`, `p-limit`, connection pool size |
| Per-host concurrency | The target site | Per-host semaphore, Scrapy `CONCURRENT_REQUESTS_PER_DOMAIN` |
| Per-host rate | The target site, API quotas | Pacing or token bucket, `p-queue` `interval`, Crawlee `maxRequestsPerMinute` |
| Parallelism | CPU time | Process pool, `worker_threads` |

Little's law ties them together: requests in flight = request rate x latency. To make 2 requests per second against a host that answers in 0.5 s you need about 1 request in flight, so a per-host concurrency of 1 or 2 is usually enough. Big crawls get their speed from many hosts in parallel, not from hammering one (see [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)).

## Python: asyncio with httpx

The pattern below has a bounded queue (backpressure), a fixed set of workers (memory stays flat even for a million URLs), a global semaphore, per-host semaphores, per-host pacing and a deadline per request. It was tested on Python 3.13; `TaskGroup` and `asyncio.timeout()` need 3.11 or newer.

```python
import asyncio
from collections import defaultdict
from urllib.parse import urlsplit

import httpx


class HostLimits:
    """Global cap, per-host cap and per-host pacing. Create it inside the running event loop."""

    def __init__(self, global_limit: int = 20, per_host: int = 2, min_interval: float = 0.5) -> None:
        self.global_sem = asyncio.Semaphore(global_limit)
        self.host_sems: defaultdict[str, asyncio.Semaphore] = defaultdict(lambda: asyncio.Semaphore(per_host))
        self.min_interval = min_interval
        self.next_start: dict[str, float] = {}

    async def pace(self, host: str) -> None:
        now = asyncio.get_running_loop().time()
        start = max(now, self.next_start.get(host, now))
        self.next_start[host] = start + self.min_interval  # reserve the next slot
        await asyncio.sleep(start - now)


async def fetch(client: httpx.AsyncClient, limits: HostLimits, url: str) -> tuple[str, int]:
    host = urlsplit(url).netloc
    async with limits.global_sem, limits.host_sems[host]:
        await limits.pace(host)
        async with asyncio.timeout(30):  # deadline for the whole request
            resp = await client.get(url)
        return url, resp.status_code


async def crawl(urls: list[str], workers: int = 8) -> list[tuple[str, int | str]]:
    limits = HostLimits()
    queue: asyncio.Queue[str] = asyncio.Queue(maxsize=100)  # put() waits when full
    results: list[tuple[str, int | str]] = []

    async def worker(client: httpx.AsyncClient) -> None:
        while True:
            url = await queue.get()
            try:
                results.append(await fetch(client, limits, url))
            except Exception as exc:  # one bad URL must not kill the worker
                results.append((url, type(exc).__name__))
            finally:
                queue.task_done()

    pool = httpx.Limits(max_connections=20, max_keepalive_connections=20)
    async with httpx.AsyncClient(limits=pool, timeout=10.0, follow_redirects=True) as client:
        async with asyncio.TaskGroup() as tg:
            tasks = [tg.create_task(worker(client)) for _ in range(workers)]
            for url in urls:
                await queue.put(url)
            await queue.join()
            for t in tasks:
                t.cancel()
    return results

# results = asyncio.run(crawl(urls))
```

Points worth knowing:

- httpx pools connections per client: by default 100 connections, 20 keep-alive, 5 s keep-alive expiry. Reuse one client for the whole run; creating a client per request throws away connection reuse (see [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)).
- `asyncio.Semaphore`, `Lock` and `Queue` bind to the event loop that first uses them. Module-level semaphores reused across two `asyncio.run()` calls fail with "is bound to a different event loop", which is why `HostLimits` is created inside `crawl()`.
- A `TaskGroup` cancels all its tasks when one raises. Catch per-URL errors inside the worker, as above, unless you want one failure to stop the crawl.
- Anything blocking inside a coroutine (`requests.get`, `time.sleep`, parsing a 20 MB page) freezes every request. Use `await asyncio.to_thread(fn)` for blocking libraries and a process pool for heavy parsing.
- Retries belong inside `fetch`, with backoff (see [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)).

## Node.js: p-limit and p-queue

Node runs JavaScript on one thread with an event loop. `await` yields while sockets are busy, so thousands of requests can be in flight, but a synchronous CPU task (a huge `JSON.parse`, cheerio on a multi-megabyte page) blocks everything until it finishes. `p-limit` caps concurrency; `p-queue` adds rate limiting, priorities and backpressure. Both are ESM-only (current majors: p-limit 7, p-queue 10).

```typescript
import pLimit from "p-limit";
import PQueue from "p-queue";

const globalLimit = pLimit(20); // total in-flight requests for this process
const hostQueues = new Map<string, PQueue>();

function queueFor(url: string): PQueue {
  const host = new URL(url).host;
  let q = hostQueues.get(host);
  if (!q) {
    // per host: 2 at a time and at most 4 starts per second (sliding window)
    q = new PQueue({ concurrency: 2, intervalCap: 4, interval: 1_000, strict: true });
    hostQueues.set(host, q);
  }
  return q;
}

async function fetchText(url: string): Promise<{ url: string; status: number; bytes: number }> {
  const res = await fetch(url, {
    headers: { "user-agent": "acme-research-bot/1.0 (+https://acme.example/bot)" },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text(); // always consume or cancel the body
  return { url, status: res.status, bytes: body.length };
}

const crawl = (url: string) => globalLimit(() => queueFor(url).add(() => fetchText(url)));

const results = await Promise.allSettled(urls.map(crawl));
const failed = results.filter((r) => r.status === "rejected");
```

Notes:

- `Promise.allSettled` keeps going when some URLs fail; `Promise.all` rejects on the first failure and leaves the rest running unobserved.
- Mapping a million URLs at once still creates a million pending promises. For big lists, feed `p-queue` in batches and `await queue.onSizeLessThan(1000)` before adding more.
- Without `strict: true`, `p-queue` uses fixed windows, so up to twice `intervalCap` requests can start around a window boundary.
- undici (behind Node's `fetch`) warns that leaving bodies to the garbage collector can exhaust connections and stall requests. Read or cancel every body, including error responses.
- For CPU-heavy parsing, move work to `worker_threads` (or a pool library) and keep the main thread for IO.

## Threads, processes and browsers

- **Python threads** suit blocking IO libraries: `ThreadPoolExecutor(max_workers=8)` around `requests` works fine. The GIL prevents threads from using several cores for pure-Python CPU work; use `ProcessPoolExecutor` for parsing at scale. The free-threaded build became officially supported (still optional) in Python 3.14, but check that your parser libraries support it before relying on it.
- **Processes** also isolate crashes and memory leaks: a worker that restarts every N jobs keeps long crawls stable (see [Queues and Workers](queues-and-workers.md)).
- **Headless browsers** are limited by memory, not by the event loop. Measure memory per page in your own workload and size concurrency from that, reuse contexts, and block heavy resources (see [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)).

## Adaptive concurrency

Static limits are a starting point. Frameworks can adapt: Scrapy AutoThrottle sets per-slot delays from observed latency (see [Scrapy](../tools/scrapy.md)), and Crawlee's autoscaled pool scales concurrency with available CPU and memory between `minConcurrency` and `maxConcurrency`. Whatever adapts upward must also slow down on 429, 503 and rising latency.

## Pitfalls

- One global limit and no per-host limit: a crawl of 50 sites can still put 50 concurrent requests on the biggest one.
- A task per URL for huge lists, so memory grows with the list instead of with concurrency.
- Blocking calls inside coroutines or the Node event loop.
- Creating a new HTTP client per request (no keep-alive, more TLS handshakes, more load on the target).
- asyncio primitives created at import time and reused across event loops.
- Unhandled promise rejections from `p-queue` tasks; handle every `.add()` promise.
- Raising concurrency to "go faster" when the bottleneck is a rate limit; that only produces more 429s.

## Checklist

- [ ] Global cap, per-host cap and per-host pacing are separate settings
- [ ] Bounded queue or batch feeding for large URL lists
- [ ] One shared client with connection pooling
- [ ] Per-request deadline and retries with backoff
- [ ] Errors isolated per URL; the crawl continues
- [ ] CPU-heavy parsing off the event loop
- [ ] Concurrency backs off on 429, 503 and latency spikes

## See Also

- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)
- [Queues and Workers](queues-and-workers.md)
- [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)
- [Python Scraping Stack](../tools/python-scraping-stack.md)
- [Node.js Scraping Stack](../tools/node-scraping-stack.md)
