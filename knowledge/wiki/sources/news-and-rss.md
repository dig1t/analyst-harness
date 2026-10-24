---
tags: [scraping, sources, news, rss, article-extraction]
aliases: [news scraping, RSS scraping, news feeds, article extraction]
---

# News Sites and RSS

> Sources: RSS 2.0 Specification, RSS Advisory Board (https://www.rssboard.org/rss-specification); RFC 4287, The Atom Syndication Format (https://www.rfc-editor.org/rfc/rfc4287); W3C WebSub Recommendation (https://www.w3.org/TR/websub/); Google Search Central, News sitemaps (https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap); Google Search Central, Structured data for subscription and paywalled content (https://developers.google.com/search/docs/appearance/structured-data/paywalled-content); Barbaresi 2021, Trafilatura, ACL-IJCNLP 2021 System Demonstrations (https://aclanthology.org/2021.acl-demo.15/); Common Crawl, CC-NEWS dataset announcement (https://commoncrawl.org/blog/news-dataset-available); GDELT Project (https://www.gdeltproject.org/); Directive (EU) 2019/790, Article 15 (https://eur-lex.europa.eu/eli/dir/2019/790/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

News is one of the easiest sources to acquire politely and one of the easiest to get wrong legally. Almost every publisher exposes machine-readable discovery: RSS or Atom feeds, XML sitemaps (often a dedicated news sitemap covering the last two days), and `NewsArticle` JSON-LD on article pages. A good pipeline polls feeds and sitemaps with conditional requests, fetches only new or changed article URLs, takes metadata from structured data, and extracts body text with a main-content extractor. Paywalls are access controls: respect them and license what you need beyond the free portion. Article text is copyrighted even when the facts in it are not, and in the EU press publishers hold an additional right over online uses of their publications.

## Acquisition routes, best first

1. **Licensed feeds and publisher APIs.** Wire services and many publishers license full-text feeds. Some publishers run developer APIs with keys and daily quotas (for example The Guardian Open Platform and the New York Times developer APIs). Their terms usually restrict commercial use, storage duration and redistribution, and quotas differ per API, so read the current developer portal instead of hard-coding a number.
2. **Research corpora.** For historical or large-scale work, Common Crawl's CC-NEWS dataset publishes daily WARC files of news articles (since 2016, under `crawl-data/CC-NEWS/`), and GDELT publishes global news metadata that updates every 15 minutes. Both spare you from crawling thousands of sites. See [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md).
3. **RSS and Atom feeds.** The cheapest change signal. Discover them through `<link rel="alternate" type="application/rss+xml">` (or `application/atom+xml`) in the page head, through common paths such as `/feed/` or `/rss`, and through section pages that list per-topic feeds. Details on formats are in [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md).
4. **Sitemaps and news sitemaps.** Find them in `robots.txt` (`Sitemap:` lines). Google's news sitemap rules say a news sitemap should only list articles created in the last two days and may hold up to 1,000 `news:news` entries, so it is a near real-time list of fresh URLs with titles and publication dates. Regular sitemaps with `lastmod` cover the archive. See [XML Sitemaps](../crawling/sitemaps.md).
5. **Article pages.** Fetch the article, read JSON-LD (`NewsArticle`: `headline`, `datePublished`, `dateModified`, `author`, `publisher`, `isAccessibleForFree`), OpenGraph tags and the canonical link, then extract the body text.

## Polling feeds politely

Feeds are polled, so the cost is in repetition. Send `If-None-Match` with the stored `ETag` and `If-Modified-Since` with the stored `Last-Modified`; a `304 Not Modified` costs the publisher almost nothing. Adapt the interval to the observed publishing rate (a feed that changes twice a day does not need a poll every minute) and treat the RSS `<ttl>` element as a hint. If a feed declares a WebSub hub (`<link rel="hub">`), subscribe and receive pushes instead of polling; see [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md).

```python
import json, pathlib
import feedparser, httpx, trafilatura

UA = "ExampleNewsBot/1.0 (+https://example.org/bot; bot@example.org)"
STATE = pathlib.Path("feed_state.json")

def poll(feed_url: str) -> list[dict]:
    """Return new entries since the last poll, using conditional GET."""
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    prev = state.get(feed_url, {"seen": []})
    headers = {"User-Agent": UA}
    if prev.get("etag"):
        headers["If-None-Match"] = prev["etag"]
    if prev.get("modified"):
        headers["If-Modified-Since"] = prev["modified"]
    r = httpx.get(feed_url, headers=headers, timeout=30, follow_redirects=True)
    if r.status_code == 304:
        return []
    r.raise_for_status()
    seen = set(prev.get("seen", []))
    new = []
    for e in feedparser.parse(r.content).entries:
        key = e.get("id") or e.get("link")
        if key and key not in seen:
            new.append({"id": key, "url": e.get("link"), "title": e.get("title"),
                        "published": e.get("published")})
            seen.add(key)
    state[feed_url] = {"etag": r.headers.get("ETag"), "modified": r.headers.get("Last-Modified"),
                       "seen": sorted(seen)[-5000:]}
    STATE.write_text(json.dumps(state))
    return new

def extract(url: str) -> dict | None:
    """Fetch one article and return text plus metadata (title, date, author...)."""
    html = httpx.get(url, headers={"User-Agent": UA}, timeout=30, follow_redirects=True).text
    doc = trafilatura.extract(html, url=url, output_format="json", with_metadata=True)
    return json.loads(doc) if doc else None
```

## Article extraction

Prefer structured data for metadata and a main-content extractor for the body. Trafilatura, Mozilla Readability and similar tools strip navigation, ads and related-link blocks; in the Trafilatura author's published evaluation (2021, 500 documents) it scored an F-score of about 0.91, ahead of the other open-source tools tested. Benchmarks on your own sources matter more than published numbers, so keep a small labeled set per publisher. See [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md) for tool trade-offs.

Store per article: canonical URL, publisher, section, headline, byline, `datePublished` and `dateModified` in UTC, language, body text, word count, paywall flag, and the raw HTML in an archive so you can re-parse later ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)). Articles change after publication (corrections, live updates), so keep revisions keyed by URL plus content hash rather than overwriting.

## Paywalls and access

Publishers mark paywalled content for search engines with `isAccessibleForFree: false` and a `hasPart` `WebPageElement` whose `cssSelector` points at the locked section. Treat that markup as a statement of intent: keep metadata and the freely visible teaser, and get a subscription or a license (and read its terms on automated use) if you need the full text. Do not use workarounds that sidestep the paywall, such as pretending to be a search engine crawler, resetting metering cookies or reading third-party mirrors of paywalled pages. That is circumventing an access control and it breaks the terms you accepted. The same applies to registration walls.

## Legal and personal-data notes

- **Copyright.** Facts are free, expression is not. Headlines, short snippets and links are the usual safe zone for display; full-text redistribution needs a license. See [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).
- **EU press publishers' right.** Article 15 of Directive 2019/790 gives publishers rights over online use of their press publications for two years (counted from 1 January of the year after publication); hyperlinks and individual words or very short extracts are excluded. National implementations differ.
- **AI and TDM opt-outs.** Many news sites block AI crawlers and reserve text and data mining rights. If your use is model training or dataset building, read [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md).
- **People in the news.** Articles are full of personal data. Journalism exemptions in data protection law are national and tied to journalistic purposes; they do not automatically cover an analytics pipeline. Minimize what you keep about individuals.

## Pitfalls

- Feeds often carry only summaries; the full text needs a page fetch.
- GUIDs change or get reused; deduplicate on canonical URL plus content hash.
- RSS dates use RFC 822 style, Atom uses RFC 3339, and some feeds omit time zones. Normalize to UTC and keep the original string.
- EU consent walls and interstitials return a consent page instead of the article. Validate that the extracted title matches the feed title and that the body is not suspiciously short.
- Paywall teasers get stored as if they were full articles. Check `isAccessibleForFree` and length.
- Wire stories appear on dozens of sites; use near-duplicate detection ([Deduplication (URLs and Content)](../crawling/deduplication.md)).
- AMP, mobile and print URLs duplicate the canonical page; follow `rel=canonical`.
- Live blogs, galleries and video pages break article extractors; detect and route them separately.

## Checklist

- [ ] Checked for a licensed feed, publisher API or research corpus first.
- [ ] Feed and sitemap discovery done; polling uses ETag and Last-Modified.
- [ ] Poll interval adapted per feed; WebSub used where offered.
- [ ] Metadata from JSON-LD and canonical links; body from a tested extractor.
- [ ] Paywall markup respected; no workaround techniques.
- [ ] Revisions kept; raw HTML archived; duplicates collapsed.
- [ ] Copyright, press publishers' right and AI opt-outs reviewed for the intended use.

## See Also

- [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md)
- [XML Sitemaps](../crawling/sitemaps.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
- [Deduplication (URLs and Content)](../crawling/deduplication.md)
