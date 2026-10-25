---
tags: [scraping, crawling, spider-traps, crawl-hygiene]
aliases: [crawler trap, spider trap, infinite URL space, calendar trap, faceted navigation, tarpit, soft 404]
---

# Spider Traps and Crawl Hygiene

> Sources: Google Search Central, Managing crawling of faceted navigation URLs (https://developers.google.com/search/docs/crawling-indexing/crawling-managing-faceted-navigation); Google Search Central, Large site owner's guide to managing your crawl budget (https://developers.google.com/search/docs/crawling-indexing/large-site-managing-crawl-budget); Google Search Central, HTTP status codes, network and DNS errors (soft 404s) (https://developers.google.com/search/docs/crawling-indexing/http-network-errors); Lee, Leonard, Wang and Loguinov, IRLbot, WWW 2008 (https://doi.org/10.1145/1367497.1367556); Cloudflare documentation, AI Labyrinth (https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/); Olston and Najork, Web Crawling, 2010 (https://doi.org/10.1561/1500000017)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A spider trap is any part of a site that generates an endless, or uselessly large, set of URLs: calendars that page forever, faceted filters whose combinations explode, session ids that mint a new URL per visit, relative links that nest paths deeper on every hop, and soft 404 pages that answer 200 for anything. Most traps are accidents of site design; some are deliberate, such as tarpits and AI-crawler labyrinths aimed at bots that ignore robots.txt and `nofollow`. Crawl hygiene is the layered defense: stay in scope and obey robots rules, reject suspicious URLs before enqueueing them, give each host and each URL pattern a budget, detect repetition in the *content* you fetch, cap response size and total response time, and watch the rate of genuinely new content per host. A crawler with these defenses fails gracefully; one without them can spend days fetching one calendar.

## Trap catalog

| Trap | Symptom | Defense |
|---|---|---|
| Calendars and date archives | `?month=2391-04`, `/events/2099/01/` keeps going | allowed year window; stop on empty pages |
| Faceted navigation | `?color=red&size=9&sort=price` in every combination | parameter allowlist per site, budget per path and parameter set, prefer sitemaps and canonical URLs |
| Session ids in URLs | `;jsessionid=...`, `?sid=8f14e45f...` on every link | strip during normalization ([URL Normalization and Canonicalization](url-normalization.md)), reject if still present |
| Relative-link loops | `/a/b/a/b/a/b/...` from a broken relative link or rewrite rule | repeated-segment and cycle checks, depth limit |
| Soft 404s | any path returns 200 with a "not found" template | probe a random URL once per host and compare content hashes |
| Endless pagination | `?page=99999` returns the last page or the first page again | termination rules and repeat detection ([Pagination Patterns](pagination-patterns.md)) |
| Site search and arbitrary queries | every `q=` value is a new page | do not crawl search unless it is the goal; robots.txt often disallows it |
| Redirect loops and chains | A redirects to B redirects to A | cap redirects (5 to 10), detect loops |
| Tarpits | pages drip-fed a byte at a time, or endless generated text | total-response deadline, size cap, novelty monitoring |
| Duplicate variants | print views, `?lang=`, tracking parameters | normalization and content dedupe ([Deduplication](deduplication.md)) |

## Deliberate traps: tarpits, labyrinths and honeypots

Open-source tarpits such as Nepenthes, Iocaine and HellPot serve endless generated (often Markov-chain) text with links to more of the same, frequently drip-fed slowly to tie up the crawler; they spread quickly as AI crawler traffic grew in 2024 and 2025. Cloudflare's **AI Labyrinth** adds invisible links marked `nofollow` that lead crawlers ignoring crawl directives into AI-generated decoy pages and records the bots that enter. **Honeypot links** hidden from humans (via CSS or the `hidden` attribute) are used to flag bots that follow them.

The common thread: these mostly catch crawlers that ignore robots.txt, `rel="nofollow"` or what a human could see. A crawler that honors robots rules, skips `nofollow` links and does not extract links from hidden elements rarely meets them. If you do land in one, it is a strong signal the site does not want automated access; stop and reconsider rather than tuning around it (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

## Code: pre-enqueue trap checks

Python 3.11 with `httpx`. `TrapGuard.check(url)` returns a reason string for a suspicious URL, or `None`. It has two budgets: a tight one for variants of the *same path* that differ only in query values (facets), and a generous one for paths that differ only in numbers (endless `/page/N/` sequences). Raise the numeric budget for sites with genuinely large catalogs, or allowlist known-good templates. In tests it flagged out-of-range calendar dates, `/a/b/a/b/a/b`, deep paths, session ids and facet explosions while passing ordinary detail pages, archives and base64 pagination cursors.

```python
import hashlib
import re
import uuid
from collections import Counter
from datetime import date
from urllib.parse import parse_qsl, urlsplit

import httpx

DATE_IN_URL = re.compile(r"(?<!\d)((?:19|20|21)\d{2})[-/_.](0[1-9]|1[0-2])(?!\d)")  # 2031-01, 2031/01
YEAR_SEGMENT = re.compile(r"^(19|20|21)\d{2}$")
DATE_KEYS = {"year", "y", "date", "month", "day", "cal", "from", "to", "start", "end", "d"}
SESSION_KEYS = {"sid", "session", "sessionid", "phpsessid", "jsessionid", "aspsessionid",
                "cfid", "cftoken", "zenid", "oscsid"}
HEX_ID = re.compile(r"^[0-9a-fA-F]{32,}$")                  # md5/sha-style session ids


def query_template(url: str) -> str:
    """Same path, same parameter names: /shoes?color=red&size=9 -> ex.test/shoes?color,size."""
    p = urlsplit(url)
    keys = ",".join(sorted({k for k, _ in parse_qsl(p.query, keep_blank_values=True)}))
    return f"{p.hostname}{p.path}?{keys}"


def path_template(url: str) -> str:
    """Numbers collapsed: /page/7/ -> ex.test/page/{n}/ (catches runaway numeric sequences)."""
    p = urlsplit(url)
    return f"{p.hostname}{re.sub(r'[0-9]+', '{n}', p.path)}"


class TrapGuard:
    """Cheap pre-enqueue checks; returns a reason string when a URL looks like a trap."""

    def __init__(self, max_len=2000, max_depth=12, max_params=8, max_query_variants=200,
                 max_path_variants=50_000, years=(1995, date.today().year + 1)):
        self.max_len, self.max_depth, self.max_params = max_len, max_depth, max_params
        self.max_query_variants, self.max_path_variants = max_query_variants, max_path_variants
        self.min_year, self.max_year = years
        self.seen_templates: Counter = Counter()

    def _years(self, path: str, params: list[tuple[str, str]]) -> list[int]:
        found = [int(m.group(1)) for m in DATE_IN_URL.finditer(path)]
        found += [int(s) for s in path.split("/") if YEAR_SEGMENT.match(s)]
        for k, v in params:
            if k.lower() in DATE_KEYS:
                found += [int(m.group(0)) for m in re.finditer(r"(?<!\d)(?:19|20|21)\d{2}(?!\d)", v)]
        return found

    def check(self, url: str) -> str | None:
        p = urlsplit(url)
        if len(url) > self.max_len:
            return "url too long"
        segments = [s for s in p.path.split("/") if s]
        if len(segments) > self.max_depth:
            return "path too deep"
        if segments and Counter(segments).most_common(1)[0][1] >= 3:
            return "repeated path segment"                       # /a/b/a/b/a/...
        if len(segments) >= 4 and segments[-2:] == segments[-4:-2]:
            return "path cycle"
        params = parse_qsl(p.query, keep_blank_values=True)
        if len(params) > self.max_params:
            return "too many query parameters"
        if any(k.lower() in SESSION_KEYS or HEX_ID.match(v) for k, v in params) \
                or ";jsessionid=" in p.path.lower():
            return "session id in URL"
        if any(not self.min_year <= y <= self.max_year for y in self._years(p.path, params)):
            return "calendar date out of range"
        for key, limit in ((query_template(url), self.max_query_variants),
                           (path_template(url), self.max_path_variants)):
            self.seen_templates[key] += 1
            if self.seen_templates[key] > limit:
                return f"variant budget exhausted for {key}"   # facets, endless pages
        return None


async def soft_404_signature(client: httpx.AsyncClient, origin: str) -> str | None:
    """Fetch a URL that cannot exist. If the site answers 200, return a hash of that page
    so later 200 responses with the same hash can be treated as 'not found'."""
    r = await client.get(f"{origin}/{uuid.uuid4().hex}/{uuid.uuid4().hex}.html")
    if r.status_code != 200:
        return None                                          # site returns real 404s
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", r.text))
    return hashlib.sha256(text.encode()).hexdigest()
```

Feed the guard's reasons into your metrics: a host where most rejections are "variant budget exhausted" needs a parameter allowlist, not a bigger budget.

## Content-based detection

URL rules miss traps whose URLs look normal. After fetching, check the content:

- **Soft 404 signature**: compare each 200 response's normalized hash with the host's probe signature from `soft_404_signature`; matches are "not found".
- **Novelty rate**: track the share of new content hashes (or SimHash clusters) among the last few hundred fetches per host or per template. When it drops near zero, pause expansion of that host or template and alert; you are recrawling the same page under new names.
- **Link fan-out**: a page that yields thousands of new same-host links, or a template whose pages each add more URLs than they consume, is expanding faster than any real site grows.

IRLbot (WWW 2008) went further and tied each domain's crawl budget to its reputation, measured by links from other domains, so spam farms and infinite sites could not absorb the crawl however many URLs they generated.

## Resource limits

Timeouts in most HTTP clients are per operation: httpx's read timeout is the maximum wait for the *next chunk*, so a server that sends one byte every few seconds never trips it. Put a deadline on the whole response and cap its size:

```python
import asyncio

import httpx


async def fetch_with_deadline(client: httpx.AsyncClient, url: str,
                              deadline: float = 30.0, max_bytes: int = 5_000_000) -> tuple[int, bytes]:
    """Whole-response time budget plus size cap; raises TimeoutError past the deadline."""
    buf = bytearray()
    async with asyncio.timeout(deadline):            # Python 3.11+
        async with client.stream("GET", url) as r:
            async for chunk in r.aiter_bytes():
                buf += chunk
                if len(buf) > max_bytes:
                    break                            # size cap: record the page as truncated
    return r.status_code, bytes(buf)
```

Tested against a mock server sending one byte every 0.3 seconds with a 1 second read timeout: without the outer deadline the request would have taken 30 seconds; with it the fetch was cancelled at 2 seconds. Also cap redirects, pages per host per crawl, depth and total crawl size.

## Pitfalls

- Relying only on a depth limit: facets and calendars stay shallow while exploding sideways.
- One global "URL template" budget that also throttles legitimate detail pages; separate query-variant budgets from numeric-path budgets.
- Normalizing session ids away but still following the links that generate new ones.
- Treating every 200 as success; soft 404s and block pages look like content.
- Following hidden or `nofollow` links, which is how honeypots and labyrinths find you.
- Read timeouts without a total deadline, letting tarpits hold workers forever.
- No novelty metric, so a trap is discovered from the cloud bill.

## Checklist

- [ ] Scope rules, robots.txt and `nofollow` honored; links in hidden elements skipped.
- [ ] URL checks before enqueue: length, depth, repeated segments, cycles, session ids, date window, parameter count.
- [ ] Separate budgets per query-variant template and per numeric-path template; per-site allowlists for facets.
- [ ] Soft 404 probe per host; content hashes compared against it.
- [ ] Novelty rate and link fan-out monitored per host and template, with automatic pause and alert.
- [ ] Total-response deadline, size cap and redirect cap on every fetch.

## See Also

- [URL Normalization and Canonicalization](url-normalization.md)
- [Deduplication (URLs and Content)](deduplication.md)
- [Pagination Patterns](pagination-patterns.md)
- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [robots.txt (RFC 9309)](robots-txt.md)
- [How Bot Detection Works](../anti-bot/how-bot-detection-works.md)
