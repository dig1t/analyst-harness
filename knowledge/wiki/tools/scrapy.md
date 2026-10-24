---
tags: [scraping, tools, python, scrapy, crawling]
aliases: [Scrapy framework, Scrapy spider, AutoThrottle, Scrapy pipelines, Scrapy middlewares]
---

# Scrapy

> Sources: Scrapy documentation (https://docs.scrapy.org/en/latest/); AutoThrottle extension (https://docs.scrapy.org/en/latest/topics/autothrottle.html); Settings reference (https://docs.scrapy.org/en/latest/topics/settings.html); Spiders (https://docs.scrapy.org/en/latest/topics/spiders.html); Item Pipeline (https://docs.scrapy.org/en/latest/topics/item-pipeline.html); Downloader Middleware (https://docs.scrapy.org/en/latest/topics/downloader-middleware.html); Feed exports (https://docs.scrapy.org/en/latest/topics/feed-exports.html); Jobs: pausing and resuming crawls (https://docs.scrapy.org/en/latest/topics/jobs.html); Common Practices, run from a script (https://docs.scrapy.org/en/latest/topics/practices.html); Release notes (https://docs.scrapy.org/en/latest/news.html); scrapy-playwright (https://github.com/scrapy-plugins/scrapy-playwright)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scrapy is the mature Python framework for crawling: a scheduler with deduplication, a downloader with per-domain slots, retries, robots.txt support, HTTP caching, adaptive throttling (AutoThrottle), item pipelines for cleaning and storage, feed exports, pause and resume, and a large plugin ecosystem. It is the right tool when a job means many pages across a site, politeness rules, and a repeatable pipeline; it is overkill for one API call. This article reflects Scrapy 2.19 (released 2026-09-10), and several recent changes break older tutorials: spiders now use `async def start()`, `start_requests()` was removed in 2.16, and component methods no longer receive a `spider` argument.

## How it fits together

```text
start() -> Scheduler (dedup, priorities, JOBDIR) -> Downloader (slots per domain: concurrency, delay)
             ^                                         |  downloader middlewares (robots, retry, cache, cookies)
             |                                         v
        new Requests <------------- Spider callbacks (parse) ------> Items -> Item pipelines -> Feeds / DB
                                     spider middlewares                         (validate, dedupe, store)
```

Everything is configured through settings, and the engine emits signals and collects stats (`item_scraped_count`, `downloader/response_status_count/403`, `finish_reason`) that feed monitoring.

## A polite spider

Single file, runnable with `scrapy runspider books_spider.py -O books.jsonl`. Tested with Scrapy 2.19 against a copy of the books.toscrape.com sandbox:

```python
import re

import scrapy
from itemadapter import ItemAdapter
from scrapy.exceptions import DropItem


class RequiredFieldsPipeline:
    required = ("url", "title", "price")

    def process_item(self, item):  # Scrapy 2.14+ signature, no spider argument
        adapter = ItemAdapter(item)
        missing = [name for name in self.required if not adapter.get(name)]
        if missing:
            raise DropItem(f"missing {missing} in {adapter.get('url')}")
        return item


class BooksSpider(scrapy.Spider):
    name = "books"
    allowed_domains = ["books.toscrape.com"]
    start_urls = ["https://books.toscrape.com/catalogue/page-1.html"]

    custom_settings = {
        "USER_AGENT": "acme-research-bot/1.0 (+https://acme.example/bot; bot@acme.example)",
        "ROBOTSTXT_OBEY": True,
        "CONCURRENT_REQUESTS_PER_DOMAIN": 2,
        "DOWNLOAD_DELAY": 1.0,                 # floor for AutoThrottle
        "AUTOTHROTTLE_ENABLED": True,
        "AUTOTHROTTLE_START_DELAY": 2.0,
        "AUTOTHROTTLE_MAX_DELAY": 30.0,
        "AUTOTHROTTLE_TARGET_CONCURRENCY": 1.0,
        "AUTOTHROTTLE_DEBUG": False,           # True logs every delay adjustment
        "RETRY_TIMES": 3,
        "DOWNLOAD_TIMEOUT": 30,
        "HTTPCACHE_ENABLED": True,             # development only: replay pages from disk
        "CLOSESPIDER_ERRORCOUNT": 20,          # stop instead of hammering a broken site
        "ITEM_PIPELINES": {RequiredFieldsPipeline: 300},
        "FEED_EXPORT_ENCODING": "utf-8",
    }

    async def start(self):  # replaces start_requests(), which Scrapy 2.16 removed
        for url in self.start_urls:
            yield scrapy.Request(url, callback=self.parse)

    def parse(self, response):
        for href in response.css("article.product_pod h3 a::attr(href)").getall():
            yield response.follow(href, callback=self.parse_book)
        next_page = response.css("li.next a::attr(href)").get()
        if next_page:
            yield response.follow(next_page, callback=self.parse)

    def parse_book(self, response):
        price_text = response.css("div.product_main p.price_color::text").get(default="")
        match = re.search(r"\d+(?:\.\d+)?", price_text)
        yield {
            "url": response.url,
            "title": response.css("div.product_main h1::text").get(default="").strip(),
            "price": float(match.group()) if match else None,
            "upc": response.xpath("//th[text()='UPC']/following-sibling::td/text()").get(),
        }
```

Defining `start_urls` alone is enough when no custom start logic is needed; the default `start()` iterates it.

## Settings that matter

"Template" is the value written by `scrapy startproject`; "fallback" is the built-in default used without a project.

| Setting | Default | Recommendation |
|---|---|---|
| `USER_AGENT` | `Scrapy/VERSION (+https://scrapy.org)` | Your bot name and a contact URL (see [Identifying Your Bot](../anti-bot/identifying-your-bot.md)) |
| `ROBOTSTXT_OBEY` | `True` in template, `False` fallback | Keep `True`; the parser is Protego |
| `CONCURRENT_REQUESTS` | 16 | Global cap |
| `CONCURRENT_REQUESTS_PER_DOMAIN` | 1 in template, 8 fallback | 1 or 2 for most sites |
| `DOWNLOAD_DELAY` | 1 in template, 0 fallback | Minimum delay per slot; AutoThrottle never goes below it |
| `DOWNLOAD_DELAY_JITTER` | 0.5 (new in 2.19) | Randomizes delays by plus or minus 50 percent; replaces the deprecated `RANDOMIZE_DOWNLOAD_DELAY` |
| `AUTOTHROTTLE_ENABLED` | `False` | `True` for crawls of any size |
| `RETRY_TIMES` / `RETRY_HTTP_CODES` | 2 / 500, 502, 503, 504, 522, 524, 408, 429 | Keep 403 out of retries |
| `DOWNLOAD_TIMEOUT` | 180 s | 30 to 60 s |
| `DOWNLOAD_MAXSIZE` / `DOWNLOAD_WARNSIZE` | 1 GiB / 32 MiB | Lower the maximum to what you expect |
| `HTTPCACHE_ENABLED` | `False` | `True` while developing selectors |
| `CLOSESPIDER_ITEMCOUNT`, `_PAGECOUNT`, `_TIMEOUT`, `_ERRORCOUNT` | 0 (off) | Bound every scheduled run |
| `JOBDIR` | None | Set for long crawls to pause and resume |
| `DOWNLOAD_SLOTS` | `{}` | Per-domain `concurrency`, `delay`, `jitter` |
| `REMOTE_CONTROL_ENABLED` | `True` (new in 2.19) | Localhost HTTP control with a bearer token; disable on shared hosts if unused |
| `TWISTED_REACTOR` | asyncio reactor | Default since 2.13; a reactor-less mode is experimental |

Per-domain overrides:

```python
DOWNLOAD_SLOTS = {
    "api.example.com": {"concurrency": 1, "delay": 2.0, "jitter": 0.2},
}
```

## AutoThrottle

From the docs, the algorithm is: start at `AUTOTHROTTLE_START_DELAY`; on each response, compute a target delay of `latency / AUTOTHROTTLE_TARGET_CONCURRENCY`; set the next delay to the average of the previous delay and the target; never let non-200 responses decrease the delay; and keep the delay between `DOWNLOAD_DELAY` and `AUTOTHROTTLE_MAX_DELAY`. Latency is measured from sending the request to receiving the headers. The effect is that a slow or struggling server automatically gets fewer requests, and errors slow you down rather than speeding you up, which a fixed small delay plus a high concurrency cap does not do. `CONCURRENT_REQUESTS_PER_DOMAIN` still caps everything, and a target concurrency above it is never reached. See [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md).

## Items, pipelines and feeds

- **Items** can be dicts, dataclasses, attrs classes or `scrapy.Item`; `itemadapter` gives one API over all of them.
- **Pipelines** run in priority order and implement `process_item(self, item)`, plus optional `open_spider(self)` and `close_spider(self)` (each may be `async def`). Raise `DropItem` to discard. Use them for validation, normalization, deduplication and database writes; get settings and stats through `from_crawler(cls, crawler)`.
- **Feeds**: `-O file.jsonl` overwrites, `-o` appends; or configure `FEEDS = {"items.jsonl": {"format": "jsonlines", "overwrite": True}}`, including remote storage URIs and gzip post-processing.

## Middlewares

Downloader middlewares sit between the engine and the network (`process_request(request)`, `process_response(request, response)`, `process_exception(request, exception)` in 2.19). Robots, retries, redirects, cookies, compression and the HTTP cache are all built-in middlewares. A small custom one that records status classes in the stats:

```python
class StatusClassStatsMiddleware:
    def __init__(self, crawler):
        self.stats = crawler.stats

    @classmethod
    def from_crawler(cls, crawler):
        return cls(crawler)

    def process_response(self, request, response):
        self.stats.inc_value(f"custom/status_class/{response.status // 100}xx")
        return response

# settings: DOWNLOADER_MIDDLEWARES = {"myproject.middlewares.StatusClassStatsMiddleware": 950}
```

Stopping politely when blocked belongs in the spider: list `handle_httpstatus_list = [403, 429]` so those responses reach the callback, count them, and `raise CloseSpider("blocked: stop and investigate")` past a threshold (requests already in flight still complete). Then follow [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md).

## Running and debugging

| Command or API | Use |
|---|---|
| `scrapy shell URL` | Try selectors interactively on a live or cached response |
| `scrapy parse URL --spider books -c parse_book` | Run one callback on one URL |
| `scrapy check` | Run spider contracts (`@url`, `@returns`, `@scrapes` in docstrings) |
| `scrapy crawl books -O out.jsonl -s JOBDIR=crawls/books-1` | Resumable crawl; stop with one Ctrl-C and rerun the same command |
| `AsyncCrawlerProcess(settings={...}).crawl(Spider)` then `.start()` | Run from a script |
| Scrapyd, Zyte Scrapy Cloud | Deploy and schedule spiders as a service |

## JavaScript pages

Scrapy downloads HTML; it does not run JavaScript. First look for the JSON endpoint the page uses (see [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)) or embedded state (see [JSON and Embedded Data](../parsing/json-and-embedded-data.md)). When rendering is unavoidable, the scrapy-playwright download handler renders selected requests (marked with `meta={"playwright": True}`) in Playwright while keeping Scrapy's scheduler, throttling and pipelines.

## Pitfalls

- Tutorials with `def start_requests(self)`: since 2.16 it is no longer called. Use `async def start(self)` (define both only if you must support old versions).
- Pipelines and middlewares written as `process_item(self, item, spider)`: the `spider` argument is deprecated; reach the spider or settings through the crawler.
- Running without a project and assuming the template defaults: outside a project `ROBOTSTXT_OBEY` falls back to `False` and per-domain concurrency to 8.
- AutoThrottle enabled with a high `CONCURRENT_REQUESTS_PER_DOMAIN` and zero `DOWNLOAD_DELAY`, which allows bursts while it converges.
- Leaving `HTTPCACHE_ENABLED` on in production and serving stale pages.
- Huge crawls without `JOBDIR`, so a crash restarts from zero.
- Adding 403 to `RETRY_HTTP_CODES`.

## Checklist

- [ ] Project created with `startproject` (polite template defaults) or the same values set explicitly
- [ ] Honest `USER_AGENT`, `ROBOTSTXT_OBEY = True`
- [ ] AutoThrottle on, per-domain concurrency 1 or 2, `DOWNLOAD_DELAY` floor
- [ ] `CLOSESPIDER_*` bounds and an error threshold for scheduled runs
- [ ] Validation pipeline before storage; feeds or upserts idempotent
- [ ] `async def start()` and 2.14+ component signatures
- [ ] Contracts or fixture tests for every callback

## See Also

- [Python Scraping Stack](python-scraping-stack.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [robots.txt (RFC 9309)](../crawling/robots-txt.md)
- [Crawler Architecture](../crawling/crawler-architecture.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
- [Playwright](../browser-automation/playwright.md)
