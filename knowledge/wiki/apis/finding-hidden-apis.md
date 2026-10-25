---
tags: [scraping, apis, devtools, hidden-apis, json-endpoints]
aliases: [hidden API, undocumented API, internal API, XHR endpoint, JSON endpoint, copy as cURL]
---

# Finding Hidden APIs with DevTools

> Sources: Chrome DevTools, Network features reference (https://developer.chrome.com/docs/devtools/network/reference); Firefox DevTools, Network Monitor (https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/); Jan Odvarko, HAR 1.2 specification (http://www.softwareishard.com/blog/har-12-spec/); WordPress REST API Handbook (https://developer.wordpress.org/rest-api/); curlconverter (https://github.com/curlconverter/curlconverter); Van Buren v. United States, 593 U.S. 374 (2021) (https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most modern sites render pages in the browser from JSON that their own frontend fetches. The Network panel of browser DevTools shows those requests, and replaying one directly often replaces brittle HTML parsing or an expensive headless browser with a single clean JSON call. The workflow: record the page's traffic, find the request whose response contains the data you see, copy it as cURL, reproduce it outside the browser, strip it down to the parameters and headers that matter, then page through it politely with an honest User-Agent. "Hidden" does not mean "public" or "permitted": the endpoint is still the site's infrastructure, its terms still apply, and anything behind a login, a signature or an anti-bot token is an access control to respect, not a puzzle to solve. Prefer a documented API whenever one exists, and expect undocumented endpoints to change without notice.

## Check the easy places first

1. **A documented API or bulk export**, which comes with terms and limits ([Catalog of Useful Open APIs](official-apis-catalog.md), [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
2. **Data already embedded in the HTML**: `<script id="__NEXT_DATA__">`, `window.__INITIAL_STATE__`, `application/ld+json` blocks. One page fetch, no extra endpoint ([JSON and Embedded Data](../parsing/json-and-embedded-data.md), [Structured Data](../parsing/structured-data-schema-org.md)).
3. **Feeds and sitemaps** ([XML Sitemaps](../crawling/sitemaps.md)).
4. **Platform endpoints that are public by design**: WordPress sites usually expose the documented REST API at `/wp-json/wp/v2/posts` (at most 100 items per page, totals in the `X-WP-Total` and `X-WP-TotalPages` headers); hosted job boards such as Greenhouse and Lever publish job JSON for their customers' career pages ([Job Postings](../sources/job-postings.md)).

## The DevTools workflow

1. Open DevTools **before** loading the page, go to the Network panel, enable **Preserve log** and **Disable cache**, then reload.
2. Filter to **Fetch/XHR**. Trigger the behavior that loads the data: scroll, change a filter, open page 2, type in search.
3. **Search the recorded traffic** for a value you can see on the page (a price, an id, a unique title). The Network panel's search covers URLs, headers and response bodies, which finds the right request in seconds.
4. Inspect the request: **Headers** (URL, method, query parameters, request headers), **Payload** (POST body, often JSON or GraphQL), **Preview/Response**, and **Initiator** (which script sent it, useful for finding how parameters are built).
5. Right-click, **Copy as cURL** (or Copy as fetch) and run it in a terminal to confirm it works outside the page ([curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md)). curlconverter translates the command into Python, JavaScript and other languages.
6. For multi-step flows, export a **HAR** file. HAR files contain cookies, tokens and personal data: sanitize them before sharing or committing them anywhere.

More panel details are in [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md); capturing the same traffic programmatically is in [Network Interception and Response Capture](../browser-automation/network-interception.md).

## Reading what you found

- **Parameters**: page, offset, cursor, limit, sort, filters, locale, currency. Change one at a time and watch the response. Pagination rules are in [Pagination Patterns](../crawling/pagination-patterns.md).
- **Headers that matter**: `Accept`, sometimes `X-Requested-With`, a `Referer` or `Origin`, an API key header, a CSRF token. Many copied headers (`sec-ch-ua`, `sec-fetch-*`, analytics cookies) are irrelevant.
- **State**: does the request need a session cookie? A short-lived token from another request? A per-request signature or hash computed in JavaScript?
- **GraphQL**: a single `/graphql` endpoint with an operation name and often a persisted-query hash ([GraphQL Endpoints](graphql.md)).
- **Third-party services**: search boxes often call a hosted search provider directly from the browser with a search-only key that belongs to the site. Using that key for your own workload runs up the site owner's bill and usually breaks the provider's terms.

## Replaying outside the browser

Start from the working copied request, then minimize it so you know exactly what the endpoint depends on. The helper below drops one header at a time and keeps the removal whenever the status and the JSON structure stay the same. In a test against a mock endpoint, eight copied headers (including a session cookie) reduced to the two it actually required.

```python
import asyncio

import httpx


def shape(data):
    """Structural fingerprint of a JSON document: keys and value types, not values."""
    if isinstance(data, dict):
        return {k: shape(v) for k, v in sorted(data.items())}
    if isinstance(data, list):
        return [shape(data[0])] if data else []
    return type(data).__name__


async def minimal_headers(client: httpx.AsyncClient, method: str, url: str, headers: dict[str, str],
                          body: bytes | None = None, pause_s: float = 2.0) -> dict[str, str]:
    """Drop copied headers one at a time while the response keeps its status and JSON shape.

    Every probe is a real request to someone else's server: keep the pause, run it once,
    and save the result instead of re-running it.
    """
    async def probe(h: dict[str, str]):
        r = await client.request(method, url, headers=h, content=body)
        await asyncio.sleep(pause_s)
        try:
            return r.status_code, shape(r.json())
        except ValueError:
            return r.status_code, None

    baseline = await probe(headers)
    if baseline[0] != 200 or baseline[1] is None:
        raise ValueError(f"baseline did not return JSON 200: {baseline[0]}")
    needed = dict(headers)
    for name in list(headers):
        trial = {k: v for k, v in needed.items() if k != name}
        if await probe(trial) == baseline:
            needed = trial                       # this header was not needed
    return needed
```

Then build the real client: your own descriptive User-Agent instead of the copied browser string ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)), only the required headers, parameters for paging and filters, and per-host rate limits ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)):

```python
import asyncio

import httpx

HEADERS = {
    "User-Agent": "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)",
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",          # whatever minimal_headers() kept
}


async def products(client: httpx.AsyncClient, base: str, delay_s: float = 2.0):
    page = 1
    while True:
        r = await client.get(f"{base}/api/products", params={"page": page, "per_page": 48})
        r.raise_for_status()
        items = r.json()["items"]
        if not items:
            return
        for item in items:
            yield item
        page += 1
        await asyncio.sleep(delay_s)                   # same pace as a person paging the site


# async with httpx.AsyncClient(headers=HEADERS, timeout=30) as client:
#     async for p in products(client, "https://shop.example.com"): ...
```

Keep the page size the frontend uses, or modestly larger; asking an internal endpoint for 10,000 rows per call can be far more expensive for the server than many small pages.

## Where the line is

| Fine | Ask first or reconsider | Do not |
|---|---|---|
| Unauthenticated endpoints the page calls for every visitor | Endpoints the page does not use, larger page sizes, bulk date ranges | Endpoints that need a login you do not have, or other people's tokens |
| Data you could see on the page anyway | Use the terms prohibit, or volumes far beyond normal browsing | Forging or replaying anti-bot tokens, request signatures or proof-of-work |
| Honest User-Agent, human-like pace, caching | Commercial reuse of data the site licenses from others | Reimplementing a site's signing code to mint valid requests |
| Fields you need | Personal data, even if visible | Collecting personal fields the UI never shows; using the site's third-party API keys |

If replaying only works with a forged browser identity, a solved challenge or a copied session token, the site has drawn a boundary. Stop, look for an official API or licensed dataset, or ask the operator for access (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

## Legal notes (not legal advice)

An undocumented endpoint is not an invitation. Terms of service can prohibit automated access or reuse, and registering or logging in usually means you agreed to them ([Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)). In the US, *Van Buren v. United States* (2021) read the federal anti-hacking statute narrowly, as a question of whether you accessed parts of a system that are off limits to you, so circumventing authentication remains the clearest risk ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)). Internal APIs also tend to return more fields than the page shows, including personal data, which brings data-protection duties regardless of how "public" it looked ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Maintenance

Undocumented endpoints change with every frontend deploy: renamed fields, new required parameters, rotated persisted-query hashes. Validate responses against a schema, keep raw responses for re-parsing, and run a small canary request on a schedule so breakage is detected before the main job ([Testing Scrapers](../data-quality/testing-scrapers.md), [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)).

## Pitfalls

- Hunting in DevTools before checking for a documented API or embedded JSON.
- Shipping the copied browser User-Agent and cookies in production instead of minimizing and identifying yourself.
- Hard-coding short-lived tokens or persisted-query hashes copied from your browser session.
- Replaying at machine speed because "it is just JSON"; it is still someone's server.
- Storing every field the endpoint returns, including personal data you do not need.
- Committing HAR files with live cookies to a repository.

## Checklist

- [ ] No documented API, bulk export, feed or embedded JSON covers the need.
- [ ] Request found via Network search, reproduced with cURL, minimized to required headers.
- [ ] Endpoint is unauthenticated and used by the public page; no tokens, signatures or challenges involved.
- [ ] Terms reviewed; honest User-Agent; per-host rate limit and caching in place.
- [ ] Only needed fields stored; personal data minimized.
- [ ] Schema validation, raw archive and a canary check for breakage.

## See Also

- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [JSON and Embedded Data](../parsing/json-and-embedded-data.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
- [GraphQL Endpoints](graphql.md)
- [Mobile App APIs](mobile-app-apis.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
