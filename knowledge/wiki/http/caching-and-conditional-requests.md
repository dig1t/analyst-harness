---
tags: [scraping, http, caching, etag, conditional-requests]
aliases: [HTTP caching, ETag, If-None-Match, 304 Not Modified, Conditional GET, Cache-Control]
---

# HTTP Caching and Conditional Requests

> Sources: RFC 9111, HTTP Caching (https://www.rfc-editor.org/rfc/rfc9111); RFC 9110, sections 8.8 (validators), 13 (conditional requests) and 15.4.5 (304) (https://www.rfc-editor.org/rfc/rfc9110); RFC 5861, stale-while-revalidate and stale-if-error (https://www.rfc-editor.org/rfc/rfc5861); RFC 8246, immutable (https://www.rfc-editor.org/rfc/rfc8246); MDN, HTTP caching (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Caching); MDN, HTTP conditional requests (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests); hishel (https://github.com/karpetrosyan/hishel); requests-cache (https://requests-cache.readthedocs.io/); Scrapy HttpCacheMiddleware (https://docs.scrapy.org/en/latest/topics/downloader-middleware.html#module-scrapy.downloadermiddlewares.httpcache)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

HTTP caching has two mechanisms. Freshness lets a client reuse a stored response without asking, for as long as `Cache-Control: max-age` (or `Expires`) allows. Validation lets it ask "has this changed?" by sending the stored `ETag` in `If-None-Match` or the stored `Last-Modified` in `If-Modified-Since`; an unchanged resource comes back as `304 Not Modified` with headers only. For recurring scrapers, conditional requests are the single biggest politeness lever: the server skips rendering and you skip downloading and re-parsing. Local HTTP caches are also the cheapest way to iterate on parsers without re-hitting a site. Validators are common on static files, feeds, sitemaps and APIs, and rare on dynamic HTML, so pair them with your own content hashing.

## The headers

| Header | Side | Role |
|---|---|---|
| `Cache-Control: max-age=N` | Response | Fresh for N seconds; overrides `Expires` |
| `Cache-Control: no-cache` | Response | Store, but revalidate before every reuse |
| `Cache-Control: no-store` | Response | Do not store at all |
| `Cache-Control: private` / `public` | Response | Only a single-user cache may store it / any cache may |
| `Cache-Control: must-revalidate` | Response | Once stale, never reuse without validating |
| `stale-while-revalidate`, `stale-if-error` | Response | Allowed staleness while refreshing or on errors (RFC 5861) |
| `immutable` | Response | Will not change while fresh (RFC 8246), typical for fingerprinted assets |
| `Expires` | Response | Absolute expiry date |
| `Age` | Response | Seconds spent in a shared cache, such as a CDN |
| `ETag` | Response | Opaque validator: strong `"abc"` or weak `W/"abc"` |
| `Last-Modified` | Response | Date validator with one-second resolution |
| `Vary` | Response | Request headers that are part of the cache key |
| `If-None-Match` | Request | "Send it only if the ETag differs" |
| `If-Modified-Since` | Request | "Send it only if modified after this date" |

Rules from the specifications that matter in practice:

- When both validators are sent, the server must ignore `If-Modified-Since` and use `If-None-Match` (RFC 9110, section 13.1.3).
- Echo the server's own `Last-Modified` string in `If-Modified-Since`; the comparison uses the server's clock.
- A 304 carries no body but must repeat `ETag`, `Cache-Control`, `Expires`, `Vary`, `Date` and `Content-Location` when a 200 would have had them (RFC 9110, section 15.4.5). Update stored headers from it.
- Without explicit freshness, caches may use a heuristic; RFC 9111 suggests about 10% of the time since `Last-Modified`.
- A 429 response must never be stored by a cache (RFC 6585).

## Conditional requests in a recurring scraper

Keep validators per URL (and per variant, if you change `Accept-Language` or cookies) next to the stored body:

```python
import sqlite3

import httpx

db = sqlite3.connect("validators.db")
db.execute("CREATE TABLE IF NOT EXISTS pages (url TEXT PRIMARY KEY, etag TEXT, last_modified TEXT, body BLOB)")


def get_if_changed(client: httpx.Client, url: str) -> tuple[bool, bytes]:
    """Conditional GET: returns (changed, body). A 304 costs headers only, no body."""
    row = db.execute("SELECT etag, last_modified, body FROM pages WHERE url = ?", (url,)).fetchone()
    headers = {}
    if row and row[0]:
        headers["If-None-Match"] = row[0]  # preferred validator
    if row and row[1]:
        headers["If-Modified-Since"] = row[1]  # ignored by servers when If-None-Match is present
    r = client.get(url, headers=headers)
    if r.status_code == 304 and row:
        return False, row[2]
    r.raise_for_status()
    db.execute(
        "INSERT INTO pages VALUES (?, ?, ?, ?) ON CONFLICT(url) DO UPDATE SET "
        "etag = excluded.etag, last_modified = excluded.last_modified, body = excluded.body",
        (url, r.headers.get("ETag"), r.headers.get("Last-Modified"), r.content),
    )
    db.commit()
    return True, r.content


with httpx.Client(timeout=15.0) as client:
    for _ in range(2):
        changed, body = get_if_changed(client, "https://example.com/feed.xml")
        print("changed" if changed else "unchanged (304)", len(body))
```

What to expect in the wild:

- **Unstable ETags.** Some server clusters derive ETags from per-machine file metadata, so each backend answers with a different value and you never get a 304. If the ETag changes while a content hash does not, drop the ETag and keep `Last-Modified` or your own hash.
- **Servers that ignore validators** and always answer 200. Hash the body and skip re-parsing when it is unchanged ([Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).
- **A 304 is still a request.** It saves bandwidth and server work, not request quota. Your rate limits still apply.
- **Better change signals** often exist upstream: sitemap `lastmod`, feed timestamps or an API's `updated_since` filter ([Incremental Crawling](../crawling/incremental-crawling.md), [XML Sitemaps](../crawling/sitemaps.md)).

## Local HTTP caches

| Tool | Client | Notes |
|---|---|---|
| hishel 1.x | httpx | `hishel.httpx.SyncCacheClient`, SQLite or Redis storage, RFC 9111 policy; cache hits flagged in `response.extensions["hishel_from_cache"]` |
| requests-cache | requests | `CachedSession`; never expires entries unless you set `expire_after` or `cache_control=True` |
| Scrapy `HttpCacheMiddleware` | Scrapy | `HTTPCACHE_ENABLED = True`; the default `DummyPolicy` caches everything for replay, `RFC2616Policy` follows HTTP rules for production |
| Playwright HAR | Browsers | `record_har_path=` on a context to record, `route_from_har()` to replay |

```python
import hishel
from hishel.httpx import SyncCacheClient

storage = hishel.SyncSqliteStorage(database_path="http_cache.db")  # a bare name lands in .cache/hishel/
policy = hishel.SpecificationPolicy(cache_options=hishel.CacheOptions(shared=False))  # private cache

with SyncCacheClient(storage=storage, policy=policy, timeout=15.0) as client:
    for _ in range(2):
        r = client.get("https://example.com/feed.xml")
        print(r.status_code, r.extensions.get("hishel_from_cache"), r.extensions.get("hishel_revalidated"))
# 200 False False, then 200 True True: the second response was revalidated with a 304
```

```python
import requests_cache

session = requests_cache.CachedSession(
    "http_cache",           # SQLite file http_cache.sqlite
    backend="sqlite",
    cache_control=True,     # honor Cache-Control and Expires from the server
    expire_after=3600,      # fallback TTL when the server says nothing (default: never expire)
    stale_if_error=True,    # serve the stale copy if the origin errors
)
for _ in range(2):
    r = session.get("https://example.com/feed.xml")
    print(r.status_code, r.from_cache)
```

hishel's default policy behaves as a shared cache (it refuses to store `private` responses and those to requests with `Authorization`); a scraper acting as a single client usually wants `shared=False`, as above.

Use two modes deliberately. While developing parsers, cache everything and replay it (Scrapy's `DummyPolicy` idea), so a hundred parser iterations cost the site one crawl. In production, respect HTTP semantics or use your own validators. A cache can evict entries at any time; the durable record of what you fetched belongs in a raw archive ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

## Reading CDN caching

Responses often come from a CDN rather than the origin. `Age`, `Via`, `X-Cache: Hit from cloudfront` or `CF-Cache-Status: HIT` reveal it. A cached copy can be minutes old; when freshness matters, record `Date` and `Age` with the data. Do not append cache-busting parameters (`?_=1730000000`) to force misses: it moves your entire load from the CDN to the origin, the most expensive part of the site.

## curl

```bash
# ETag round trip (curl 7.68.0 and later): the second run returns 304 and keeps page.html
curl -sS --etag-save etag.txt --etag-compare etag.txt -o page.html https://example.com/feed.xml

# Time condition from the local file's mtime; -R stores the server's Last-Modified as mtime
curl -sS -R -o page.html https://example.com/feed.xml
curl -sS -z page.html -o page.html https://example.com/feed.xml
```

## Pitfalls

- **requests-cache with defaults in production**: entries never expire, so the scraper silently stops seeing changes.
- **Cache keys without the `Vary` dimensions** you change (language, currency cookie), serving one variant for another.
- **Caching authenticated or personalized responses** in a cache shared across identities.
- **Ignoring `no-store`** for sensitive responses.
- **Treating 304 as an error** because code checks `status_code == 200`.
- **Inventing `If-Modified-Since` from your own clock** instead of echoing `Last-Modified`.
- **Cache-busting parameters** that bypass CDNs.
- **Relying on a cache as an archive.**

## Checklist

- [ ] Validators stored per URL and variant; conditional GET on every revisit
- [ ] 304 handled as "unchanged", stored headers refreshed from it
- [ ] Content hash as a fallback when validators are missing or unstable
- [ ] Development runs replay from a local cache
- [ ] Production cache honors `Cache-Control`, `Vary` and `no-store`
- [ ] Explicit expiry configured for every cache
- [ ] `Date` and `Age` recorded when freshness matters

## See Also

- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [XML Sitemaps](../crawling/sitemaps.md)
- [Cost Control](../operations/cost-control.md)
- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
- [HTTP Status Codes and How to React](http-status-codes.md)
