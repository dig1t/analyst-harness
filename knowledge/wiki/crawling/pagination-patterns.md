---
tags: [scraping, crawling, pagination, link-header, cursors]
aliases: [paging, cursor pagination, keyset pagination, offset pagination, Link header, next page, seek pagination]
---

# Pagination Patterns

> Sources: RFC 8288, Web Linking (https://www.rfc-editor.org/rfc/rfc8288); GitHub Docs, Using pagination in the REST API (https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api); GitHub Docs, REST API endpoints for search (https://docs.github.com/en/rest/search/search); Relay, GraphQL Cursor Connections Specification (https://relay.dev/graphql/connections.htm); Markus Winand, Use The Index, Luke: No Offset (https://use-the-index-luke.com/no-offset); JSON:API specification, Pagination (https://jsonapi.org/format/#fetching-pagination)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Almost every list you scrape is split into pages, and most scraping bugs in lists are pagination bugs: stopping one page early, looping forever on the last page, or silently skipping items because the data moved while you paged. There are a handful of patterns: **page numbers**, **offset/limit**, **opaque cursors**, **keyset (seek)** parameters, **next links** (in an RFC 8288 `Link` header, the JSON body or the HTML), **GraphQL connections**, and **time-window slicing** for APIs that cap total results. Prefer whatever the server hands you as "next" over URLs you construct, terminate on explicit signals, detect loops, deduplicate by id, and checkpoint your position so a crash does not restart the crawl.

## The patterns

| Pattern | Looks like | Iterate by | Watch out for |
|---|---|---|---|
| Page number | `?page=3&per_page=50` | incrementing `page` | page beyond the end returns page 1 or a 200 with an empty template |
| Offset/limit | `?offset=200&limit=100` | `offset += limit` | items shift when data changes; deep offsets get slow or capped |
| Opaque cursor | `?cursor=eyJpZCI6...`, `next_cursor` in body | sending back the token you received | cursors expire; never decode and edit them |
| Keyset (seek) | `?since_id=981`, `?created_before=...` | last item's sort key | requires a stable, unique sort order |
| Link header | `Link: <...?page=4>; rel="next"` | following `rel="next"` | relative URLs; several rels in one value |
| Next URL in body | `"next": "https://..."`, `@odata.nextLink`, `nextPageToken` | following it verbatim | some bodies return `next` on the final page |
| HTML next link | `<a rel="next">`, "Next" button | link extraction | JavaScript-only pagination (find the API) |
| GraphQL connection | `pageInfo { hasNextPage endCursor }` | `after: endCursor` | see [GraphQL Endpoints](../apis/graphql.md) |
| Time slicing | `?from=...&to=...` | splitting windows | needed when an API caps total results |

GitHub is the canonical `Link` header example:

```http
link: <https://api.github.com/repositories/1300192/issues?page=2>; rel="prev", <https://api.github.com/repositories/1300192/issues?page=4>; rel="next", <https://api.github.com/repositories/1300192/issues?page=515>; rel="last", <https://api.github.com/repositories/1300192/issues?page=1>; rel="first"
```

RFC 8288 rules worth knowing: the target is a URI reference (resolve relative ones against the response URL), `rel` MUST be present and only its first occurrence counts, one `rel` value may contain several space-separated relation types (`rel="next last"`), and relation types compare case-insensitively. `httpx` and `requests` both expose a parsed version as `response.links`.

## Termination: when is the list over?

Use the first signal that applies, in this order:

1. **Explicit end**: no `rel="next"`, `next` is null, cursor is empty, `hasNextPage` is false.
2. **Empty page**.
3. **Reached the declared size**: `page == last`, `offset >= total`.
4. **Short page** (fewer items than requested). Reliable for plain offset APIs, unreliable when the server filters after paging (it may return 7 of 50 and still have more).
5. **Safety nets**: a URL, cursor or page-content hash you have already seen means a loop; a `max_pages` cap ends runaway jobs. Hitting a safety net should raise an alert, not end quietly.

## Consistency while data changes

Offset and page-number pagination are computed against a moving list. If an item is inserted at the top while you page, the item at the page boundary shows up twice; if one is deleted, an item is skipped and you never notice. Mitigations, best first:

- Use **keyset** pagination when offered: `ORDER BY created_at, id` and ask for items after the last `(created_at, id)` you saw. It is also fast at any depth, which is why database people recommend it over `OFFSET`.
- Sort by an immutable key and filter to a snapshot (`created_before=<crawl start>`).
- Deduplicate by id (handles inserts) and reconcile counts against `total` at the end (exposes deletes).
- Re-crawl the first pages at the end of the run to catch late inserts.

## Result caps and time slicing

Many search APIs refuse to page past a fixed depth. GitHub's search API returns at most 1,000 results per query; Elasticsearch-backed services cap `from + size` at `index.max_result_window`, 10,000 by default. To collect more, split the query into time windows (or other partitions such as id ranges or categories) small enough that each stays under the cap, recursively halving any window that is still too large. The `time_windows` helper below does exactly that.

## Code: Python paginators

Python 3.11 with `httpx`; each function was tested against a mocked API, including an insert in the middle of an offset crawl.

```python
import re
from collections.abc import AsyncIterator
from datetime import datetime, timedelta
from urllib.parse import urljoin

import httpx

LINK = re.compile(r'<([^>]*)>([^,<]*(?:"[^"]*"[^,<]*)*)')
PARAM = re.compile(r';\s*([^\s=;]+)\s*=\s*(?:"([^"]*)"|([^\s;,]*))')


def parse_link_header(value: str | None, base: str) -> dict[str, str]:
    """RFC 8288 Link header -> {rel: absolute URL}. A rel may hold several space-separated types."""
    links: dict[str, str] = {}
    for target, params in LINK.findall(value or ""):
        attrs = {k.lower(): (q if q is not None and q != "" else u) for k, q, u in PARAM.findall(params)}
        for rel in attrs.get("rel", "").lower().split():
            links.setdefault(rel, urljoin(base, target))   # first occurrence wins
    return links


async def follow_next_links(client: httpx.AsyncClient, url: str, max_pages: int = 1000) -> AsyncIterator[list]:
    """GitHub-style pagination: follow Link rel="next" until it disappears."""
    seen: set[str] = set()
    for _ in range(max_pages):
        if url in seen:
            raise RuntimeError(f"pagination loop at {url}")
        seen.add(url)
        r = await client.get(url)
        r.raise_for_status()
        yield r.json()
        nxt = parse_link_header(r.headers.get("link"), str(r.url)).get("next")
        if not nxt:
            return
        url = nxt
    raise RuntimeError("max_pages reached; raise the limit or check for a loop")


async def follow_cursor(client: httpx.AsyncClient, url: str, params: dict,
                        cursor_param: str = "cursor", max_pages: int = 10_000) -> AsyncIterator[dict]:
    """Opaque-cursor pagination: send the cursor from the previous page until it is empty."""
    cursors: set[str] = set()
    cursor = None
    for _ in range(max_pages):
        q = dict(params, **({cursor_param: cursor} if cursor else {}))
        r = await client.get(url, params=q)
        r.raise_for_status()
        page = r.json()
        for item in page["items"]:
            yield item
        cursor = page.get("next_cursor")
        if not cursor or not page["items"]:
            return
        if cursor in cursors:
            raise RuntimeError("server returned a cursor twice")
        cursors.add(cursor)
    raise RuntimeError("max_pages reached")


async def follow_offset(client: httpx.AsyncClient, url: str, limit: int = 100,
                        max_items: int = 1_000_000) -> AsyncIterator[dict]:
    """Offset/limit pagination with duplicate suppression (offsets shift when data changes)."""
    seen_ids: set = set()
    offset = 0
    while offset < max_items:
        r = await client.get(url, params={"offset": offset, "limit": limit})
        r.raise_for_status()
        items = r.json()["items"]
        for item in items:
            if item["id"] not in seen_ids:
                seen_ids.add(item["id"])
                yield item
        if len(items) < limit:            # short or empty page: done
            return
        offset += limit


async def time_windows(client: httpx.AsyncClient, url: str, start: datetime, end: datetime,
                       cap: int = 1000) -> AsyncIterator[tuple[datetime, datetime]]:
    """Split [start, end) until each window has fewer results than the API's cap."""
    r = await client.get(url, params={"from": start.isoformat(), "to": end.isoformat(), "limit": 1})
    r.raise_for_status()
    total = r.json()["total"]
    if total < cap or end - start <= timedelta(seconds=1):
        if total:
            yield start, end
        return
    mid = start + (end - start) / 2
    async for w in time_windows(client, url, start, mid, cap):
        yield w
    async for w in time_windows(client, url, mid, end, cap):
        yield w
```

The field names (`items`, `next_cursor`, `total`, `from`, `to`) are placeholders; map them to the API you are using. Each request should still go through your per-host limiter (see [Politeness and Rate Limiting](politeness-and-rate-limiting.md)).

## Code: TypeScript Link-header pagination

Node 18 or newer (global `fetch`). Tested against a local server returning three pages.

```typescript
export function parseLinkHeader(value: string | null, base: string): Record<string, string> {
  const links: Record<string, string> = {};
  if (!value) return links;
  for (const m of value.matchAll(/<([^>]*)>([^,<]*(?:"[^"]*"[^,<]*)*)/g)) {
    const rel = /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2]);
    for (const r of (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/).filter(Boolean)) {
      links[r] ??= new URL(m[1], base).href; // first occurrence wins
    }
  }
  return links;
}

export async function* pages<T>(start: string, init: RequestInit = {}, maxPages = 1000): AsyncGenerator<T> {
  const seen = new Set<string>();
  let url: string | undefined = start;
  for (let i = 0; url && i < maxPages; i++) {
    if (seen.has(url)) throw new Error(`pagination loop at ${url}`);
    seen.add(url);
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    yield (await res.json()) as T;
    url = parseLinkHeader(res.headers.get("link"), res.url).next;
  }
}

// for await (const issues of pages<object[]>("https://api.github.com/repos/OWNER/REPO/issues?per_page=100",
//   { headers: { "User-Agent": "ExampleBot/1.0", Accept: "application/vnd.github+json" } })) { ... }
```

## HTML pagination

- Prefer `<link rel="next">` or `<a rel="next">` when present. Google said in 2019 that it no longer uses `rel=next/prev` as an indexing signal, so many sites dropped the markup; fall back to the "Next" link, preferably by a stable attribute rather than its text (see [Writing Robust Selectors](../parsing/robust-selectors.md)).
- Do not generate `?page=1..9999` blindly. Many sites answer out-of-range pages with 200 and the first page or an empty template, a classic trap (see [Spider Traps and Crawl Hygiene](spider-traps.md)). Read the last page number from the page, or stop on the first repeated content hash.
- "Load more" buttons and infinite scroll are pagination over an XHR endpoint; capture that endpoint and page it directly (see [Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md)).

## Resumability and parallelism

- Checkpoint the last cursor, page or keyset value after each page, together with the query, so a restart resumes instead of starting over. Cursors can expire; on an "invalid cursor" error, fall back to keyset or a time filter.
- Cursor and keyset pagination are sequential by nature. Page-number pagination with a known total can be fetched in parallel, but only within the per-host budget; time slicing is the polite way to parallelize capped searches.

## Pitfalls

- Constructing the next URL yourself when the server provides one, and dropping parameters it added.
- Ending on a short page for APIs that filter after paging.
- Resolving a relative `Link` target against the request URL from before a redirect.
- No loop detection: a server that returns the same `next` forever keeps your job alive for days.
- Ignoring result caps and believing a 1,000-row result is complete.
- Offset pagination over a live list without id deduplication or count reconciliation.

## Checklist

- [ ] Follow server-provided next links or cursors verbatim; resolve relative URLs against the final response URL.
- [ ] Terminate on explicit end signals first; empty and short pages second.
- [ ] Detect repeated URLs, cursors and page hashes; cap pages and alert when the cap is hit.
- [ ] Deduplicate by id and reconcile totals; prefer keyset pagination on changing data.
- [ ] Slice by time or id when the API caps total results.
- [ ] Checkpoint position after every page; respect per-host rate limits.

## See Also

- [Consuming REST APIs Well](../apis/rest-api-consumption.md)
- [GraphQL Endpoints](../apis/graphql.md)
- [Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md)
- [Spider Traps and Crawl Hygiene](spider-traps.md)
- [Incremental Crawling](incremental-crawling.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
