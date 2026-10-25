---
tags: [scraping, fundamentals, crawling, apis, strategy]
aliases: [Scraping vs crawling, Crawler vs scraper, API vs scraping, Web crawling]
---

# Scraping vs Crawling vs APIs

> Sources: RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); Scrapy documentation, Architecture overview (https://docs.scrapy.org/en/latest/topics/architecture.html); Christopher Manning, Prabhakar Raghavan and Hinrich Schütze, Introduction to Information Retrieval, chapter 20 "Web crawling and indexes" (https://nlp.stanford.edu/IR-book/); Hacker News API (https://github.com/HackerNews/API); Google Search Central, Overview of Google crawlers and fetchers (https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers); Common Crawl (https://commoncrawl.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Crawling, scraping and API consumption are different activities that are often combined. Crawling discovers and fetches URLs by following links or sitemaps, and its output is a set of pages. Scraping extracts fields from pages or responses you have already identified, and its output is records. API consumption requests structured data from an interface the provider documents and supports, and its output is records with a contract behind them. Decision rule: use an official API when it covers your fields, volume and freshness under acceptable terms; crawl only when you need discovery; scrape when the data exists only in pages. Most production systems are hybrids, such as a sitemap or API for discovery plus page extraction for the fields the API lacks.

## Side by side

| Dimension | Crawling | Scraping | Official API |
|---|---|---|---|
| Goal | Find and fetch many URLs | Extract fields from known pages | Get structured data directly |
| Input | Seeds, sitemaps, feeds | URLs or URL templates | Endpoints, parameters, credentials |
| Output | Pages (often WARC), a link graph | Records | Records (JSON, CSV) |
| Hard parts | Frontier, deduplication, traps, politeness at scale | Selectors, rendering, layout drift, validation | Auth, quotas, pagination, coverage gaps |
| Stability | Follows site structure | Brittle: breaks when markup changes | Versioned; changes are announced |
| Rules that apply | robots.txt above all | robots.txt, terms, copyright, personal data | The API's terms and quotas |
| Main cost | Bandwidth and storage | Maintenance | Quota or price |
| Typical tools | Scrapy, Crawlee, Heritrix, Apache Nutch, StormCrawler | parsel, BeautifulSoup, selectolax, Playwright | SDKs, httpx, requests |

The boundaries blur: a scraper that follows "next" links is crawling a little, and a crawler that saves titles is scraping a little. The distinction still matters because each activity has its own failure modes and its own etiquette.

## When each applies

- **Official API**: when it provides the fields and the volume you need under acceptable terms. A paid or rate-limited API is usually still cheaper than maintaining a scraper, and its terms tell you exactly what is allowed ([Catalog of Useful Open APIs](../apis/official-apis-catalog.md), [Consuming REST APIs Well](../apis/rest-api-consumption.md)).
- **Bulk data and archives**: when you need breadth or history, such as Common Crawl, Wikipedia dumps or GH Archive, or a government bulk download ([Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)).
- **Crawling**: when you do not know the URLs in advance (site-wide monitoring, building a corpus) and no sitemap, feed or listing endpoint enumerates them ([Crawler Architecture](../crawling/crawler-architecture.md)).
- **Scraping**: when you know or can enumerate the pages and the data lives only in their content.
- **The site's own JSON endpoints**: when the frontend loads data from an undocumented API. It is often more stable and much cheaper than HTML, but it can change without notice and the provider never promised it to you. Keep request rates at what a normal visitor's browser would generate and check the terms ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).

## Hybrid patterns that work

1. **Sitemap or feed for discovery, pages for details.** The sitemap lists URLs and `lastmod`; you fetch only new or changed pages ([XML Sitemaps](../crawling/sitemaps.md)).
2. **API for the core, scraping for the gaps.** For example, an API gives identifiers and prices, the page adds a field the API lacks. Check whether the API terms restrict combining data.
3. **Listing endpoint plus detail pages.** A JSON search endpoint enumerates items; detail pages are parsed one by one.
4. **Archive first, live second.** Historical snapshots come from an archive; only the latest state is fetched live.
5. **Browser for bootstrap, HTTP for bulk.** A browser session obtains cookies or a token once; a plain HTTP client does the heavy lifting ([When You Need a Browser](../browser-automation/when-to-use-a-browser.md)).
6. **Push instead of poll.** Webhooks or change feeds trigger targeted fetches ([Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md)).

## The same data, two ways

Hacker News publishes an official API, so there is no reason to parse its HTML:

```python
import httpx

API = "https://hacker-news.firebaseio.com/v0"  # documented at github.com/HackerNews/API

with httpx.Client(timeout=15.0, headers={"User-Agent": "hn-digest/1.0 (ops@acme.example)"}) as client:
    top_ids = client.get(f"{API}/topstories.json").json()[:10]
    for item_id in top_ids:
        item = client.get(f"{API}/item/{item_id}.json").json()
        print(item["score"], item["title"], item.get("url"))
```

Crawling looks different: it is about the frontier, not the fields. A minimal breadth-first crawler for one host, with robots.txt and a delay, that only records what it found:

```python
import time
from collections import deque
from urllib.parse import urldefrag, urljoin, urlsplit
from urllib.robotparser import RobotFileParser

import httpx
from selectolax.lexbor import LexborHTMLParser

UA = "acme-crawler/0.1 (+https://acme.example/bot; ops@acme.example)"


def crawl(seed: str, max_pages: int = 100, delay: float = 1.0) -> dict[str, int]:
    """Breadth-first discovery on one host. Returns {url: status}; extraction happens elsewhere."""
    host = urlsplit(seed).hostname
    seen, frontier, results = {seed}, deque([seed]), {}
    with httpx.Client(headers={"User-Agent": UA}, timeout=15.0, follow_redirects=True) as client:
        rr = client.get(urljoin(seed, "/robots.txt"))
        if rr.status_code >= 500:
            return results  # robots.txt unreachable: assume everything is disallowed (RFC 9309)
        robots = RobotFileParser()
        robots.parse(rr.text.splitlines() if rr.status_code == 200 else [])
        while frontier and len(results) < max_pages:
            url = frontier.popleft()
            if not robots.can_fetch(UA, url):
                continue
            r = client.get(url)
            results[url] = r.status_code
            if r.status_code == 200 and "html" in r.headers.get("content-type", ""):
                for a in LexborHTMLParser(r.text).css("a[href]"):
                    link, _fragment = urldefrag(urljoin(str(r.url), a.attributes["href"]))
                    if urlsplit(link).hostname == host and link not in seen:
                        seen.add(link)
                        frontier.append(link)
            time.sleep(delay)
    return results


print(crawl("https://quotes.toscrape.com/", max_pages=20))
```

A real crawler adds URL normalization, per-host queues, revisit scheduling, trap detection and storage of the fetched pages ([URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md), [Spider Traps and Crawl Hygiene](../crawling/spider-traps.md)).

## Pitfalls

- **Crawling to find what a sitemap, feed or API already lists.** Wasteful for both sides.
- **Scraping HTML for data an API returns**, then maintaining selectors forever.
- **Assuming the API equals the website.** Coverage, fields and freshness often differ; compare samples before switching.
- **Using an undocumented endpoint harder than the site's own frontend would**, for example paging through everything at maximum page size in parallel.
- **Ignoring API terms** on caching, redistribution or combining with other data.
- **Believing APIs need no maintenance.** Versions are deprecated, keys expire and quotas change.
- **Unbounded crawls** without depth, page and host limits.

## Checklist

- [ ] Official API, bulk data and feeds checked before any crawling or scraping
- [ ] Discovery and extraction designed as separate steps
- [ ] Coverage of API versus website compared on a sample
- [ ] Hidden endpoints used at browser-like rates, terms checked
- [ ] Crawls bounded by host, depth and page count, with robots.txt honored

## See Also

- [Choosing an Acquisition Strategy](scraping-decision-framework.md)
- [What Is Web Scraping](what-is-web-scraping.md)
- [Crawler Architecture](../crawling/crawler-architecture.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [XML Sitemaps](../crawling/sitemaps.md)
