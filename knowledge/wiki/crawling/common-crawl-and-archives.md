---
tags: [scraping, crawling, common-crawl, web-archives, warc]
aliases: [Common Crawl, Wayback Machine, Internet Archive, WARC, CDX index, web archive, Memento]
---

# Common Crawl and Web Archives

> Sources: Common Crawl, Get Started (https://commoncrawl.org/get-started); Common Crawl index server (https://index.commoncrawl.org/); Common Crawl columnar index, cc-index-table (https://github.com/commoncrawl/cc-index-table); Internet Archive, Wayback Machine APIs (https://archive.org/help/wayback_api.php); OpenWayback CDX server documentation (https://github.com/iipc/openwayback/tree/master/wayback-cdx-server-webapp); RFC 7089, HTTP Framework for Time-Based Access to Resource States (Memento) (https://www.rfc-editor.org/rfc/rfc7089); IIPC, The WARC Format 1.1 (https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/); warcio (https://github.com/webrecorder/warcio)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Before crawling a site yourself, check whether someone already did. **Common Crawl** is a nonprofit that publishes regular crawls of billions of pages each, free to use, as WARC files on AWS Open Data (`s3://commoncrawl/`, also over HTTPS at `data.commoncrawl.org`), with a URL index you can query per crawl and a columnar Parquet index you can query with SQL. The **Internet Archive's Wayback Machine** holds decades of captures with a CDX API that lists every capture of a URL and a raw mode (`id_`) that returns the archived bytes untouched. Archives are the right tool for history, for sites that no longer exist, for large text corpora and for research that must not load live servers. They are the wrong tool for fresh data, complete coverage of one site, or content that only renders with JavaScript. Copyright and personal-data rules still apply to archived content.

## Common Crawl

**What you get.** Each crawl (named like `CC-MAIN-2026-13`) is published in three formats:

| Format | Contents | Use |
|---|---|---|
| WARC | full HTTP requests and responses | re-parsing pages exactly as fetched |
| WAT | JSON metadata: headers, HTML metadata, extracted links | link graphs, header studies |
| WET | extracted plain text | language and NLP work |

Responses are split into subsets: `warc` (successful fetches), `robotstxt` (the robots.txt files fetched) and `crawldiagnostics` (redirects, 404s and other non-200 responses). Common Crawl also publishes host- and domain-level web graphs. Its crawler identifies itself as `CCBot` and honors robots.txt, so sites that block CCBot are absent (see [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)).

**Finding captures.** Two indexes exist:

- The **CDX index server** at `https://index.commoncrawl.org/`, one endpoint per crawl (`/CC-MAIN-2026-13-index?url=example.com/*&output=json`). `collinfo.json` lists available crawls. Good for lookups of a few URLs or prefixes. It is a shared service that slows down under load; keep requests sequential.
- The **columnar index**: Parquet files under `s3://commoncrawl/cc-index/table/cc-main/warc/`, partitioned by `crawl` and `subset`. Query it with Amazon Athena (the data lives in us-east-1), Spark or DuckDB for anything bigger than a handful of URLs.

```sql
-- Athena, after creating the table with the DDL from commoncrawl/cc-index-table
SELECT url, fetch_status, warc_filename, warc_record_offset, warc_record_length
FROM ccindex
WHERE crawl = 'CC-MAIN-2026-13'
  AND subset = 'warc'
  AND url_host_registered_domain = 'example.com'
  AND content_mime_detected = 'text/html'
LIMIT 1000;
```

**Fetching a single page.** Every index row gives a WARC `filename`, `offset` and `length`. Each record is an independent gzip member, so an HTTP Range request returns exactly one record that a WARC reader can parse. That means you can pull a thousand pages without downloading a single 1 GB WARC file.

## Code: Common Crawl and Wayback lookups

Python 3.11 with `httpx` and `warcio`. Tested against mocked endpoints, including a real gzip-member WARC record served through a Range request.

```python
import io
import json

import httpx
from warcio.archiveiterator import ArchiveIterator

CC_INDEX = "https://index.commoncrawl.org"
CC_DATA = "https://data.commoncrawl.org"
WAYBACK_CDX = "https://web.archive.org/cdx/search/cdx"


async def cc_crawls(client: httpx.AsyncClient) -> list[str]:
    """Crawl ids, newest first, e.g. 'CC-MAIN-2026-13'."""
    r = await client.get(f"{CC_INDEX}/collinfo.json")
    r.raise_for_status()
    return [c["id"] for c in r.json()]


async def cc_lookup(client: httpx.AsyncClient, crawl: str, url: str, limit: int = 100) -> list[dict]:
    """Query one crawl's CDX index. url may be a prefix pattern like 'example.com/blog/*'."""
    r = await client.get(f"{CC_INDEX}/{crawl}-index",
                         params={"url": url, "output": "json", "limit": limit})
    if r.status_code == 404:                       # no captures in this crawl
        return []
    r.raise_for_status()
    return [json.loads(line) for line in r.text.splitlines() if line.strip()]


async def cc_fetch(client: httpx.AsyncClient, capture: dict) -> tuple[str, bytes]:
    """Fetch one WARC record with an HTTP Range request; return (status, body)."""
    start = int(capture["offset"])
    end = start + int(capture["length"]) - 1
    r = await client.get(f"{CC_DATA}/{capture['filename']}",
                         headers={"Range": f"bytes={start}-{end}"})
    r.raise_for_status()                           # expect 206 Partial Content
    for record in ArchiveIterator(io.BytesIO(r.content)):   # one gzip member, one record
        if record.rec_type == "response":
            return record.http_headers.get_statuscode(), record.content_stream().read()
    raise ValueError("no response record in range")


async def wayback_captures(client: httpx.AsyncClient, url: str, since: str = "",
                           until: str = "", limit: int = 1000) -> list[dict]:
    """Wayback CDX API: one row per unique 200 capture (collapse=digest skips repeats)."""
    params = {"url": url, "output": "json", "filter": "statuscode:200",
              "collapse": "digest", "limit": limit}
    if since:
        params["from"] = since                     # e.g. "2019" or "20190101"
    if until:
        params["to"] = until
    r = await client.get(WAYBACK_CDX, params=params)
    r.raise_for_status()
    rows = r.json() if r.text.strip() else []
    if not rows:
        return []
    header, *data = rows                           # first row holds the field names
    return [dict(zip(header, row)) for row in data]


async def wayback_raw(client: httpx.AsyncClient, timestamp: str, original: str) -> httpx.Response:
    """The archived bytes without Wayback's banner or link rewriting (the id_ modifier)."""
    return await client.get(f"https://web.archive.org/web/{timestamp}id_/{original}",
                            follow_redirects=True)
```

Usage: `crawl = (await cc_crawls(client))[0]`, then `for cap in await cc_lookup(client, crawl, "example.com/blog/*")`, then `status, html = await cc_fetch(client, cap)`. Send a descriptive User-Agent and keep requests sequential.

## Internet Archive and the Wayback Machine

- **CDX API** (`/cdx/search/cdx`): parameters include `url`, `matchType` (`exact`, `prefix`, `host`, `domain`), `from` and `to` (timestamps, any prefix of `yyyyMMddhhmmss`), `filter` (for example `statuscode:200` or `mimetype:text/html`), `collapse` (for example `digest` to skip unchanged captures, `urlkey` for unique URLs), `fl` to choose fields, `limit`, and `showResumeKey`/`resumeKey` for paging through large results. With `output=json` the first row is the header.
- **Availability API**: `https://archive.org/wayback/available?url=example.com&timestamp=20200101` returns the closest capture as JSON; handy for single lookups.
- **Raw captures**: `https://web.archive.org/web/<timestamp>id_/<original-url>` returns the original response body without the toolbar and without rewritten links, which is what you want to parse. Without `id_` you get a rewritten page.
- **Save Page Now** creates new captures; programmatic use requires an account and API keys and is rate-limited.
- **Etiquette**: the Internet Archive is a nonprofit running on donations. Keep concurrency low, back off on 429 and 503, cache results and prefer CDX queries over crawling calendar pages. Heavy users can be blocked.

**Memento** (RFC 7089) standardizes time travel across archives: a TimeGate redirects to the capture closest to a requested datetime (`Accept-Datetime` header) and a TimeMap lists all captures. Aggregators query many archives at once, which helps when the Wayback Machine lacks a capture that a national library archive has.

## WARC for your own crawls

WARC (ISO 28500, version 1.1 maintained by the IIPC) stores records of type `warcinfo`, `request`, `response`, `metadata`, `revisit` (a deduplicated capture pointing at an earlier identical payload), `resource` and others. Writing your own crawl output as WARC makes it replayable with standard tools (pywb), parseable with `warcio`, and directly comparable with Common Crawl data. `warcio` can record live HTTP traffic from Python, and `wget --warc-file` writes WARC from the command line. See [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md). Archives key URLs in SURT form (`com,example)/path`), the same idea as a normalized key ([URL Normalization and Canonicalization](url-normalization.md)).

## Archive or live crawl?

| Need | Archive | Live crawl |
|---|---|---|
| History, "what did this page say in 2019" | yes | impossible |
| Site gone or blocking all bots | yes, if captured | no |
| Large multi-site text corpus | Common Crawl | expensive and impolite at scale |
| Current prices, stock, listings | no (crawl lag, gaps) | yes |
| Complete coverage of one site | rarely (depth and per-site limits) | yes |
| JavaScript-rendered content | often missing | browser crawl |

## Pitfalls

- Assuming coverage: a missing capture means "not crawled", not "did not exist". Common Crawl samples sites; robots.txt exclusions remove whole hosts.
- Downloading whole WARC files to read a few pages instead of using Range requests.
- Parsing Wayback pages without `id_` and extracting rewritten `web.archive.org` links.
- Hammering the CDX servers in parallel; both are shared, donation-funded infrastructure.
- Treating archived content as free of rights: copyright, database rights and personal-data rules still apply (see [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)).
- Forgetting that captures can be soft 404s or block pages; check status, size and content before using them.

## Checklist

- [ ] Checked Common Crawl and the Wayback Machine before planning a historical crawl.
- [ ] Used the CDX or columnar index first; fetched records with Range requests.
- [ ] Parsed raw captures (`id_`, WARC payloads), not rewritten replay pages.
- [ ] Low concurrency, backoff on 429/503, results cached.
- [ ] Recorded archive, crawl id or capture timestamp in provenance for every record.
- [ ] Reviewed rights and terms for the intended use of the content.

## See Also

- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
- [Deduplication (URLs and Content)](deduplication.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
