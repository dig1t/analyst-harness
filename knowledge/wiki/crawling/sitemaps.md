---
tags: [scraping, crawling, sitemaps, discovery, xml]
aliases: [sitemap.xml, XML sitemap, sitemap index, Sitemaps protocol, lastmod]
---

# XML Sitemaps

> Sources: sitemaps.org, Sitemaps XML format (https://www.sitemaps.org/protocol.html); Google Search Central, Build and submit a sitemap (https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap); Google Search Central blog, Sitemaps ping endpoint is going away, June 2023 (https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping); RFC 9309, section 2.2.4 (https://www.rfc-editor.org/rfc/rfc9309); W3C Note, Date and Time Formats (https://www.w3.org/TR/NOTE-datetime); defusedxml (https://github.com/tiran/defusedxml)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A sitemap is a file in which a site lists the URLs it wants crawled, optionally with a last-modification date. For a scraper it is often the cheapest complete inventory of a site: no link-following, no pagination, and `lastmod` tells you what changed since your last visit. The format is defined at sitemaps.org (the protocol dates from 2005 and is supported by the major search engines). Each file holds at most **50,000 URLs** and **50 MB (52,428,800 bytes) uncompressed**, may be gzipped, and larger sites split their lists across many files referenced from a **sitemap index**. Sitemaps are discovered through `Sitemap:` lines in robots.txt or conventional paths. Treat them as a strong hint, not the truth: they can be stale, incomplete, or list pages that redirect or 404.

## Format

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.example.com/products?id=42&amp;color=red</loc>
    <lastmod>2026-10-20T08:15:00+00:00</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>
```

| Tag | Required | Rules |
|---|---|---|
| `<loc>` | yes | Absolute URL including scheme; must be less than 2,048 characters; XML-escaped (`&amp;`, `&apos;`, `&quot;`, `&gt;`, `&lt;`) |
| `<lastmod>` | no | W3C Datetime: `2026`, `2026-10`, `2026-10-20`, or a full timestamp with time zone |
| `<changefreq>` | no | `always`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`, `never`; a hint only |
| `<priority>` | no | 0.0 to 1.0, default 0.5, relative to other URLs on the same site |

Files must be UTF-8. A **sitemap index** uses `<sitemapindex>` with `<sitemap><loc>` and optional `<lastmod>` children, lists up to 50,000 sitemaps and obeys the same size limit. The protocol also accepts a **plain-text file** with one URL per line, and RSS 2.0 or Atom feeds can serve as sitemaps for recent URLs.

**Location limits scope.** A sitemap at `https://example.com/catalog/sitemap.xml` may only list URLs under `https://example.com/catalog/`. A site can vouch for sitemaps hosted elsewhere (for example on a CDN) by naming them in its own robots.txt; the protocol calls this cross-submission.

**Extensions** add namespaced children inside `<url>`: images (`image:image`), video (`video:video`), news (`news:news`) and language alternates (`xhtml:link rel="alternate" hreflang="..."`). Google News sitemaps are meant to list only recently published articles, which makes them a cheap freshness feed for news sites (see [News Sites and RSS](../sources/news-and-rss.md)).

## Discovery

1. **robots.txt.** `Sitemap: https://www.example.com/sitemap_index.xml`. The line is independent of user-agent groups, may appear anywhere and more than once, and must be an absolute URL. RFC 9309 lists sitemaps as an "other record" crawlers MAY interpret (see [robots.txt (RFC 9309)](robots-txt.md)).
2. **Conventional paths**: `/sitemap.xml`, `/sitemap_index.xml`, `/sitemap.xml.gz`. WordPress core has generated `/wp-sitemap.xml` since version 5.5; SEO plugins often use `/sitemap_index.xml`.
3. **Feeds and HTML**: RSS/Atom links in `<head>` and footer "site map" pages cover sites without XML sitemaps (see [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md)).

Search engines used to accept unauthenticated "ping" requests announcing a sitemap. Google deprecated its ping endpoint in June 2023, citing spam, and now relies on robots.txt, Search Console and `lastmod`.

## How much to trust the metadata

- **lastmod** is valuable when it is honest. Google says it uses `lastmod` when it is consistently and verifiably accurate. Many CMSs instead stamp every URL with the generation time, which makes the field useless. Verify by sampling: fetch ten URLs whose `lastmod` changed and ten that did not, and compare content hashes.
- **changefreq and priority** are ignored by Google and rarely meaningful; do not schedule on them.
- **Completeness** varies. Sitemaps often omit old content, faceted pages and anything the SEO team considers low value, and they sometimes keep URLs that now redirect or 404. Combine sitemap discovery with link discovery when coverage matters.
- **A URL in a sitemap is not a robots.txt exemption.** Still check robots rules before fetching.

## Code: a streaming sitemap reader

Python 3.11 or newer with `httpx` and `defusedxml`. It follows indexes recursively (with a depth limit and loop protection), handles `.gz` files and `Content-Encoding: gzip`, plain-text sitemaps and namespaced extensions, caps decompression to defeat gzip bombs, and refuses XML entity tricks.

```python
import io
import re
import zlib
from collections.abc import AsyncIterator
from datetime import datetime, timezone

import httpx
from defusedxml.ElementTree import iterparse   # blocks entity-expansion attacks

MAX_BYTES = 52_428_800  # protocol limit: 50 MB uncompressed per file


def gunzip_capped(data: bytes, limit: int = MAX_BYTES) -> bytes:
    d = zlib.decompressobj(wbits=16 + zlib.MAX_WBITS)
    out = d.decompress(data, limit + 1)           # never inflate more than limit + 1 bytes
    if len(out) > limit:
        raise ValueError("sitemap larger than 50 MB uncompressed")
    return out


def parse_lastmod(value: str | None) -> datetime | None:
    """W3C Datetime: YYYY, YYYY-MM, YYYY-MM-DD or a full timestamp with zone."""
    if not value:
        return None
    v = value.strip()
    try:
        if re.fullmatch(r"\d{4}", v):
            return datetime(int(v), 1, 1, tzinfo=timezone.utc)
        if re.fullmatch(r"\d{4}-\d{2}", v):
            return datetime(int(v[:4]), int(v[5:]), 1, tzinfo=timezone.utc)
        dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None                                # bad lastmod: ignore, do not crash


def parse_sitemap(xml: bytes):
    """Yield (kind, loc, lastmod); kind is 'url' or 'sitemap'. Streams large files."""
    stack: list[str] = []
    loc = lastmod = None
    for event, el in iterparse(io.BytesIO(xml), events=("start", "end")):
        name = el.tag.rsplit("}", 1)[-1]           # ignore namespace prefixes
        if event == "start":
            stack.append(name)
            continue
        stack.pop()
        parent = stack[-1] if stack else None
        if name == "loc" and parent in ("url", "sitemap"):   # skips image:loc, video:loc
            loc = (el.text or "").strip()
        elif name == "lastmod" and parent in ("url", "sitemap"):
            lastmod = (el.text or "").strip()
        elif name in ("url", "sitemap"):
            if loc:
                yield name, loc, parse_lastmod(lastmod)
            loc = lastmod = None
            el.clear()                             # keep memory flat


async def sitemap_urls(
    client: httpx.AsyncClient, url: str, depth: int = 3, seen: set[str] | None = None
) -> AsyncIterator[tuple[str, datetime | None]]:
    """Yield (page_url, lastmod) from a sitemap, sitemap index, .gz or text sitemap."""
    seen = set() if seen is None else seen
    if url in seen or depth < 0:
        return
    seen.add(url)
    r = await client.get(url, follow_redirects=True)
    if r.status_code != 200:
        return
    body = r.content                               # httpx already undid Content-Encoding
    if body[:2] == b"\x1f\x8b":                    # a .gz file served as application/gzip
        body = gunzip_capped(body)
    elif len(body) > MAX_BYTES:
        raise ValueError(f"{url}: sitemap larger than 50 MB")
    if not body.lstrip().startswith(b"<"):         # plain-text sitemap: one URL per line
        for line in body.decode("utf-8", "replace").splitlines():
            if line.strip().startswith(("http://", "https://")):
                yield line.strip(), None
        return
    for kind, loc, lastmod in parse_sitemap(body):
        if kind == "sitemap":
            async for item in sitemap_urls(client, loc, depth - 1, seen):
                yield item
        else:
            yield loc, lastmod


async def discover_sitemaps(client: httpx.AsyncClient, origin: str) -> list[str]:
    """Sitemap lines from robots.txt, else the conventional location."""
    r = await client.get(f"{origin}/robots.txt", follow_redirects=True)
    found = []
    if r.status_code == 200:
        for line in r.text.splitlines():
            key, _, value = line.partition(":")
            if key.strip().lower() == "sitemap" and value.strip():
                found.append(value.strip())
    return found or [f"{origin}/sitemap.xml"]
```

Usage:

```python
import asyncio

import httpx


async def main() -> None:
    headers = {"User-Agent": "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)"}
    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        for sitemap in await discover_sitemaps(client, "https://www.example.com"):
            async for url, lastmod in sitemap_urls(client, sitemap):
                print(url, lastmod)


asyncio.run(main())
```

`iterparse` with `el.clear()` keeps memory flat on a 50,000-entry file. The body itself is held in memory (up to 50 MB), which is acceptable for one file at a time.

## Sitemaps in an incremental crawl

- Store `(url, lastmod_seen, content_hash)` and enqueue only URLs whose `lastmod` moved, plus a small random sample of the rest to audit lastmod honesty.
- Use the index's per-sitemap `lastmod` to skip whole child files, and fetch sitemap files with `If-None-Match` or `If-Modified-Since` (see [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)).
- Diff URL sets between runs: URLs that disappear from the sitemap are candidates for deletion checks, not automatic deletions.
- Rate-limit sitemap fetching like any other request. A large index can be hundreds of files.

More scheduling strategies are in [Incremental Crawling](incremental-crawling.md).

## Pitfalls

- Treating every `<loc>` in the file as a page URL: `image:loc` and `video:loc` live inside `<url>` too.
- Parsing with a non-hardened XML parser; sitemaps are untrusted input. Use defusedxml or disable entity resolution.
- Inflating `.gz` files without a size cap.
- Double-decompressing: most clients already undo `Content-Encoding: gzip`, but a `.gz` file served as `application/gzip` still needs manual gunzip.
- Assuming `lastmod` is accurate, or scheduling on `changefreq` and `priority`.
- Following sitemap URLs onto hosts outside your scope, or ignoring robots.txt for URLs a sitemap lists.
- Unbounded recursion when an index lists itself or another index in a loop.

## Checklist

- [ ] Sitemaps discovered from robots.txt first, then conventional paths.
- [ ] Hardened XML parsing, gzip size cap, depth limit and loop protection.
- [ ] Only direct `<loc>` children of `<url>` or `<sitemap>` used; whitespace trimmed.
- [ ] `lastmod` parsed leniently and audited by sampling before trusting it.
- [ ] Robots rules and crawl scope applied to every listed URL.
- [ ] Sitemap fetches cached with validators and counted against the host's rate budget.

## See Also

- [robots.txt (RFC 9309)](robots-txt.md)
- [Incremental Crawling](incremental-crawling.md)
- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md)
- [Compression, Encodings and Character Sets](../http/compression-and-encodings.md)
- [News Sites and RSS](../sources/news-and-rss.md)
