---
tags: [scraping, crawling, frontier, scheduling, prioritization]
aliases: [URL frontier, crawl frontier, crawl queue, crawl scheduling, revisit policy, back queues]
---

# URL Frontier and Scheduling

> Sources: Heydon and Najork, Mercator: A scalable, extensible Web crawler, 1999 (https://doi.org/10.1023/A:1019213109274); Manning, Raghavan and Schütze, Introduction to Information Retrieval, chapter 20 (https://nlp.stanford.edu/IR-book/); Cho and Garcia-Molina, Effective page refresh policies for Web crawlers, ACM TODS 2003 (https://doi.org/10.1145/958942.958945); Olston and Najork, Web Crawling, Foundations and Trends in IR, 2010 (https://doi.org/10.1561/1500000017); Lee, Leonard, Wang and Loguinov, IRLbot: Scaling to 6 billion pages and beyond, WWW 2008 (https://doi.org/10.1145/1367497.1367556); crawler-commons URL Frontier (https://github.com/crawler-commons/url-frontier)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

The frontier is the crawler's to-do list, and it makes three decisions: **what to fetch next** (priority), **when a host may be contacted again** (politeness), and **when to come back** to pages already fetched (revisit policy). The classic design, from the Mercator crawler and the Information Retrieval textbook, separates the first two: *front queues* order URLs by priority, *back queues* hold one host each, and a heap keyed by "earliest next fetch time" picks the next host that is allowed to be contacted. That structure guarantees at most one in-flight request per host, spaces requests by a delay derived from robots.txt and the host's response times, and still keeps every fetcher busy as long as enough hosts have work. Add per-host budgets and depth limits so no single site, or trap, can take over the queue.

## Ordering: what to fetch next

| Strategy | When it fits | Notes |
|---|---|---|
| Breadth-first (FIFO by depth) | general discovery | Najork and Wiener (WWW 2001) found breadth-first order reaches high-quality pages early |
| Depth-limited best-first | site scrapes with known targets | prioritize detail pages (products, articles) over listing pages; penalize depth |
| Importance estimates | broad crawls | in-link counts, PageRank-style or OPIC (Abiteboul, Preda and Cobena, WWW 2003) scores; Cho, Garcia-Molina and Page (1998) showed importance ordering finds important pages sooner |
| Freshness need | news, prices, stock levels | pages that change often and matter get revisited first (see below) |
| Focused crawling | topic-specific corpora | a classifier scores pages; links from relevant pages inherit priority |

In Scrapy the default order is depth-first (LIFO); breadth-first needs `DEPTH_PRIORITY = 1` with FIFO memory and disk queues (`scrapy.squeues.FifoMemoryQueue`, `scrapy.squeues.PickleFifoDiskQueue`). See [Scrapy](../tools/scrapy.md).

## The Mercator design: front and back queues

```text
          new URLs (normalized, deduplicated, in scope)
                         |
                 prioritizer (score)
          +--------+--------+--------+
          | F1 hi  | F2     | F3 lo  |   front queues, one per priority level
          +--------+--------+--------+
                         |  biased selection (high priority more often)
                         v
       router: URL goes to the back queue of its host
   +---------+---------+---------+---------+
   | host A  | host B  | host C  |  ...    |   back queues, one host each
   +---------+---------+---------+---------+
                         |
   heap of (earliest allowed fetch time, host)  -->  fetcher threads
```

- A fetcher pops the host with the smallest "allowed at" time, waits until then if needed, takes the next URL from that host's queue and fetches it.
- When the fetch finishes, the host is re-inserted with `allowed_at = now + gap`. The IR book describes a common heuristic of a gap about ten times the duration of the last fetch, so slow (struggling) servers automatically get more breathing room. Use `max(robots Crawl-delay, your minimum delay, 10 x last fetch time)`.
- The textbook suggests keeping roughly three times as many back queues as fetcher threads so that threads rarely sit idle waiting on politeness gaps.
- A host is "checked out" while one of its URLs is in flight, which enforces one connection per host without extra locks.

## Code: a minimal async frontier

Python 3.11, standard library only. It implements per-host priority queues, the ready-time heap, the checked-out invariant, a per-host URL cap and wake-up on new work. In a test with four workers and four hosts, each host's requests were spaced by the configured delay while different hosts were fetched in parallel, and a priority-0 URL was fetched before older priority-1 URLs on the same host.

```python
import asyncio
import heapq
import itertools
import time
from collections import defaultdict
from urllib.parse import urlsplit


class Frontier:
    """Per-host priority queues plus a heap of hosts keyed by earliest next fetch time.

    A host is checked out while one of its URLs is being fetched, so there is never more
    than one in-flight request per host (Mercator's back-queue invariant).
    """

    def __init__(self, min_delay: float = 2.0, gap_factor: float = 10.0, max_per_host: int = 10_000):
        self.queues: dict[str, list] = defaultdict(list)   # host -> heap of (priority, seq, url)
        self.ready: list[tuple[float, str]] = []           # heap of (not_before, host)
        self.not_before: dict[str, float] = {}
        self.scheduled: set[str] = set()                   # hosts present in self.ready
        self.checked_out: set[str] = set()                 # hosts with a fetch in flight
        self.delay: dict[str, float] = defaultdict(lambda: min_delay)  # e.g. from Crawl-delay
        self.gap_factor, self.max_per_host = gap_factor, max_per_host
        self.seq = itertools.count()
        self.changed = asyncio.Event()

    def add(self, url: str, priority: float = 1.0) -> bool:
        """Lower priority value = fetched sooner. Returns False if the host queue is full."""
        host = urlsplit(url).hostname or ""
        if len(self.queues[host]) >= self.max_per_host:
            return False                                   # budget: one host cannot flood memory
        heapq.heappush(self.queues[host], (priority, next(self.seq), url))
        self._schedule(host)
        return True

    def _schedule(self, host: str) -> None:
        if host not in self.scheduled and host not in self.checked_out and self.queues[host]:
            heapq.heappush(self.ready, (self.not_before.get(host, 0.0), host))
            self.scheduled.add(host)
            self.changed.set()

    async def get(self) -> tuple[str, str]:
        """Wait until some host may be fetched again; return (host, url)."""
        while True:
            if self.ready:
                not_before, host = self.ready[0]
                wait = not_before - time.monotonic()
                if wait <= 0:
                    heapq.heappop(self.ready)
                    self.scheduled.discard(host)
                    _, _, url = heapq.heappop(self.queues[host])
                    self.checked_out.add(host)
                    return host, url
            else:
                wait = None
            self.changed.clear()
            try:                                           # sleep until due or until new work
                await asyncio.wait_for(self.changed.wait(), timeout=wait)
            except TimeoutError:
                pass

    def done(self, host: str, fetch_seconds: float) -> None:
        """Release the host; next fetch waits max(delay, gap_factor * last fetch time)."""
        gap = max(self.delay[host], self.gap_factor * fetch_seconds)
        self.not_before[host] = time.monotonic() + gap
        self.checked_out.discard(host)
        self._schedule(host)

    def pending(self) -> int:
        return sum(len(q) for q in self.queues.values()) + len(self.checked_out)
```

A worker loop around it (the fetch function is yours: robots check, HTTP GET, storage, link extraction):

```python
async def worker(frontier: Frontier, fetch) -> None:
    while True:
        host, url = await frontier.get()
        started = time.monotonic()
        try:
            for link, priority in await fetch(url):     # returns newly discovered links
                frontier.add(link, priority)
        finally:
            frontier.done(host, time.monotonic() - started)
```

Run several workers with `asyncio.create_task` and stop when `frontier.pending()` reaches zero. Set `frontier.delay[host]` from robots.txt `Crawl-delay` when you parse it.

## Revisit policy: when to come back

For recurring crawls the frontier also schedules re-fetches. Cho and Garcia-Molina measured freshness (is my copy current?) and age (how stale is it?) and showed a counter-intuitive result: revisiting every page at the same rate (**uniform**) beats revisiting each page in proportion to how often it changes (**proportional**) for average freshness, and the optimal policy even visits the most volatile pages *less*, because they go stale again almost immediately. Practical consequences:

- Estimate each page's change rate from past fetches (see [Incremental Crawling](incremental-crawling.md)) and allocate revisits where they buy the most freshness per request.
- Weight by importance: a price page that changes daily and matters gets a daily slot; a footer page that changes daily and does not matter gets none.
- Put revisits and new discoveries in the same frontier with separate priority bands, so neither starves the other.

## Budgets and scope

- **Per-host caps** on queued URLs and on pages per crawl. IRLbot (WWW 2008) tied each domain's budget to its reputation, measured by links from other domains, to stop spam farms and infinite sites from absorbing the crawl.
- **Depth limits** and path-pattern rules defined by the job, not discovered at runtime.
- **Scope filters before enqueueing**: allowed hosts, URL patterns, robots.txt, file types. It is much cheaper to never enqueue a URL than to dequeue and discard it.
- **Trap signals** feed back into priority: hosts producing many near-duplicate pages get demoted (see [Spider Traps and Crawl Hygiene](spider-traps.md)).

## Persistence and scale

An in-memory frontier like the one above handles a few million URLs. Beyond that, or when the crawl must survive restarts, keep the queues on disk or in a shared store: SQLite or RocksDB per process, Redis sorted sets keyed by next-fetch time, or Kafka topics partitioned by host. Scrapy persists its scheduler with the `JOBDIR` setting. The crawler-commons **URL Frontier** project defines a gRPC API (with a reference implementation) for running the frontier as a separate service shared by many fetchers. Partitioning by host is what keeps politeness local to one owner (see [Distributed Crawling](distributed-crawling.md)).

## Pitfalls

- One global FIFO queue: fetchers block on politeness for the same host while other hosts sit idle, or politeness is skipped to "keep busy".
- Allowing two in-flight requests to a host because two workers popped its URLs from a shared queue.
- No per-host cap, so a calendar or faceted-search trap fills the frontier.
- Priority that ignores depth: link-rich listing pages crowd out the detail pages you actually need.
- Recrawling volatile, unimportant pages constantly while important pages go stale.
- Losing the frontier on restart and recrawling everything.

## Checklist

- [ ] Per-host queues with a ready-time heap; at most one (or a small fixed number) in-flight request per host.
- [ ] Gap = max(minimum delay, Crawl-delay, multiple of last fetch time).
- [ ] Priority combines page type, depth and importance; revisits in their own band.
- [ ] Per-host caps, depth limits and scope filters applied at enqueue time.
- [ ] Frontier persisted (JOBDIR, database, Redis, Kafka) for long crawls.
- [ ] Metrics: queue size per host, oldest queued URL, fetches per host per minute.

## See Also

- [Crawler Architecture](crawler-architecture.md)
- [Politeness and Rate Limiting](politeness-and-rate-limiting.md)
- [Incremental Crawling](incremental-crawling.md)
- [Distributed Crawling](distributed-crawling.md)
- [Spider Traps and Crawl Hygiene](spider-traps.md)
- [Queues and Workers](../operations/queues-and-workers.md)
