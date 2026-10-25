---
tags: [scraping, parsing, xml, rss, atom]
aliases: [RSS, Atom, feeds, feedparser, XML namespaces, JSON Feed, feed discovery, syndication]
---

# XML, RSS and Atom Feeds

> Sources: RSS Advisory Board, RSS 2.0 Specification (https://www.rssboard.org/rss-specification); IETF RFC 4287, The Atom Syndication Format (https://www.rfc-editor.org/rfc/rfc4287); JSON Feed Version 1.1 (https://www.jsonfeed.org/version/1.1/); RSS Advisory Board, RSS Autodiscovery (https://www.rssboard.org/rss-autodiscovery); W3C, Namespaces in XML 1.0 (https://www.w3.org/TR/xml-names/); W3C, WebSub (https://www.w3.org/TR/websub/); feedparser documentation (https://feedparser.readthedocs.io/); lxml, Parsing XML and HTML (https://lxml.de/parsing.html); Python documentation, XML vulnerabilities (https://docs.python.org/3/library/xml.html#xml-vulnerabilities); defusedxml (https://github.com/tiran/defusedxml)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Feeds are the politest data source on the web: published on purpose for machines, small, cacheable and stable. Most are RSS 2.0 or Atom 1.0 (XML); some sites also offer JSON Feed. Discover them through `<link rel="alternate">` tags, fetch them with your own HTTP client using conditional requests (ETag, Last-Modified), parse them with feedparser (one normalized structure for every format, tolerant of broken XML) or with lxml when you need exact control, and deduplicate entries by their id or guid. With raw XML, bind namespaces explicitly (XPath 1.0 has no default namespace) and parse untrusted documents with entity expansion and network access disabled.

## Formats compared

| Aspect | RSS 2.0 | Atom 1.0 (RFC 4287) | JSON Feed 1.1 |
|---|---|---|---|
| Media type | `application/rss+xml` | `application/atom+xml` | `application/feed+json` |
| Structure | `rss > channel > item` | `feed > entry`, default namespace `http://www.w3.org/2005/Atom` | `{"version": ..., "items": [...]}` |
| Item identity | `guid` (`isPermaLink` defaults to true) | `id`, required and permanent | `id`, required |
| Link | `link` | `link rel="alternate"` (a link without `rel` means alternate) | `url` |
| Dates | `pubDate` in RFC 822 format | `updated` (required), `published`; RFC 3339 | `date_published`, `date_modified`; RFC 3339 |
| Body | `description` (escaped HTML), `content:encoded` module | `summary`, `content` with `type="text"`, `"html"` or `"xhtml"` | `content_html`, `content_text`, `summary` |
| Author | `author` (an email address), `dc:creator` | `author > name` | `authors` list |
| Media | `enclosure` with `url`, `length`, `type` | `link rel="enclosure"` | `attachments` |
| Required feed fields | `title`, `link`, `description` | `id`, `title`, `updated` | `version`, `title`, `items` |

## Discovery

```python
from urllib.parse import urljoin
from parsel import Selector

FEED_TYPES = ("application/rss+xml", "application/atom+xml", "application/feed+json", "application/json")

def discover_feeds(html: str, page_url: str) -> list[str]:
    sel = Selector(text=html)
    links = sel.xpath("//link[contains(concat(' ', normalize-space(@rel), ' '), ' alternate ')][@href]")
    return [urljoin(page_url, link.attrib["href"]) for link in links
            if link.attrib.get("type", "").split(";")[0].strip().lower() in FEED_TYPES]

html = """<head><link rel="alternate" type="application/rss+xml" href="/feed.xml">
<link rel="alternate" type="application/atom+xml" href="https://blog.example/atom.xml">
<link rel="alternate" hreflang="es" href="/es/"></head>"""
print(discover_feeds(html, "https://blog.example/posts/"))
# ['https://blog.example/feed.xml', 'https://blog.example/atom.xml']
```

When a page declares nothing, a few conventional paths (`/feed`, `/rss.xml`, `/atom.xml`, `/feed.xml`, `/index.xml`, WordPress's `/feed/`) are worth one polite request each. Feeds list recent content; for complete URL inventories use [XML Sitemaps](../crawling/sitemaps.md).

## Fetching politely

```python
import feedparser
import requests

def fetch_feed(session: requests.Session, url: str, state: dict):
    """Conditional GET. Returns a parsed feed, or None when the feed is unchanged (304)."""
    headers = {}
    if state.get("etag"):
        headers["If-None-Match"] = state["etag"]
    if state.get("last_modified"):
        headers["If-Modified-Since"] = state["last_modified"]
    r = session.get(url, headers=headers, timeout=30)
    if r.status_code == 304:
        return None
    r.raise_for_status()
    state["etag"] = r.headers.get("ETag")
    state["last_modified"] = r.headers.get("Last-Modified")
    # Pass the headers so feedparser can use the charset and the base URL (Content-Location)
    return feedparser.parse(r.content, response_headers={k.lower(): v for k, v in r.headers.items()})
```

Persist `state` per feed. Fetch with your own client (timeouts, retries, an honest User-Agent: [Identifying Your Bot](../anti-bot/identifying-your-bot.md)) rather than letting `feedparser.parse(url)` do it. Choose the polling interval from how often the feed changes, the RSS `<ttl>` element (minutes; feedparser exposes it as `d.feed.ttl`), `Cache-Control` and the syndication module's `updatePeriod`. Feeds that advertise a WebSub hub (`<link rel="hub">`) can push updates instead ([Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md)); details on validators are in [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).

## Parsing with feedparser

```python
import calendar
from datetime import datetime, timezone
import feedparser

def entries(d: feedparser.FeedParserDict):
    if d.bozo:                                       # not well-formed; feedparser still extracts what it can
        print("feed problem:", type(d.bozo_exception).__name__)
    for e in d.entries:
        ts = e.get("published_parsed") or e.get("updated_parsed")    # struct_time in UTC
        yield {
            "id": e.get("id") or e.get("link"),
            "url": e.get("link"),
            "title": e.get("title"),
            "published": datetime.fromtimestamp(calendar.timegm(ts), tz=timezone.utc) if ts else None,
            "published_raw": e.get("published") or e.get("updated"),
            "author": e.get("author"),
            "summary": e.get("summary"),
            "content": [c.value for c in e.get("content", [])],     # content:encoded or Atom content
            "tags": [t.term for t in e.get("tags", [])],
            "enclosures": [(x.href, x.get("type")) for x in e.get("enclosures", [])],
        }

d = feedparser.parse(b"""<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title>
<item><guid isPermaLink="false">post-1</guid><title>Hello &amp; welcome</title><link>https://blog.example/hello</link>
<pubDate>Mon, 03 Feb 2025 09:00:00 +0100</pubDate></item></channel></rss>""")
print(d.version, list(entries(d)))       # rss20, published 2025-02-03 08:00:00+00:00
```

feedparser normalizes RSS, Atom and RDF into `d.feed` and `d.entries` and reports the format in `d.version` (`rss20`, `atom10`). The `*_parsed` fields are UTC `struct_time`, so convert with `calendar.timegm`, not `time.mktime` (which assumes local time). By default it sanitizes HTML in content (scripts and event handlers are removed) and resolves relative links against the feed's base URL.

## Parsing with lxml and namespaces

```python
from lxml import etree

NS = {
    "atom": "http://www.w3.org/2005/Atom",
    "dc": "http://purl.org/dc/elements/1.1/",
    "content": "http://purl.org/rss/1.0/modules/content/",
}
body = b"""<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom">
<entry><id>tag:ex.example,2025:1</id><link href="https://ex.example/1"/><title>One</title></entry></feed>"""

root = etree.fromstring(body)            # bytes: a str with an encoding declaration raises ValueError
for entry in root.xpath("//atom:entry", namespaces=NS):
    print(entry.xpath("string(atom:id)", namespaces=NS),
          entry.xpath("string(atom:link[@rel='alternate' or not(@rel)]/@href)", namespaces=NS))

print(len(root.xpath("//entry")))                      # 0: unprefixed names do not match a default namespace
print(len(root.xpath("//*[local-name()='entry']")))    # 1: works, but ignores namespaces entirely
```

RSS 2.0 core elements have no namespace, but extensions do (`dc:creator`, `content:encoded`, Media RSS). For very large XML files (big feeds, data dumps) stream with `iterparse` and free memory as you go:

```python
def handle(entry):                                     # your processing
    print(entry.findtext("{http://www.w3.org/2005/Atom}id"))

for _, elem in etree.iterparse("dump.xml", events=("end",), tag="{http://www.w3.org/2005/Atom}entry"):
    handle(elem)
    elem.clear()
    while elem.getprevious() is not None:
        del elem.getparent()[0]                        # drop already-processed siblings
```

## XML security

Untrusted XML can carry external entities that read local files or make network requests (XXE) and nested entities that expand exponentially ("billion laughs"). lxml's parsers default to `no_network=True`, and since lxml 5.0 they resolve only internal entities by default (`resolve_entities='internal'`); pass `resolve_entities=False` and `load_dtd=False` explicitly for hostile input. For the standard library parsers (`xml.etree`, `minidom`, `sax`), use defusedxml, which raises `EntitiesForbidden` on entity declarations; the Python documentation's XML vulnerabilities table lists which attacks each parser is exposed to.

## Pitfalls

- **Unstable ids.** Some publishers change `guid` on every edit or omit it. Deduplicate on `(feed, id)` with a fallback hash of link and title ([Deduplication (URLs and Content)](../crawling/deduplication.md)).
- **Truncated history.** Feeds carry only the latest N items; poll often enough or backfill from sitemaps and archive pages.
- **Dates.** Expect non-RFC formats, missing time zones and localized month names. Keep the raw string; feedparser returns `None` when it cannot parse a date ([Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)).
- **Escaped HTML.** `description` holds escaped HTML; render or clean it deliberately, and never insert it into your own pages unsanitized.
- **Encoding conflicts.** The XML declaration and the HTTP `Content-Type` charset can disagree. Pass raw bytes plus headers and let the parser decide; never decode and re-encode yourself.
- **Summary is not the article.** Fetching the full text from the site is a separate decision with its own terms ([News Sites and RSS](../sources/news-and-rss.md)).
- **Moved feeds.** Follow permanent redirects once and update the stored URL ([Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md)).

## Checklist

- [ ] Discovered feeds from `<link rel="alternate">` before probing paths.
- [ ] Conditional GET with stored ETag and Last-Modified; polling interval tuned per feed.
- [ ] Entries deduplicated by id with a fallback key; raw date strings kept.
- [ ] Namespaces bound explicitly when using XPath; bytes passed to lxml.
- [ ] Untrusted XML parsed with entities and network access disabled (defusedxml for the standard library).

## See Also

- [News Sites and RSS](../sources/news-and-rss.md)
- [XML Sitemaps](../crawling/sitemaps.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md)
- [XPath for Extraction](xpath.md)
- [Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)
