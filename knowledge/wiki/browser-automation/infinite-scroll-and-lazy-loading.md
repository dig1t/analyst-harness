---
tags: [scraping, browser-automation, infinite-scroll, lazy-loading, pagination]
aliases: [infinite scroll, load more button, lazy loading, virtualized lists, endless scrolling]
---

# Infinite Scroll and Lazy Loading

> Sources: MDN, Intersection Observer API (https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API); MDN, Lazy loading (https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading); WHATWG HTML, lazy loading attributes (https://html.spec.whatwg.org/multipage/#lazy-loading-attributes); Playwright API, Locator (https://playwright.dev/docs/api/class-locator); Playwright docs, Network (https://playwright.dev/docs/network); Puppeteer docs, Page interactions (https://pptr.dev/guides/page-interactions); Selenium docs, Waiting strategies (https://www.selenium.dev/documentation/webdriver/waits/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Infinite scroll is pagination with the URL hidden. As the user nears the bottom, a script (usually an `IntersectionObserver` watching a sentinel element) requests the next page of results from an API, often with a cursor, and appends it to the list. The best approach is almost always to find that API and paginate it directly with an HTTP client. When that is impossible or not permitted, drive the page with a bounded loop: scroll or click "load more", wait for new items, collect them incrementally with de-duplication, and stop on explicit conditions. Lazy-loaded images and iframes are a related but separate problem, and their URLs are often readable without scrolling at all.

## How these pages work

| Pattern | Mechanism | What it means for you |
|---|---|---|
| Sentinel and observer | `IntersectionObserver` fires when a marker near the end enters the viewport | Bringing the last item into view triggers the next load |
| Scroll listener | Script checks scroll position on `scroll` or `wheel` events | Real scrolling (or wheel events) is required |
| Load more button | Click fetches and appends the next page | Click, wait for growth, repeat |
| Virtualized list | Only rows near the viewport exist in the DOM (rows are recycled) | Collect while scrolling; the final DOM holds only the last screenful |
| Native lazy loading | `loading="lazy"` on `img`, `iframe`, `video`, `audio` defers the fetch | The `src` is already in the HTML; you only need to scroll to download it |
| Script lazy loading | The real URL sits in `data-src` or `data-srcset` until a script swaps it | Read the data attribute instead of scrolling |

## Strategy 1: paginate the underlying API

Open DevTools, filter Network to Fetch/XHR, scroll once, and look at the request that returns the next batch ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md), [Network Interception and Response Capture](network-interception.md)). Identify the page parameter (`page`, `offset`, `cursor`, `after`) and the end signal (`has_more: false`, a missing `next_cursor`, an empty list). Then, if the terms permit, page through it politely:

```python
import time

import httpx

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"


def fetch_all(query: str, max_pages: int = 200):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    with httpx.Client(headers=headers, timeout=30) as client:
        cursor = None
        for _ in range(max_pages):  # hard cap, even if the API never says "done"
            params = {"q": query, "limit": 50}
            if cursor:
                params["cursor"] = cursor
            resp = client.get("https://example.com/api/search", params=params)
            resp.raise_for_status()
            body = resp.json()
            yield from body["items"]
            cursor = body.get("next_cursor")
            if not cursor or not body["items"]:
                return
            time.sleep(2)  # politeness delay between pages
```

This is faster, cheaper and kinder to the site than rendering, and the data arrives already structured. Cursor and keyset details are in [Pagination Patterns](../crawling/pagination-patterns.md).

## Strategy 2: click "load more" (Playwright, TypeScript)

```ts
const ITEM = '[data-testid="result"]';
const items = page.locator(ITEM);
const loadMore = page.getByRole('button', { name: /load more/i });

for (let round = 0; round < 50; round++) {           // hard cap on rounds
  if (!(await loadMore.isVisible()) || !(await loadMore.isEnabled())) break;
  const before = await items.count();
  await loadMore.click();
  try {
    await page.waitForFunction(
      ({ sel, n }) => document.querySelectorAll(sel).length > n,
      { sel: ITEM, n: before },
      { timeout: 15_000 },
    );
  } catch {
    break;                                            // nothing new arrived: treat as the end
  }
  await new Promise(resolve => setTimeout(resolve, 1_000)); // politeness pause
}
const rows = await items.allTextContents();
```

## Strategy 3: scroll and collect incrementally (Playwright, Python)

This loop works for both growing lists and virtualized lists, because it records items as they appear and detects progress by new IDs rather than by DOM size.

```python
import time

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError

ITEM = "[data-testid='result']"
READ = """els => els.map(e => ({
  id: e.dataset.id ?? null,
  title: e.querySelector('h3')?.textContent?.trim() ?? null,
}))"""
CHANGED = """([sel, n, lastId]) => {
  const els = document.querySelectorAll(sel);
  return els.length > n || (els.length > 0 && els[els.length - 1].dataset.id !== lastId);
}"""


def scroll_and_collect(page, max_rounds=100, stale_limit=3, pause_s=1.5):
    seen: dict[str, dict] = {}
    stale = 0
    for _ in range(max_rounds):
        rows = page.locator(ITEM).evaluate_all(READ)
        new = [r for r in rows if r["id"] and r["id"] not in seen]
        seen.update((r["id"], r) for r in new)
        stale = 0 if new else stale + 1
        if not rows or stale >= stale_limit:
            break
        page.locator(ITEM).last.scroll_into_view_if_needed()  # triggers the sentinel
        try:
            page.wait_for_function(CHANGED, arg=[ITEM, len(rows), rows[-1]["id"]], timeout=10_000)
        except PlaywrightTimeoutError:
            pass  # no change this round; the stale counter decides when to stop
        time.sleep(pause_s)  # politeness pause, not a readiness check
    return list(seen.values())
```

If a page reacts only to wheel events, hover the list and call `page.mouse.wheel(0, 1500)` instead of scrolling an element into view. `scroll_into_view_if_needed()` also scrolls nested scroll containers, which matters because many apps scroll an inner `div` rather than the window.

## Puppeteer and Selenium equivalents

```ts
// Puppeteer: scroll the last item into view, then wait for growth
const ITEM = '[data-testid="result"]';
const before = await page.$$eval(ITEM, els => els.length);
await page.$$eval(ITEM, els => els.at(-1)?.scrollIntoView({ block: 'end' }));
await page.waitForFunction((sel, n) => document.querySelectorAll(sel).length > n, { timeout: 10_000 }, ITEM, before);
```

```python
# Selenium (driver created as in the Selenium article)
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait

ITEM = "[data-testid='result']"
items = driver.find_elements(By.CSS_SELECTOR, ITEM)
driver.execute_script("arguments[0].scrollIntoView({block: 'end'});", items[-1])
WebDriverWait(driver, 10).until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ITEM)) > len(items))
```

`window.scrollTo(0, document.body.scrollHeight)` only works when the window is the scroll container; scrolling the last item into view works in both cases.

## Lazy images and iframes

- With native lazy loading, the URL is already in `src` or `srcset`; read it from the HTML. Scrolling only makes the browser download the file.
- Script-based lazy loaders keep the real URL in `data-src`, `data-srcset` or similar until the element is near the viewport. Read those attributes.
- If you need only metadata, block image downloads entirely ([Making Browsers Cheap](browser-resource-optimization.md)).
- Lazy iframes (`loading="lazy"`) are not attached to their content until scrolled near; scroll the iframe element into view before entering it ([Shadow DOM, iframes and Web Components](shadow-dom-and-iframes.md)).

## When to stop

| Signal | Example |
|---|---|
| API says done | `has_more` false, `next_cursor` missing, empty page |
| End marker | "No more results", a footer that only renders at the end |
| No progress | No new IDs after N consecutive rounds |
| Repetition | The same last ID or a page you already collected |
| Budget | Maximum rounds, items, bytes or minutes reached |

Always combine a natural end signal with a hard budget, and save progress incrementally (with the cursor) so a crash can resume instead of restarting.

## Pitfalls

- Scrolling the window when an inner container scrolls; nothing loads.
- Reading the DOM only at the end of a virtualized list and getting one screenful.
- No de-duplication, so items repeat after re-renders or overlapping pages.
- Loops without a cap that run until memory runs out; very long pages grow without bound.
- Fixed sleeps as the only readiness check.
- Load more buttons that stay in the DOM but become disabled or hidden at the end.
- Ignoring politeness: every scroll can trigger requests, so pace the loop like any crawl ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)).

## Checklist

- [ ] Looked for the underlying paginated API first
- [ ] Loop has a natural end condition and a hard budget
- [ ] Items keyed by a stable ID and de-duplicated as they are collected
- [ ] Progress (cursor or last ID) checkpointed for resumption
- [ ] Image URLs read from attributes rather than by scrolling, where possible
- [ ] Pacing between loads matches the site's rate limits

## See Also

- [Pagination Patterns](../crawling/pagination-patterns.md)
- [Network Interception and Response Capture](network-interception.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Waiting Strategies](waiting-strategies.md)
- [Making Browsers Cheap](browser-resource-optimization.md)
