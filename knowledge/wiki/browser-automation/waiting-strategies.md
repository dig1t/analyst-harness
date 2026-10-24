---
tags: [scraping, browser-automation, waits, flakiness, synchronization]
aliases: [waits, auto-wait, explicit waits, network idle, race conditions]
---

# Waiting Strategies

> Sources: Playwright docs, Auto-waiting (https://playwright.dev/docs/actionability); Playwright API, Page.goto waitUntil (https://playwright.dev/docs/api/class-page#page-goto); Playwright docs, Network events (https://playwright.dev/docs/network); Puppeteer docs, Page interactions and locators (https://pptr.dev/guides/page-interactions); Puppeteer API, PuppeteerLifeCycleEvent (https://pptr.dev/api/puppeteer.puppeteerlifecycleevent); Selenium docs, Waiting strategies (https://www.selenium.dev/documentation/webdriver/waits/); Selenium docs, page load strategy (https://www.selenium.dev/documentation/webdriver/drivers/options/); MDN, Lazy loading (https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most flaky browser scrapers have timing bugs, not selector bugs. The rule is simple: wait for the specific condition that proves your data is ready (an element, a response, a count, a URL), never for a fixed amount of time, and rarely for "network idle". Navigation events such as `load` only describe the document and its static subresources; data fetched afterwards by scripts, lazily loaded content and post-hydration re-renders all arrive later. Modern tools wait for actionability automatically before acting, but they cannot know when your data is complete, so the readiness condition is your job.

## What "loaded" means in each tool

| Moment | Playwright `waitUntil` | Puppeteer `waitUntil` | Selenium page load strategy |
|---|---|---|---|
| Response received, document started | `commit` | none | none |
| DOM parsed (`DOMContentLoaded`) | `domcontentloaded` | `domcontentloaded` | `eager` (`readyState` is `interactive`) |
| `load` event | `load` (default) | `load` (default) | `normal` (default, `readyState` is `complete`) |
| Network quiet for 500 ms | `networkidle` (marked DISCOURAGED) | `networkidle0` (0 connections), `networkidle2` (at most 2) | none |
| Return immediately | none | none | `none` |

For scraping, return early (`domcontentloaded` or `eager`) and then wait explicitly for the data. MDN notes that `load` can fire before lazily loaded images and iframes have arrived, so `load` is no guarantee either.

## Auto-waiting before actions

- **Playwright** checks, before a click, that the locator resolves to exactly one element that is visible, stable (same bounding box for two animation frames), receives events (not covered by an overlay), enabled and not inert. `fill` checks visible, enabled and editable. If the checks do not pass within the timeout, the action throws `TimeoutError`.
- **Puppeteer** locators ensure the element is in the viewport, visible, enabled and has a stable bounding box before acting.
- **Selenium** does not auto-wait for actionability. Use explicit waits such as `element_to_be_clickable`.

Auto-waiting makes actions reliable. It does not tell you that a results list has finished filling in.

## Waiting for data, not time

Five conditions cover almost every case. Prefer the one closest to the data.

1. **The response that carries the data.** Start waiting before the action that triggers the request, otherwise a fast response is missed.
2. **An element that only exists when data is present**, such as the first result row or a "showing 1 to 20" label.
3. **A count or content change**, for example at least 20 rows, or the first row's text differing from the previous page.
4. **A loading indicator disappearing.**
5. **A URL change** after client-side navigation.

```ts
// Playwright (TypeScript)
const responsePromise = page.waitForResponse(
  r => r.url().includes('/api/search') && r.request().method() === 'GET' && r.ok(),
);
await page.getByRole('button', { name: 'Search' }).click();
const payload = await (await responsePromise).json();

await page.locator('.results li').first().waitFor();                  // element visible
await page.locator('.spinner').waitFor({ state: 'hidden' });           // indicator gone
await page.waitForFunction(min => document.querySelectorAll('.results li').length >= min, 20);
await page.waitForURL('**/search?page=2');                             // client-side navigation
```

```python
# Playwright (Python, sync API)
from playwright.sync_api import expect

with page.expect_response(lambda r: "/api/search" in r.url and r.ok) as info:
    page.get_by_role("button", name="Search").click()
payload = info.value.json()

expect(page.locator(".results li")).to_have_count(20, timeout=15_000)
page.locator(".spinner").wait_for(state="hidden")
page.wait_for_function("min => document.querySelectorAll('.results li').length >= min", arg=20)
```

```ts
// Puppeteer
const [res] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/search') && r.ok()),
  page.locator('button[type="submit"]').click(),
]);
await page.waitForFunction(min => document.querySelectorAll('.results li').length >= min, {}, 20);
```

```python
# Selenium
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

wait = WebDriverWait(driver, timeout=15)
wait.until(EC.invisibility_of_element_located((By.CSS_SELECTOR, ".spinner")))
wait.until(lambda d: len(d.find_elements(By.CSS_SELECTOR, ".results li")) >= 20)
```

When you need to know that a list has stopped growing (search results that stream in), wait until the count has stayed the same across two or three polls a short interval apart, with an overall timeout. That is still a condition, not a sleep.

## Why network idle is a trap

Network idle means "no requests (or at most two, for `networkidle2`) for 500 ms". It looks like "the page is done", but:

- **It may never happen.** Analytics beacons, ad refreshes, polling, long-polling and chat widgets keep the network busy, so the wait times out, often only in CI or only on some pages.
- **It may happen too early.** A page that fetches data after a timer, after hydration or after the user scrolls goes quiet before the data request starts.
- **It is slow.** It waits for third-party traffic you do not need and adds at least 500 ms to every page.
- **It depends on the environment.** Network speed, blocked resources and caches change the result.

Playwright's API reference marks `networkidle` as DISCOURAGED and recommends asserting on readiness instead. Network idle is acceptable for a quick exploratory screenshot, not for a production scraper.

## Timeout budgets

- Set default timeouts explicitly (`page.setDefaultTimeout()`, `setDefaultNavigationTimeout()`, `WebDriverWait(timeout=...)`) instead of relying on library defaults (30 s for most operations in the Playwright and Puppeteer libraries).
- Give each page an overall budget. A page that has not produced data in, say, 45 s is a failure to record, not a reason to wait longer.
- Retry at the job level with backoff ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)), not in tight loops inside the page.
- Treat repeated timeouts on one host as a possible block or overload signal and slow down ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

## Hydration and re-render gotchas

- Server-rendered HTML can be visible before JavaScript attaches event handlers. A click during that window does nothing. Wait for a sign the app is interactive (a button becomes enabled, a spinner disappears), or click and then wait for the response or content change.
- Frameworks may replace nodes while rendering. Locators (Playwright, Puppeteer) re-resolve on every use; Selenium WebElements and ElementHandles go stale and must be found again.
- Lazy content needs scrolling before it exists at all ([Infinite Scroll and Lazy Loading](infinite-scroll-and-lazy-loading.md)).

## Pitfalls

- Fixed sleeps (`time.sleep`, `waitForTimeout`) used as readiness checks. They are slow when the site is fast and fail when it is slow. A deliberate politeness delay between pages is a different thing and is fine.
- Starting `waitForResponse` after the click.
- Selenium: mixing implicit and explicit waits, which the docs warn can stretch timeouts unpredictably.
- Waiting for an element that also exists in the empty state (a table header), so the wait succeeds before the data arrives.
- Using `networkidle` because it worked once on your laptop.
- Swallowing timeouts and saving partial pages as if they were complete. Validate the record before storing it.

## Checklist

- [ ] Navigation returns early (`domcontentloaded` or `eager`)
- [ ] Each page has an explicit readiness condition tied to the data
- [ ] Response waits are registered before the triggering action
- [ ] No fixed sleeps used for readiness
- [ ] Explicit default and per-page timeouts, with timeouts logged as failures
- [ ] Extracted records validated before they are saved

## See Also

- [Playwright](playwright.md)
- [Puppeteer](puppeteer.md)
- [Selenium and WebDriver](selenium.md)
- [Network Interception and Response Capture](network-interception.md)
- [Infinite Scroll and Lazy Loading](infinite-scroll-and-lazy-loading.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
