---
tags: [scraping, crawling, architecture, crawler-design]
aliases: [web crawler, spider, crawler design, crawl loop, reference crawler]
---

# Crawler Architecture

> Sources: Heydon and Najork, Mercator: A scalable, extensible Web crawler, World Wide Web 2(4), 1999 (https://doi.org/10.1023/A:1019213109274); Manning, Raghavan and Schütze, Introduction to Information Retrieval, chapter 20 (https://nlp.stanford.edu/IR-book/); Olston and Najork, Web Crawling, Foundations and Trends in IR, 2010 (https://doi.org/10.1561/1500000017); Lee, Leonard, Wang and Loguinov, IRLbot, WWW 2008 (https://doi.org/10.1145/1367497.1367556); Scrapy documentation, Architecture overview (https://docs.scrapy.org/en/latest/topics/architecture.html); IIPC, The WARC Format 1.1 (https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Every crawler, from a 100-line script to a web-scale system, runs the same loop: take a URL from the **frontier**, check **robots.txt** and **politeness**, **fetch** it, **store** the raw response, **parse** it for data and links, **normalize and filter** the links, drop ones already **seen**, and add the rest back to the frontier. The architecture is the set of components around that loop and the state each one owns: the frontier (what to fetch next), per-host state (robots rules, delays), the seen-set, the raw store, and the extracted data. The design described for Mercator in 1999 and in the Information Retrieval textbook still maps one-to-one onto Scrapy, Crawlee, Nutch and Heritrix. Build the small version first, keep fetching and parsing decoupled through stored raw responses, and make politeness a structural property rather than a sleep call.

## The crawl loop

1. **Select** the next URL whose host may be contacted now ([URL Frontier and Scheduling](url-frontier-and-scheduling.md)).
2. **Check** robots.txt for that origin, cached up to 24 hours ([robots.txt (RFC 9309)](robots-txt.md)).
3. **Wait** for the host's politeness gap ([Politeness and Rate Limiting](politeness-and-rate-limiting.md)).
4. **Fetch** with timeouts, a size cap, redirects handled and a descriptive User-Agent.
5. **Store** the raw response with its metadata before doing anything clever with it.
6. **Parse** HTML for links (and, in a scraper, for records).
7. **Normalize, scope-filter and deduplicate** each link ([URL Normalization and Canonicalization](url-normalization.md), [Deduplication](deduplication.md)).
8. **Enqueue** survivors with a priority; schedule revisits for pages you will need again.

## Components

| Component | Owns | Typical implementation |
|---|---|---|
| Seeds and scope | where the crawl may go | allowed hosts, URL patterns, depth and page budgets, content types |
| Frontier | queued URLs, per-host ready times | in-memory heaps; Redis, Kafka or a database at scale |
| DNS cache | host to IP mappings | resolver cache; large crawlers run their own caching resolver |
| robots.txt cache | rules per scheme, host and port | parsed rules with a 24 hour TTL |
| Fetcher | HTTP connections | async HTTP client with connection pooling, HTTP/2 where useful |
| Raw store | response bodies and headers | WARC files or content-addressed objects in S3-compatible storage |
| Parser and link extractor | links and extracted fields | lxml, selectolax, parsel, Cheerio; a browser only when needed |
| URL filter and normalizer | canonical keys, scope decisions | normalization rules, tracking-parameter lists, trap heuristics |
| Seen-set | URLs already queued or fetched | set, Bloom filter, key-value store |
| Content-seen test | duplicate bodies | SHA-256 and SimHash of extracted text |
| Scheduler | revisits, job runs | cron or a workflow engine for recurring crawls |
| Monitoring | health signals | per-host status codes, latency, bytes, queue depth |

```text
 seeds -> [frontier] -> robots check -> politeness gate -> [fetcher] -> raw store (WARC / objects)
             ^                                                |
             |                                                v
      seen-set filter <- normalize + scope <- link extractor <- parser -> records -> validation -> storage
```

## Reference implementation

A complete small crawler in about 120 lines of Python 3.11 (`httpx`, `protego`). It honors robots.txt with RFC 9309 status handling, keeps the crawl inside the seed hosts, removes fragments, respects `<base href>` and `rel="nofollow"`, enforces one request per host with a minimum delay, caps body size, stores every raw body under its SHA-256 and logs one JSON line per fetch. Tested against a local site: it skipped the disallowed path, the external link and the `mailto:` link, resolved links through `<base href>`, and fetched `/` and `/index.html` separately, which produced the same body hash (exactly the case the content-seen test exists for).

```python
"""A small polite crawler: robots.txt, scope, normalization, per-host delay, raw storage."""
import asyncio
import hashlib
import json
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urldefrag, urljoin, urlsplit

import httpx
from protego import Protego

USER_AGENT = "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)"
TOKEN = "ExampleBot"
MAX_BYTES = 5_000_000


class LinkParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links: list[str] = []
        self.base: str | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "base" and a.get("href"):
            self.base = a["href"]
        elif tag == "a" and a.get("href") and "nofollow" not in (a.get("rel") or ""):
            self.links.append(a["href"])


def key(url: str) -> str:
    """Cheap normalization; see the URL normalization article for the full version."""
    url, _ = urldefrag(url)
    p = urlsplit(url)
    return p._replace(scheme=p.scheme.lower(), netloc=p.netloc.lower(), path=p.path or "/").geturl()


class Crawler:
    def __init__(self, seeds: list[str], out: Path, max_pages=100, max_depth=3, delay=1.0):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.seen: set[str] = set()
        self.allowed_hosts = {urlsplit(s).hostname for s in seeds}
        self.robots: dict[str, asyncio.Future] = {}
        self.last_hit: dict[str, float] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.max_pages, self.max_depth, self.delay = max_pages, max_depth, delay
        self.out = out
        (out / "bodies").mkdir(parents=True, exist_ok=True)
        self.log = (out / "fetches.jsonl").open("a")
        self.fetched = 0
        for s in seeds:
            self.enqueue(s, 0)

    def enqueue(self, url: str, depth: int) -> None:
        k = key(url)
        p = urlsplit(k)
        if p.scheme in ("http", "https") and p.hostname in self.allowed_hosts and k not in self.seen:
            self.seen.add(k)
            self.queue.put_nowait((k, depth))

    async def allowed(self, client: httpx.AsyncClient, url: str) -> bool:
        p = urlsplit(url)
        origin = f"{p.scheme}://{p.netloc}"
        if origin not in self.robots:                        # one fetch per origin, shared
            self.robots[origin] = asyncio.ensure_future(self.load_robots(client, origin))
        return (await self.robots[origin]).can_fetch(url, TOKEN)

    async def load_robots(self, client: httpx.AsyncClient, origin: str) -> Protego:
        try:
            r = await client.get(origin + "/robots.txt")
        except httpx.TransportError:
            return Protego.parse("User-agent: *\nDisallow: /")  # unreachable: disallow all
        if r.status_code == 429 or r.status_code >= 500:
            return Protego.parse("User-agent: *\nDisallow: /")
        return Protego.parse(r.text if r.status_code < 400 else "")  # 4xx: no restrictions

    async def polite_wait(self, host: str) -> None:
        lock = self.locks.setdefault(host, asyncio.Lock())
        async with lock:                                     # one request per host at a time
            wait = self.last_hit.get(host, 0) + self.delay - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self.last_hit[host] = time.monotonic()

    async def fetch(self, client: httpx.AsyncClient, url: str, depth: int) -> None:
        if not await self.allowed(client, url):
            return
        await self.polite_wait(urlsplit(url).hostname)
        async with client.stream("GET", url) as r:
            buf = bytearray()
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > MAX_BYTES:
                    break                                    # cap response size
        body = bytes(buf)
        digest = hashlib.sha256(body).hexdigest()
        (self.out / "bodies" / digest).write_bytes(body)     # raw copy for re-parsing later
        ctype = r.headers.get("content-type", "")
        self.log.write(json.dumps({"url": url, "final_url": str(r.url), "status": r.status_code,
                                   "content_type": ctype, "sha256": digest, "depth": depth,
                                   "fetched_at": time.time()}) + "\n")
        self.fetched += 1
        if r.status_code == 200 and "html" in ctype and depth < self.max_depth:
            parser = LinkParser()
            parser.feed(body.decode(r.encoding or "utf-8", errors="replace"))
            base = urljoin(str(r.url), parser.base or "")
            for href in parser.links:
                self.enqueue(urljoin(base, href.strip()), depth + 1)

    async def worker(self, client: httpx.AsyncClient) -> None:
        while True:
            url, depth = await self.queue.get()
            try:
                if self.fetched < self.max_pages:
                    await self.fetch(client, url, depth)
            except httpx.HTTPError as exc:
                self.log.write(json.dumps({"url": url, "error": repr(exc)}) + "\n")
            finally:
                self.queue.task_done()

    async def run(self, concurrency: int = 4) -> None:
        headers = {"User-Agent": USER_AGENT}
        async with httpx.AsyncClient(headers=headers, timeout=20, follow_redirects=True) as client:
            workers = [asyncio.create_task(self.worker(client)) for _ in range(concurrency)]
            await self.queue.join()
            for w in workers:
                w.cancel()
        self.log.close()


if __name__ == "__main__":
    asyncio.run(Crawler(["https://www.example.com/"], Path("crawl-out"), max_pages=50).run())
```

What it deliberately leaves out, and where each piece is covered: robots.txt refresh after 24 hours and full RFC status handling ([robots.txt (RFC 9309)](robots-txt.md)), priorities and a host-ready heap instead of a FIFO queue ([URL Frontier and Scheduling](url-frontier-and-scheduling.md)), adaptive throttling and `Retry-After` ([Politeness and Rate Limiting](politeness-and-rate-limiting.md)), retries with backoff ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)), content-seen and near-duplicate tests ([Deduplication](deduplication.md)), and WARC output ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

## Design decisions that matter

- **Define scope up front.** Seeds, allowed hosts, URL patterns, maximum depth, page budget per host and acceptable content types belong in the job definition (see [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md)). A crawler without scope is a trap waiting to be sprung.
- **Store raw, parse later.** Writing the response before parsing means a parser bug costs a re-parse, not a re-crawl, and gives you evidence for provenance. Web archives use WARC for exactly this.
- **Keep the event loop for IO.** Async fetching scales to thousands of open connections in one process, but HTML parsing is CPU-bound; move heavy parsing to a process pool or a separate stage ([Concurrency and Async IO](../operations/concurrency-and-async.md)).
- **Make politeness structural.** Per-host queues (one in-flight request per host) are more reliable than remembering to sleep.
- **Know where state lives.** Frontier, seen-set, robots cache, host delays and checkpoints must survive restarts for long crawls; decide early whether that is SQLite, Redis or a queue system.
- **Filter before fetching.** Skip obvious binaries by extension, or use `HEAD` when you only want HTML; never fetch what you will discard.
- **Observe per host.** Status-code mix, latency, bytes, robots denials and queue depth per host are the signals for both politeness and breakage ([Monitoring and Alerting](../operations/monitoring-and-alerting.md)).

## Build or adopt

| Option | Fits |
|---|---|
| Your own async loop (as above) | small targeted crawls, unusual scheduling, learning |
| Scrapy (Python) | most site and multi-site crawls; mature scheduler, middlewares, AutoThrottle, persistence via `JOBDIR` ([Scrapy](../tools/scrapy.md)) |
| Crawlee (Node.js and Python) | mixed HTTP and headless-browser crawling with request queues |
| Colly (Go) | fast single-binary crawlers |
| Apache Nutch, StormCrawler | large distributed crawls on Hadoop or Apache Storm |
| Heritrix | archival crawling that writes WARC, used by web archives |
| Hosted platforms | when operations cost more than the subscription ([Scraping Services and Platforms](../tools/scraping-services-and-platforms.md)) |

## Scaling path

One async process handles surprisingly large crawls (hundreds of hosts, millions of pages over days) because politeness, not CPU, is the bottleneck. When it is not enough: split fetching and parsing into separate workers connected by a queue, then shard the frontier by host across machines so each host has one owner ([Distributed Crawling](distributed-crawling.md)). IRLbot's lesson at billions of pages was that the hard parts are not the fetchers but the data structures: the seen-set check, per-host budgets and spam or trap avoidance.

## Pitfalls

- Parsing and extracting in the fetch path, so a parser exception loses the response.
- Unbounded crawls: no depth limit, no per-host cap, no page budget.
- Following every link type (`mailto:`, `javascript:`, binary files) and every host the site links to.
- No response size cap or timeout; one huge or slow response stalls a worker.
- Resolving relative links against the pre-redirect URL or ignoring `<base href>`.
- Keeping all state in memory for a crawl that takes days.

## Checklist

- [ ] Scope, budgets and content types defined in the job, not in code paths.
- [ ] robots.txt cached per origin and checked before every fetch; descriptive User-Agent.
- [ ] Per-host politeness enforced by the frontier structure.
- [ ] Raw responses stored with URL, final URL, status, headers, timestamp and hash.
- [ ] Links normalized, scope-filtered and deduplicated before enqueueing.
- [ ] Timeouts, size caps, retry policy and per-host metrics in place.
- [ ] State persisted if the crawl must survive a restart.

## See Also

- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [Politeness and Rate Limiting](politeness-and-rate-limiting.md)
- [Distributed Crawling](distributed-crawling.md)
- [Anatomy of a Scraper](../fundamentals/anatomy-of-a-scraper.md)
- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
- [Scrapy](../tools/scrapy.md)
