---
tags: [scraping, tools, python, httpx, parsing]
aliases: [Python scraping, requests, httpx, BeautifulSoup, lxml, selectolax, parsel, aiohttp]
---

# Python Scraping Stack

> Sources: Requests documentation (https://requests.readthedocs.io/); HTTPX documentation (https://www.python-httpx.org/), including HTTP/2 (https://www.python-httpx.org/http2/) and transports (https://www.python-httpx.org/advanced/transports/); aiohttp client reference (https://docs.aiohttp.org/en/stable/client_reference.html); Beautiful Soup documentation (https://www.crummy.com/software/BeautifulSoup/bs4/doc/); lxml (https://lxml.de/); selectolax (https://github.com/rushter/selectolax); parsel (https://parsel.readthedocs.io/); urllib3 Retry (https://urllib3.readthedocs.io/en/stable/reference/urllib3.util.html); Protego robots.txt parser (https://github.com/scrapy/protego); Python docs, urllib.robotparser (https://docs.python.org/3/library/urllib.robotparser.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Python has the deepest scraping ecosystem. A sensible default for new work is **httpx** for HTTP (sync and async, HTTP/2, sane timeouts) plus one fast parser (**selectolax** for CSS, **lxml** or **parsel** when you need XPath), **pydantic** to validate records, and **tenacity** or a small loop for retries. Reach for **Scrapy** when the job is a crawl with many pages and politeness rules (see [Scrapy](scrapy.md)) and for **Playwright** only when the data really needs a browser (see [Playwright](../browser-automation/playwright.md)). BeautifulSoup remains the friendliest API for messy one-off pages.

## The libraries (versions as of 2026-10)

| Library | Role | Version | Notes |
|---|---|---|---|
| requests | Sync HTTP | 2.34 | Simple and ubiquitous; no HTTP/2; no default timeout |
| httpx | Sync and async HTTP | 0.28.1 | Default timeout 5 s; redirects not followed unless `follow_redirects=True`; HTTP/2 with `httpx[http2]` |
| aiohttp | Async HTTP client and server | 3.14 | Fast; connector caps 100 connections total, unlimited per host by default |
| beautifulsoup4 | Tree API over a parser | 4.15 | Choose the parser: `lxml`, `html.parser` or `html5lib`; CSS via `select()` |
| lxml | Fast HTML and XML parsing | 6.1 | XPath 1.0; CSS through the `cssselect` package |
| selectolax | Very fast CSS-only parsing (Lexbor engine) | 1.0 | Import from `selectolax.lexbor`; the old Modest backend now raises an ImportError |
| parsel | CSS, XPath, regex and JMESPath on one object | 1.12 | The selector library inside Scrapy |
| Scrapy | Crawling framework | 2.19 | Scheduler, throttling, pipelines, see [Scrapy](scrapy.md) |
| pydantic | Validation | 2.14 | See [Schema Validation](../data-quality/schema-validation.md) |

## HTTP clients compared

| Need | requests | httpx | aiohttp |
|---|---|---|---|
| Sync API | Yes | Yes | No |
| Async API | No | Yes | Yes |
| HTTP/2 | No | Optional extra | No |
| Default timeout | **None (can hang forever)** | 5 s for connect, read, write and pool | 300 s total |
| Redirects | Followed | Not followed by default | Followed |
| Built-in retries | Via urllib3 `Retry` on an adapter | Connection retries only (`HTTPTransport(retries=n)`) | No |
| Connection pool | Per `Session`, per host | 100 total, 20 keep-alive | 100 total, no per-host cap |

The requests documentation itself warns that nearly all production code should pass `timeout`, because without it a request can hang indefinitely. Whatever the client, create one session or client per run and reuse it, so connections are pooled (see [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)).

## Parsers compared

| Parser | Speed | Selectors | Strengths | Weak spots |
|---|---|---|---|---|
| BeautifulSoup (with `lxml`) | Slowest of the four | CSS via soupsieve, tree navigation | Forgiving, readable, great for exploration | Memory and CPU on large crawls |
| lxml | Fast | XPath 1.0, CSS with cssselect | Full XPath, XML, namespaces | C library quirks on very broken markup |
| selectolax | Fastest | CSS only, plus `lexbor-contains` text matching | Throughput on big crawls | No XPath, small API |
| parsel | Fast (lxml underneath) | CSS with `::text` and `::attr()`, XPath, `.re()`, JMESPath | Same code inside and outside Scrapy | Another abstraction to learn |

Selector syntax and robustness are covered in [CSS Selectors for Extraction](../parsing/css-selectors.md), [XPath for Extraction](../parsing/xpath.md) and [Writing Robust Selectors](../parsing/robust-selectors.md).

## One page, four parsers

Tested on Python 3.13 with the versions above:

```python
import httpx
from bs4 import BeautifulSoup
from lxml import html as lxml_html
from parsel import Selector
from selectolax.lexbor import LexborHTMLParser

URL = "https://books.toscrape.com/catalogue/page-1.html"
HEADERS = {"User-Agent": "acme-research-bot/1.0 (+https://acme.example/bot)"}

with httpx.Client(headers=HEADERS, timeout=httpx.Timeout(10.0, connect=5.0), follow_redirects=True) as client:
    resp = client.get(URL)
    resp.raise_for_status()
    page = resp.text

# BeautifulSoup: forgiving, friendly API, CSS through soupsieve
soup = BeautifulSoup(page, "lxml")
titles = [a.get_text(strip=True) for a in soup.select("article.product_pod h3 a")]

# lxml: fast, full XPath 1.0
prices = lxml_html.fromstring(page).xpath("//article[@class='product_pod']//p[@class='price_color']/text()")

# selectolax: fastest CSS-only extraction
links = [n.attributes.get("href") for n in LexborHTMLParser(page).css("article.product_pod h3 a")]

# parsel: CSS and XPath on one object, the same API as Scrapy responses
sel = Selector(text=page)
next_page = sel.css("li.next a::attr(href)").get()
page_title = sel.xpath("//title/text()").get()
```

Relative links still need `urljoin(str(resp.url), href)`; see [URL Normalization and Canonicalization](../crawling/url-normalization.md).

## requests with retries

When a codebase already uses requests, mount a retrying adapter and always pass a timeout:

```python
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

session = requests.Session()
session.headers["User-Agent"] = "acme-research-bot/1.0 (+https://acme.example/bot)"
retry = Retry(total=5, backoff_factor=1, backoff_jitter=1,
              status_forcelist=[429, 500, 502, 503, 504])  # Retry-After is honored by default
session.mount("https://", HTTPAdapter(max_retries=retry, pool_maxsize=10))
resp = session.get("https://books.toscrape.com/", timeout=(5, 30))  # (connect, read) seconds
```

urllib3 skips the delay before the first retry, does not retry POST by default, and adds `backoff_jitter` on top of the exponential delay. For async code use the loop in [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md), and for concurrency limits see [Concurrency and Async IO](../operations/concurrency-and-async.md).

## robots.txt

Check robots.txt before crawling (see [robots.txt (RFC 9309)](../crawling/robots-txt.md)). The standard library's `urllib.robotparser` changed behavior between versions: in CPython 3.12 it applies the first matching rule in file order and has no wildcard support, while the 3.13 branch implements RFC 9309 longest-match semantics. Protego, Scrapy's default parser, behaves the same on every Python version:

```python
from protego import Protego
import httpx

robots = Protego.parse(httpx.get("https://books.toscrape.com/robots.txt", timeout=10).text)
allowed = robots.can_fetch("https://books.toscrape.com/catalogue/page-2.html", "acme-research-bot")
delay = robots.crawl_delay("acme-research-bot")  # None when not set
```

## Useful companions

| Task | Library |
|---|---|
| Validation | pydantic, see [Schema Validation](../data-quality/schema-validation.md) |
| Retries | tenacity (`wait_random_exponential` is full jitter) |
| JSON-LD, Microdata, OpenGraph | extruct, see [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md) |
| Main-content text | trafilatura, readability ports, see [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md) |
| HTML tables | `pandas.read_html`, see [Extracting HTML Tables](../parsing/html-tables.md) |
| PDFs | pdfplumber, pypdf, see [PDF Data Extraction](../parsing/pdf-extraction.md) |
| URL helpers | w3lib (from the Scrapy project) |
| Browsers | Playwright for Python |

## Pitfalls

- `requests.get(url)` with no timeout: one stalled server freezes the run.
- Expecting httpx to follow redirects like requests does; set `follow_redirects=True` when you want that.
- Creating a new client per request, losing pooling and multiplying TLS handshakes.
- Importing `selectolax.parser` in new code; on 1.0 it raises an ImportError pointing to `selectolax.lexbor`.
- BeautifulSoup with the default `html.parser` producing a different tree than a browser for broken markup; use `lxml` or `html5lib` deliberately (see [HTML and the DOM](../parsing/html-and-the-dom.md)).
- Blocking libraries (requests, `time.sleep`) inside async code.
- Relying on `urllib.robotparser` semantics that differ between Python versions.

## Checklist

- [ ] One reused client or session with explicit timeouts and an honest User-Agent
- [ ] Redirect behavior chosen on purpose
- [ ] Retries with backoff for transient failures only
- [ ] A single fast parser per project; selectors in one place
- [ ] Records validated with a schema before storage
- [ ] robots.txt checked with a consistent parser
- [ ] Dependencies pinned and upgraded deliberately

## See Also

- [Scrapy](scrapy.md)
- [Node.js Scraping Stack](node-scraping-stack.md)
- [Command-Line Tools](cli-tools.md)
- [CSS Selectors for Extraction](../parsing/css-selectors.md)
- [Concurrency and Async IO](../operations/concurrency-and-async.md)
- [Schema Validation](../data-quality/schema-validation.md)
