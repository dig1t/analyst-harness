---
tags: [scraping, fundamentals, pitfalls, best-practices]
aliases: [Scraping mistakes, Common mistakes, Scraper anti-patterns, Why my scraper broke]
---

# Common Scraping Pitfalls

> Sources: RFC 9110, HTTP Semantics (https://www.rfc-editor.org/rfc/rfc9110); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); WHATWG Encoding Standard (https://encoding.spec.whatwg.org/); requests documentation, Timeouts (https://requests.readthedocs.io/en/latest/user/advanced/#timeouts); Python documentation, asyncio (https://docs.python.org/3/library/asyncio.html); Python documentation, decimal (https://docs.python.org/3/library/decimal.html); Scrapy documentation, AutoThrottle (https://docs.scrapy.org/en/latest/topics/autothrottle.html); Google, Site Reliability Engineering, "Monitoring Distributed Systems" (https://sre.google/sre-book/monitoring-distributed-systems/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most scraper failures come from a short list of recurring mistakes rather than from exotic site defenses: no timeouts, no rate limit, brittle selectors, wrong character encodings, 200 responses that were really errors, runs that "succeed" with zero rows, no raw archive, no provenance, and a strategy chosen before anyone looked for an API. This article lists them by area with the symptom you will see and the fix, and links to the article that covers each fix in depth. Use it as a review checklist before a scraper goes on a schedule and as a triage aid when one breaks.

## Strategy and ethics

| Mistake | Symptom | Fix |
|---|---|---|
| Scraping before looking for an API, dump or feed | Fragile scraper for data available cleanly | Follow [Choosing an Acquisition Strategy](scraping-decision-framework.md) |
| Ignoring robots.txt and terms | Complaints, blocks, legal letters | Read both first; honor disallows ([robots.txt (RFC 9309)](../crawling/robots-txt.md)) |
| Collecting personal data "because it is public" | Compliance exposure | Minimize, justify, or do not collect ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)) |
| Anonymous or fake identity | Blocks with no way for the site to reach you | Honest User-Agent with contact ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)) |
| Answering blocks with rotation and evasion | Escalating arms race, higher risk | Slow down, ask, use an official channel ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)) |
| No load estimate | A "small" job sending millions of requests | Estimate requests per day before building |

## Fetching

| Mistake | Symptom | Fix |
|---|---|---|
| No timeout | Workers hang forever (requests has no default timeout) | Explicit connect and read timeouts ([HTTP Fundamentals](../http/http-fundamentals.md)) |
| No rate limit, unbounded concurrency | 429s, 503s, bans, a hurt site | Per-host limits and delays ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)) |
| Retrying everything, forever | Request storms during outages; duplicated POSTs | Retry only transient codes and idempotent methods, with backoff and a budget ([HTTP Status Codes and How to React](../http/http-status-codes.md)) |
| Ignoring `Retry-After` | Repeated 429s | Honor it, in both its forms |
| A new client per request | Slow runs, handshake overhead | One long-lived client per site ([HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)) |
| Treating every 200 as success | Soft 404s and block pages stored as data | Validate the page contract on every 200 |
| Disabling TLS verification | Silent exposure to interception and fake data | Fix trust instead ([TLS and HTTPS for Scrapers](../http/tls-and-https.md)) |
| Copying every header from DevTools | Breaks when a token expires; leaks your session | Minimal headers, runtime tokens ([Request Headers That Matter](../http/http-headers-for-scrapers.md)) |
| Re-downloading unchanged pages | Wasted bandwidth and goodwill | Conditional requests ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)) |
| A headless browser for everything | Far more CPU, memory and time per page; flaky runs | HTTP first; browser only when needed ([When You Need a Browser](../browser-automation/when-to-use-a-browser.md)) |

## Parsing and extraction

| Mistake | Symptom | Fix |
|---|---|---|
| Brittle selectors (`div:nth-child(3) > span`, hashed class names) | Breaks on every redesign | Stable anchors, data attributes, fallbacks ([Writing Robust Selectors](../parsing/robust-selectors.md)) |
| Parsing HTML with regular expressions | Misses on nesting and attribute order | Use a real parser ([Regular Expressions: When and When Not](../parsing/regex-in-scraping.md)) |
| Ignoring embedded JSON and JSON-LD | Fighting the DOM for data the page ships as JSON | Check for state blobs first ([JSON and Embedded Data](../parsing/json-and-embedded-data.md)) |
| Trusting the library's charset guess | Mojibake such as `cafÃ©` | Decide from BOM, header, meta, then detection ([Compression, Encodings and Character Sets](../http/compression-and-encodings.md)) |
| Locale-blind numbers and dates | `1.234` read as 1.234 instead of 1234; dates off by a day | Locale-aware parsing, aware UTC timestamps ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)) |
| Floats for money | Rounding drift | `Decimal` or integer minor units |
| Relative links resolved against the wrong base | Broken or duplicated URLs | Resolve against the final URL or `<base href>` |
| Overfitting to one sample page | Fails on other templates, variants and languages | Fixtures from every template |

## Data quality and storage

| Mistake | Symptom | Fix |
|---|---|---|
| No schema validation | Nulls and wrong types flow downstream | Validate at the boundary, quarantine failures ([Schema Validation](../data-quality/schema-validation.md)) |
| "Successful" runs with zero rows | Silent outages for weeks | Fail runs on empty or mostly invalid output ([Data Quality Monitoring](../data-quality/data-quality-monitoring.md)) |
| No raw archive | Every parser fix needs a full re-crawl | Archive responses before parsing ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)) |
| No provenance | Nobody can say where a value came from | Source URL, fetch time, raw reference, parser version ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)) |
| Inserts instead of upserts | Duplicates after every retry | Stable keys and idempotent writes |
| Overwriting history | Cannot answer "what was the price last month?" | Append observations or keep snapshots ([Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)) |
| CSV without explicit encoding and quoting | Broken rows, mojibake in spreadsheets | JSONL or Parquet, or `csv` with UTF-8 ([File Formats for Scraped Data](../storage/file-formats.md)) |
| Naive deduplication on raw URLs | Same item stored many times | Normalize URLs, use canonical and content keys ([Deduplication (URLs and Content)](../crawling/deduplication.md)) |

## Operations

| Mistake | Symptom | Fix |
|---|---|---|
| Monitoring exit codes only | Green dashboards, empty tables | Volume, null-rate and freshness checks against baselines |
| Alerts with no owner | Alerts ignored | Named owner and routing ([Monitoring and Alerting](../operations/monitoring-and-alerting.md)) |
| Secrets in code or notebooks | Leaked credentials | Secret store, scanning ([Secrets and Configuration](../operations/secrets-and-config.md)) |
| Overlapping scheduled runs | Double load, write conflicts | Locks and overlap protection ([Scheduling and Cron](../operations/scheduling-and-cron.md)) |
| Everyone scheduled at :00 | Synchronized bursts | Jitter start times |
| No tests | Every change is a production experiment | Fixture and contract tests ([Testing Scrapers](../data-quality/testing-scrapers.md)) |
| Blocking calls inside async code | One slow request stalls all tasks | `await asyncio.sleep`, async clients ([Concurrency and Async IO](../operations/concurrency-and-async.md)) |
| Never retiring scrapers | Zombie load and stale credentials | Retirement step in the lifecycle ([Scraping Project Lifecycle](scraping-project-lifecycle.md)) |

## LLM-assisted extraction

| Mistake | Symptom | Fix |
|---|---|---|
| LLM for fields a selector extracts reliably | High cost, nondeterminism | Selectors first, LLM for the irregular remainder ([LLM-Assisted Extraction](../llm-scraping/llm-assisted-extraction.md)) |
| Trusting LLM output unchecked | Plausible but invented values | Grounding checks against the source text ([Validating LLM Extractions](../llm-scraping/validating-llm-output.md)) |
| Sending raw HTML to a model | Token bills dominated by markup | Clean and convert first ([Preparing HTML for LLMs](../llm-scraping/preparing-html-for-llms.md)) |

## Several fixes in one place

```python
import asyncio
from datetime import datetime, timezone
from decimal import Decimal
from urllib.parse import urljoin

import httpx

UA = "acme-bot/1.0 (+https://acme.example/bot; ops@acme.example)"


async def main(urls: list[str]) -> list[dict]:
    gate = asyncio.Semaphore(2)  # bounded concurrency per host

    async with httpx.AsyncClient(
        headers={"User-Agent": UA},
        timeout=httpx.Timeout(20.0, connect=5.0),  # never wait forever
        follow_redirects=True,
    ) as client:

        async def one(url: str) -> dict:
            async with gate:
                r = await client.get(url, params={"currency": "EUR"})  # let the library encode queries
                await asyncio.sleep(1.0)  # asyncio.sleep, never time.sleep inside async code
            return {
                "url": str(r.url),                                  # final URL, after redirects
                "status": r.status_code,
                "next": urljoin(str(r.url), "../2/"),               # resolve against the final URL
                "price": Decimal("19.99"),                          # money as Decimal, not float
                "fetched_at": datetime.now(timezone.utc).isoformat(),  # aware UTC timestamps
            }

        return await asyncio.gather(*(one(u) for u in urls))


rows = asyncio.run(main(["https://example.com/catalog/page/1/", "https://example.com/catalog/page/2/"]))
if not any(r["status"] == 200 for r in rows):
    raise SystemExit("no successful pages: fail the run instead of reporting success")
print(rows[0])
```

## Pitfalls

Pitfalls of using a list like this one:

- **Treating it as exhaustive.** Every site has its own surprises; record them as lessons when you meet them ([How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)).
- **Fixing the symptom.** A burst of 403s after a redesign may be a block, not a selector problem; triage before patching ([Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)).
- **Over-engineering a one-off.** A single exploratory pull needs timeouts, politeness and provenance, not a queue cluster.

## Checklist

- [ ] Strategy decided after looking for APIs, dumps and feeds
- [ ] robots.txt and terms read; personal data assessed
- [ ] Timeouts, per-host rate limits and bounded concurrency
- [ ] Retries only for transient errors, honoring `Retry-After`
- [ ] Page contract validated on every 200
- [ ] Charset, numbers, dates and money parsed deliberately
- [ ] Schema validation with quarantine; runs fail on empty output
- [ ] Raw archive and provenance on every record
- [ ] Idempotent writes and preserved history
- [ ] Monitoring against baselines with a named owner
- [ ] Secrets outside code; tests in CI
- [ ] A review date and a retirement plan

## See Also

- [Anatomy of a Scraper](anatomy-of-a-scraper.md)
- [Scraping Project Lifecycle](scraping-project-lifecycle.md)
- [HTTP Status Codes and How to React](../http/http-status-codes.md)
- [Writing Robust Selectors](../parsing/robust-selectors.md)
- [Data Quality Monitoring](../data-quality/data-quality-monitoring.md)
- [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)
