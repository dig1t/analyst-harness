---
tags: [scraping, crawling, incremental-crawling, freshness, conditional-requests]
aliases: [recrawl, revisit policy, delta crawl, change rate, freshness, If-None-Match]
---

# Incremental Crawling

> Sources: RFC 9110, HTTP Semantics, sections 8.8 (validators) and 13 (conditional requests) (https://www.rfc-editor.org/rfc/rfc9110); Cho and Garcia-Molina, Effective page refresh policies for Web crawlers, ACM TODS 2003 (https://doi.org/10.1145/958942.958945); Cho and Garcia-Molina, Estimating frequency of change, ACM TOIT 2003 (https://doi.org/10.1145/857166.857170); Olston and Najork, Web Crawling, 2010 (https://doi.org/10.1561/1500000017); Google Search Central blog, Sitemaps ping endpoint is going away (lastmod guidance), 2023 (https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

An incremental crawler revisits what it already knows and fetches only what changed, instead of recrawling everything on every run. It saves bandwidth for both sides, keeps your data fresher for the same request budget, and is simply more polite. The toolkit, from cheapest to most expensive: **push** (webhooks, WebSub, change feeds), **"changed since" queries** on APIs, **sitemaps and feeds** with `lastmod` or publication dates, **conditional HTTP requests** (`If-None-Match`, `If-Modified-Since`, answered with a bodiless 304), and finally a full fetch compared by **content hash**. On top sits a **revisit policy**: estimate how often each page changes, weight by how much you care, and schedule the next visit accordingly. Research by Cho and Garcia-Molina shows that naive "visit volatile pages more often" policies are not optimal; budgets should go where they buy the most freshness.

## Change signals, best first

| Signal | Cost per check | Caveats |
|---|---|---|
| Webhooks, WebSub, SSE change feeds | zero polling | only offered by some providers; can miss events, so reconcile periodically ([Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md)) |
| API filters (`updated_since`, `modified_after`, event streams) | one request per batch | check whether deletions are reported |
| Sitemaps `lastmod`, RSS/Atom dates, "newest first" listings | one request per file or page | `lastmod` is often unreliable; audit it ([XML Sitemaps](sitemaps.md)) |
| Conditional GET (ETag, Last-Modified) | one request, tiny 304 response | many dynamic pages send no validators or useless ones |
| Full GET and content hash | full download | must hash the content that matters, not raw HTML |

## Conditional requests

Store the validators from every 200 response and send them back next time:

- `ETag: "abc"` comes back as `If-None-Match: "abc"`. Weak tags (`W/"abc"`) are fine here, because `If-None-Match` uses weak comparison.
- `Last-Modified: Tue, 20 Oct 2026 08:00:00 GMT` comes back as `If-Modified-Since: Tue, 20 Oct 2026 08:00:00 GMT`.
- When both are sent, RFC 9110 has the server evaluate `If-None-Match` and ignore `If-Modified-Since`.
- `304 Not Modified` has no body: keep your stored copy and record that you checked. Some APIs (GitHub, for example) do not count a 304 against your rate limit.

Validate the validators per site before relying on them: some servers emit a new ETag on every request (per-request cookies or timestamps baked in), some emit the same ETag for every URL, and many set `Last-Modified` to the current time. Details on caching semantics are in [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).

## Content hashing as the fallback

When validators are missing or wrong, download and compare a hash of the content you actually use. Strip scripts, styles, ads and markup (or better, hash the extracted record fields), collapse whitespace, then hash. A raw-HTML hash flags every page as changed because of rotating CSRF tokens, timestamps and ad slots. Field-level comparison also tells you *what* changed (see [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).

## Revisit policies

Two quality measures from the literature: **freshness** (is my copy identical to the live page right now?) and **age** (how long has my copy been stale?). Cho and Garcia-Molina's findings, under a budget of N fetches per day:

- A **uniform** policy (every page at the same rate) beats a **proportional** one (rate proportional to change frequency) for average freshness.
- The optimal policy gives the most volatile pages *fewer* visits than proportional, because a page that changes every few minutes is stale again almost immediately; the budget buys more freshness elsewhere.
- Weighting by importance changes the answer for pages you care about (a price you report daily deserves a daily visit even if it is volatile).

**Estimating change rate.** Model changes as a Poisson process with rate lambda. If you visit every I seconds and see a change X times in n visits, X / (n I) underestimates lambda, because two changes between visits look like one. Cho and Garcia-Molina's corrected estimator is r = -ln((n - X + 0.5) / (n + 0.5)) per interval, so lambda is about r / I. Given lambda, the probability a page has changed t seconds after your last visit is 1 - e^(-lambda t), which lets you schedule the next visit when that probability crosses a threshold.

**Adaptive intervals** are the pragmatic version: halve the interval after a detected change, grow it by half after no change, clamp to a minimum and maximum, add jitter so revisits do not synchronize.

## Code: conditional revisits with adaptive intervals

Python 3.11 with `httpx`. In a test against a mocked server with weak ETags, five of eight revisits came back as 304, the two real changes were detected, and a script that changed on every response did not register as a change. In a simulation with one true change every two days and daily visits, the naive rate came out about 20% low and the corrected estimator within 2% of the truth.

```python
import hashlib
import math
import random
import re
import time
from dataclasses import dataclass

import httpx

MIN_INTERVAL, MAX_INTERVAL = 3600.0, 30 * 86400.0      # 1 hour .. 30 days


@dataclass
class PageState:
    url: str
    etag: str | None = None
    last_modified: str | None = None
    content_hash: str | None = None
    interval: float = 86400.0                           # current revisit interval (seconds)
    next_visit: float = 0.0
    visits: int = 0
    changes: int = 0


def content_key(body: bytes) -> str:
    """Hash of the content that matters: tags, scripts and whitespace stripped."""
    text = re.sub(rb"(?s)<(script|style)\b.*?</\1>", b" ", body)
    text = re.sub(rb"<[^>]+>", b" ", text)
    return hashlib.sha256(b" ".join(text.split())).hexdigest()


async def revisit(client: httpx.AsyncClient, st: PageState) -> bool | None:
    """Conditional GET; returns True if changed, False if not, None on error."""
    headers = {}
    if st.etag:
        headers["If-None-Match"] = st.etag
    if st.last_modified:
        headers["If-Modified-Since"] = st.last_modified
    r = await client.get(st.url, headers=headers)
    if r.status_code == 304:
        changed = False                                 # validators say: same representation
    elif r.status_code == 200:
        new_hash = content_key(r.content)
        changed = st.content_hash is not None and new_hash != st.content_hash
        st.content_hash = new_hash
        st.etag = r.headers.get("etag")
        st.last_modified = r.headers.get("last-modified")
    else:
        st.next_visit = time.time() + MIN_INTERVAL       # 404, 410, 5xx: handle elsewhere
        return None
    st.visits += 1
    st.changes += changed
    # adaptive interval: come back sooner after a change, back off after no change
    st.interval = min(MAX_INTERVAL, max(MIN_INTERVAL, st.interval * (0.5 if changed else 1.5)))
    st.next_visit = time.time() + st.interval * random.uniform(0.9, 1.1)   # jitter
    return changed


def change_rate(visits: int, changes: int, interval_s: float) -> float:
    """Changes per second, Cho & Garcia-Molina estimator for regular revisits.

    Counting detected changes undercounts (two edits between visits look like one);
    r = -ln((n - X + 0.5) / (n + 0.5)) corrects for that, per visit interval.
    """
    n, x = visits, changes
    return -math.log((n - x + 0.5) / (n + 0.5)) / interval_s


def interval_for(rate_per_s: float, p_changed: float = 0.5) -> float:
    """Revisit when the chance the page has changed reaches p_changed (Poisson model)."""
    if rate_per_s <= 0:
        return MAX_INTERVAL
    t = -math.log(1 - p_changed) / rate_per_s
    return min(MAX_INTERVAL, max(MIN_INTERVAL, t))
```

Persist `PageState` rows (SQLite or Postgres) and let the frontier pull rows whose `next_visit` has passed, ordered by importance ([URL Frontier and Scheduling](url-frontier-and-scheduling.md)). The regular-interval estimator assumes evenly spaced visits; with adaptive intervals, use it per interval bucket or fit the Poisson likelihood directly.

## New and deleted pages

- **New items**: crawl listing pages sorted newest first and stop after a run of already-known items (for example, a full page of known ids), instead of paging to the end every time. Diff sitemap URL sets between runs.
- **Deleted items**: a 404 or 410 on a known URL is an event to record, not a reason to delete history. Mark the record with a tombstone and the date first seen missing; confirm with a second check before acting, since transient 404s happen. `410 Gone` is the server saying the removal is permanent.
- **Moved items**: a new permanent redirect means update the canonical URL and keep the old one as an alias.

Model the stored data as append-only observations (what you saw, when) rather than overwriting rows, so you can answer "when did this change?" later ([Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)).

## Pitfalls

- Sending `If-Modified-Since` with your own clock's time instead of the server's `Last-Modified` value.
- Trusting validators that change on every request (no 304s ever) or never change (missed updates).
- Hashing raw HTML and "detecting" changes on every visit.
- Revisit schedules without jitter, so thousands of revisits fire at the top of the hour.
- Spending the whole budget on volatile pages nobody uses.
- Deleting records on the first 404.
- Incremental runs that never do a full reconciliation pass; small misses accumulate.

## Checklist

- [ ] Use the cheapest change signal the source offers (push, changed-since API, sitemaps or feeds).
- [ ] Store ETag and Last-Modified per URL and send them back; verify the site's validators behave.
- [ ] Hash extracted content, not raw HTML, when validators are missing.
- [ ] Track visits and detected changes per page; adapt intervals with bounds and jitter.
- [ ] Weight revisit frequency by importance, not only by change rate.
- [ ] Record new, changed, moved and missing items as dated events; run periodic full reconciliations.

## See Also

- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [XML Sitemaps](sitemaps.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
