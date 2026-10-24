---
tags: [scraping, operations, cost, caching, budgets]
aliases: [scraping costs, cost optimization, bandwidth costs, proxy costs, LLM token costs, run budget]
---

# Cost Control

> Sources: RFC 9110 HTTP Semantics, section 13 conditional requests (https://www.rfc-editor.org/rfc/rfc9110#section-13); RFC 9111 HTTP Caching (https://www.rfc-editor.org/rfc/rfc9111); Scrapy docs, HttpCacheMiddleware (https://docs.scrapy.org/en/latest/topics/downloader-middleware.html#module-scrapy.downloadermiddlewares.httpcache); Playwright, Network (https://playwright.dev/docs/network); Anthropic docs, Prompt caching (https://platform.claude.com/docs/en/build-with-claude/prompt-caching); Anthropic docs, Batch processing (https://platform.claude.com/docs/en/build-with-claude/batch-processing); Fly.io pricing (https://fly.io/docs/about/pricing/); Railway plans (https://docs.railway.com/pricing/plans); Google Cloud, Cloud Run pricing (https://cloud.google.com/run/pricing); Cloudflare Browser Run pricing (https://developers.cloudflare.com/browser-run/pricing/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

The cheapest request is the one you never send. Scraping costs come from a few places, and each has a lever: compute (especially headless browsers), bandwidth and egress, proxies billed per gigabyte, LLM tokens, storage of raw archives, and the human time spent fixing breakage. Measure cost per useful record rather than per server, avoid work first (do not refetch unchanged pages, do not render static pages, do not send whole HTML documents to a model), and put hard per-run budgets in code so a bug fails closed instead of running up a bill.

## Know the unit cost

Track, per run: pages fetched, bytes downloaded, browser seconds, proxy gigabytes, LLM input and output tokens, and valid records produced. Then cost per 1,000 valid records is the number to watch over time. A scraper whose record count drops while its fetch count stays flat is both broken and wasting money (see [Monitoring and Alerting](monitoring-and-alerting.md)).

| Driver | Typical surprise | First lever |
|---|---|---|
| Headless browser compute | Memory-bound machines, slow pages, hung sessions | Use HTTP where possible; block heavy resources |
| Proxy bandwidth | Residential and mobile proxies are usually billed per GB, so images and scripts cost real money | Do not proxy by default; block assets |
| LLM tokens | Full HTML is mostly markup; re-extracting unchanged pages | Clean and trim input; cache by content hash; batch |
| Egress | Media, PDFs and archives leaving a cloud | Download only what you need; pick providers with included traffic |
| Raw storage | Uncompressed HTML kept forever | Compress, deduplicate, set lifecycle rules |
| Maintenance | Brittle selectors on fast-changing sites | Prefer APIs and structured data; test fixtures |

## Lever 1: do not fetch

- Use an official API, bulk download or feed when one exists (see [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
- Crawl incrementally: sitemap `lastmod`, change feeds, and conditional requests (see [Incremental Crawling](../crawling/incremental-crawling.md)).
- Normalize and deduplicate URLs before they reach the queue (see [Deduplication (URLs and Content)](../crawling/deduplication.md)).
- During development, replay from a local HTTP cache instead of refetching while you tune selectors (Scrapy `HTTPCACHE_ENABLED = True`).

Conditional GET with stored validators, tested against a server that answers `304 Not Modified`:

```python
import sqlite3

import httpx

db = sqlite3.connect("validators.db")
db.execute("CREATE TABLE IF NOT EXISTS v (url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, body BLOB)")


def fetch_if_changed(client: httpx.Client, url: str) -> tuple[bytes, bool]:
    """Return (body, changed). A 304 costs headers only and skips parsing."""
    row = db.execute("SELECT etag, last_modified, body FROM v WHERE url = ?", (url,)).fetchone()
    headers = {}
    if row and row[0]:
        headers["If-None-Match"] = row[0]
    if row and row[1]:
        headers["If-Modified-Since"] = row[1]
    resp = client.get(url, headers=headers)
    if resp.status_code == 304 and row:
        return row[2], False
    resp.raise_for_status()
    db.execute("INSERT OR REPLACE INTO v VALUES (?, ?, ?, ?)",
               (url, resp.headers.get("ETag"), resp.headers.get("Last-Modified"), resp.content))
    db.commit()
    return resp.content, True
```

Details of validators and cache headers are in [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).

## Lever 2: fetch less per page

- Send `Accept-Encoding` and let the client decompress. Most clients handle gzip out of the box; brotli and zstd may need optional packages (see [Compression, Encodings and Character Sets](../http/compression-and-encodings.md)).
- Prefer the JSON endpoint behind a page over the HTML: smaller, more stable, cheaper to parse (see [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).
- Skip binary assets unless they are the data. Check type and size with a `HEAD` request or the response headers before downloading, and cap response size (Scrapy `DOWNLOAD_MAXSIZE`, or abort a stream past a limit).
- Use API field selection and page sizes that minimize round trips (see [Consuming REST APIs Well](../apis/rest-api-consumption.md)).

## Lever 3: avoid or slim the browser

A browser costs far more CPU and memory per page than an HTTP request. Use one only when the data truly needs JavaScript (see [When You Need a Browser](../browser-automation/when-to-use-a-browser.md)); often a single browser session is enough to discover the underlying API, and the production scraper then uses plain HTTP. When a browser is required, block what you do not need:

```typescript
import { chromium } from "playwright";

const BLOCKED = new Set(["image", "media", "font"]);

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: "acme-research-bot/1.0 (+https://acme.example/bot)" });
await context.route("**/*", (route) =>
  BLOCKED.has(route.request().resourceType()) ? route.abort() : route.continue(),
);
const page = await context.newPage();
await page.goto("https://example.com/products", { waitUntil: "domcontentloaded" });
```

Reuse browser contexts, cap concurrency by measured memory, and set navigation timeouts (see [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)). Hosted browsers bill by time: Cloudflare Browser Run, for example, lists 10 included hours per month on the paid Workers plan and $0.09 per additional browser hour (as of 2026-10).

## Lever 4: proxies only when justified

Proxies are not a default component. When a legitimate need exists (geo-specific content you are allowed to collect, a provider's documented requirement), remember that per-GB billing makes heavy pages expensive: block assets, cache aggressively, and send only the requests that need the proxy through it. The ethics and consent questions are covered in [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md).

## Lever 5: LLM tokens

- Use selectors or structured data for stable, high-volume pages; reserve LLM extraction for the long tail and for repair (see [LLM-Assisted Extraction](../llm-scraping/llm-assisted-extraction.md)).
- Shrink the input: main-content extraction and markdown conversion remove most markup tokens (see [Preparing HTML for LLMs](../llm-scraping/preparing-html-for-llms.md)).
- Cache results by a hash of the cleaned input plus prompt and schema version, so unchanged pages are never re-extracted.
- Use asynchronous batch APIs for non-urgent work. Anthropic's Message Batches API is priced at 50 percent of standard rates.
- Cache the shared prefix (instructions, schema, examples). Anthropic documents cache writes at 1.25 times the base input price for the default 5-minute lifetime (2 times for the 1-hour option) and cache reads at about 0.1 times, lower on some newer models.
- Pick the smallest model that passes your validation set, and validate outputs (see [Validating LLM Extractions](../llm-scraping/validating-llm-output.md)). The full token math is in [Costs and Caching for LLM Scraping](../llm-scraping/llm-scraping-costs.md).

## Lever 6: egress and storage

Egress is cheap per gigabyte and expensive at scale. Examples from provider pages (as of 2026-10): Fly.io charges $0.02 per GB to the internet from North America and Europe, Railway $0.05 per GB, and Cloud Run includes 1 GiB per month within North America before standard networking prices apply. Many VPS plans include a monthly traffic allowance; check yours. For storage, compress raw responses (WARC with gzip, or zstd), deduplicate by content hash, move old raw captures to colder storage or delete them under a written retention policy, and keep analytics data in columnar formats (see [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md) and [File Formats for Scraped Data](../storage/file-formats.md)).

## Guardrails: budgets that fail closed

Provider-level budget alerts are slow and coarse. Add per-run ceilings in code and per-key spending caps where the provider supports them:

```python
from dataclasses import dataclass, field


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class RunBudget:
    """Hard per-run ceilings. Charge as you go; the run stops when any limit is crossed."""

    limits: dict[str, float] = field(default_factory=lambda: {
        "requests": 5_000,
        "bytes": 2 * 1024**3,        # downloaded bytes, including proxy traffic
        "browser_seconds": 3_600,
        "llm_tokens": 2_000_000,
    })
    used: dict[str, float] = field(default_factory=dict)

    def charge(self, **amounts: float) -> None:
        for key, amount in amounts.items():
            if key not in self.limits:
                raise KeyError(f"unknown budget key {key!r}")
            self.used[key] = self.used.get(key, 0) + amount
        over = [k for k, v in self.used.items() if v > self.limits[k]]
        if over:
            raise BudgetExceeded(f"run budget exceeded for {', '.join(over)}: {self.used}")

# budget.charge(requests=1, bytes=len(resp.content))
# budget.charge(llm_tokens=usage.input_tokens + usage.output_tokens)
```

Log the `used` totals in the run summary, alert on cost metrics like any other signal, and make the limits part of the scraper's reviewed configuration.

## Pitfalls

- Retry storms that multiply proxy gigabytes and LLM tokens (see [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)).
- Rendering every page in a browser "just in case".
- Re-running LLM extraction on pages whose content hash has not changed.
- Downloading images and PDFs through a metered proxy or out of a cloud with egress fees.
- Always-on machines for jobs that run ten minutes a day, or per-invocation pricing for jobs that poll every minute.
- Free-tier cliffs: a trial credit that expires, or a usage tier that starts billing silently.
- Keeping every raw response forever without compression or a retention rule.

## Checklist

- [ ] Cost per 1,000 valid records tracked per run
- [ ] Conditional requests and incremental crawling in place
- [ ] Browser used only where needed, with resource blocking
- [ ] Proxies off by default; metered traffic minimized
- [ ] LLM input cleaned, results cached by content hash, batch API for bulk work
- [ ] Raw archives compressed with a retention policy
- [ ] Per-run budgets in code and spending caps at providers

## See Also

- [Cheap Hosting for Scrapers](cheap-hosting.md)
- [Costs and Caching for LLM Scraping](../llm-scraping/llm-scraping-costs.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)
- [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md)
