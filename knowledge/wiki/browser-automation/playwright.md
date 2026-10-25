---
tags: [scraping, browser-automation, playwright, python, typescript]
aliases: [Playwright, playwright-python, Playwright library]
---

# Playwright

> Sources: Playwright docs, Library (https://playwright.dev/docs/library); Playwright for Python, Library (https://playwright.dev/python/docs/library); Playwright docs, Locators (https://playwright.dev/docs/locators); Playwright docs, Auto-waiting (https://playwright.dev/docs/actionability); Playwright docs, Isolation (https://playwright.dev/docs/browser-contexts); Playwright docs, Authentication (https://playwright.dev/docs/auth); Playwright docs, Browsers (https://playwright.dev/docs/browsers); Playwright docs, Docker (https://playwright.dev/docs/docker); Playwright docs, Trace viewer (https://playwright.dev/docs/trace-viewer); Playwright release notes (https://playwright.dev/docs/release-notes)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Playwright is Microsoft's open source browser automation library. One API drives Chromium (a Chrome for Testing build since 1.57), Firefox and WebKit, with official bindings for TypeScript/JavaScript, Python, Java and .NET. For scraping, its strengths are cheap isolated browser contexts, locators that wait until elements are actionable, built-in network observation and routing, HAR recording, and a trace viewer for post-mortems. This article describes version 1.64 (October 2026); features tagged with a version number are recent and will be missing from older installs.

## Install

```bash
# Node (the library, not the Playwright Test runner)
npm install playwright
npx playwright install --with-deps chromium

# Python
pip install playwright
playwright install --with-deps chromium
```

Browser builds are tied to the package version, so run `install` again after every upgrade. Headless-only CI images can use `--only-shell` to skip the full browser.

## Object model

| Object | What it is | Scraping use |
|---|---|---|
| `Browser` | One browser process | Launch once per worker and reuse |
| `BrowserContext` | Incognito-like profile with its own cookies and storage, plus options such as user agent, locale, proxy | One per site, account or job; cheap to create |
| `Page` | A tab | Navigate, locate, extract |
| `Frame` | A document inside a page | Reach iframe content |
| `Locator` | A lazy query that re-resolves on every use | All element access |
| `APIRequestContext` | HTTP client at `context.request`, sharing the context's cookies | Call JSON endpoints without rendering |
| `Route` | An intercepted request | Block, modify or mock traffic |

## A first scrape in TypeScript

```ts
// scrape.mts (an ES module, so top-level await works)
import { chromium } from 'playwright';

const UA = 'ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)';

const browser = await chromium.launch(); // headless by default
const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
const page = await context.newPage();
try {
  await page.goto('https://example.com/products', { waitUntil: 'domcontentloaded' });
  const cards = page.locator('[data-testid="product-card"]');
  await cards.first().waitFor(); // default state: visible
  const items = await cards.evaluateAll(nodes =>
    nodes.map(n => ({
      name: n.querySelector('h2')?.textContent?.trim() ?? null,
      price: n.querySelector('.price')?.textContent?.trim() ?? null,
    })),
  );
  console.log(items);
} finally {
  await context.close();
  await browser.close();
}
```

## The same scrape in Python

```python
from playwright.sync_api import sync_playwright

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"
EXTRACT = """nodes => nodes.map(n => ({
  name: n.querySelector('h2')?.textContent?.trim() ?? null,
  price: n.querySelector('.price')?.textContent?.trim() ?? null,
}))"""

with sync_playwright() as p:
    browser = p.chromium.launch()
    context = browser.new_context(user_agent=UA, locale="en-US")
    page = context.new_page()
    try:
        page.goto("https://example.com/products", wait_until="domcontentloaded")
        cards = page.locator('[data-testid="product-card"]')
        cards.first.wait_for()
        print(cards.evaluate_all(EXTRACT))
    finally:
        context.close()
        browser.close()
```

For concurrency use the async API (`from playwright.async_api import async_playwright`) with an `asyncio.Semaphore`, as shown in [Making Browsers Cheap](browser-resource-optimization.md). Do not call the sync API from inside a running event loop.

| Topic | TypeScript | Python |
|---|---|---|
| Naming | `getByRole`, `waitForResponse` | `get_by_role`, `expect_response` |
| First and last match | `locator.first()`, `locator.last()` | `locator.first`, `locator.last` (properties) |
| Wait for a response | Create the promise, act, then await it | `with page.expect_response(...) as info:` then `info.value` |
| Continue a routed request | `route.continue()` | `route.continue_()` |
| Default timeout (library) | 30 s for most operations | 30 s |

The Playwright Test runner uses different defaults (no action timeout, 30 s per test); this article is about the library.

## Locators

- User-facing locators: `getByRole('button', { name: 'Load more' })`, `getByText`, `getByLabel`, `getByPlaceholder`, `getByAltText`, `getByTitle`, `getByTestId`.
- Structural locators: CSS (`page.locator('ul.results > li')`) and XPath (`page.locator('xpath=//table//tr')`). XPath does not pierce shadow roots.
- Narrowing: `.filter({ hasText: 'In stock' })`, `.filter({ has: page.locator('.price') })`, `.nth(i)`, `.first()`, `.last()`, `.visible()` (1.63), `a.within(b)` (1.64).
- Actions are strict: `click()` on a locator that matches several elements throws. Reading many elements is fine with `count()`, `allTextContents()`, `allInnerTexts()`, `evaluateAll()` and `all()`.
- `locator.all()` does not wait. Wait until the list has loaded (for example `await rows.first().waitFor()` or a count check) before calling it.
- CSS and text locators pierce open shadow roots by default; see [Shadow DOM, iframes and Web Components](shadow-dom-and-iframes.md). For selector design, see [Writing Robust Selectors](../parsing/robust-selectors.md).

## Contexts, sessions and identity

- One context per site, account or job keeps cookies and storage separate.
- Persist an authorized login with `await context.storageState({ path: 'state.json' })` and restore it with `browser.newContext({ storageState: 'state.json' })` (Python: `context.storage_state(path=...)`, `new_context(storage_state=...)`). The file holds live session tokens, so treat it as a secret ([Secrets and Configuration](../operations/secrets-and-config.md)).
- Set identity per context: `userAgent`, `extraHTTPHeaders` (for example a `From` address), `locale`, `timezoneId`, `viewport`, `proxy`. See [Identifying Your Bot](../anti-bot/identifying-your-bot.md).
- Use `context.request.get(url)` for JSON endpoints that need the same cookies, instead of navigating a page to them.

## Network in brief

```ts
const responsePromise = page.waitForResponse(r => r.url().includes('/api/search') && r.ok());
await page.getByRole('button', { name: 'Search' }).click();
const data = await (await responsePromise).json();

await context.route('**/*.{png,jpg,jpeg,webp,woff2}', route => route.abort());
```

Routing disables the HTTP cache. HAR recording, replay and WebSocket capture are covered in [Network Interception and Response Capture](network-interception.md).

## Headless modes and channels

- A default headless launch uses chromium-headless-shell, a lighter build of the old headless implementation.
- `channel: 'chromium'` opts into Chrome's new headless mode, which is the real browser and behaves more like a user's Chrome.
- `channel: 'chrome'` or `'msedge'` drives a branded browser installed on the machine.
- `headless: false` with `slowMo: 250` lets you watch a run while debugging.

## Debugging

- `npx playwright codegen https://example.com` (Python: `playwright codegen https://example.com`) records actions and proposes locators.
- Tracing: `await context.tracing.start({ screenshots: true, snapshots: true })`, run the job, then `await context.tracing.stop({ path: 'trace.zip' })` and open it with `npx playwright show-trace trace.zip`. In production, keep traces only for failed jobs.
- `page.on('console', ...)` and `page.on('pageerror', ...)` surface errors from page scripts.

## Running in containers

Use the official images (`mcr.microsoft.com/playwright`, `mcr.microsoft.com/playwright/python`) pinned to your Playwright version. The Docker guide recommends `--init` to avoid zombie processes and `--ipc=host` for Chromium, which can otherwise run out of memory and crash. For crawling untrusted sites it recommends a separate user and the published seccomp profile, so the Chromium sandbox stays on instead of running as root.

## Pitfalls

- `waitUntil: 'networkidle'` is marked DISCOURAGED in the API docs; wait for the element or response you need ([Waiting Strategies](waiting-strategies.md)).
- `page.waitForTimeout()` is meant for debugging only.
- Strict mode violations when a locator matches more elements than you expected.
- `page.content()` leaves out shadow DOM unless you pass `includeShadow: true` (1.64, open roots only).
- Leaked contexts and pages; close them in `finally`.
- ElementHandles (`page.$()`) do not re-resolve and go stale after re-renders; prefer locators.
- Creating `waitForResponse` after the click that triggers the request, so the response is missed.
- Upgrading the package without reinstalling browsers.

## Checklist

- [ ] One `Browser` per worker, one `BrowserContext` per job, both closed in `finally`
- [ ] Honest `userAgent` (and `From` header) on every context
- [ ] Explicit timeouts, no fixed sleeps
- [ ] Locators built on roles, text or stable attributes
- [ ] Traces captured for failed jobs
- [ ] Container image and browsers pinned to the same Playwright version

## See Also

- [Puppeteer](puppeteer.md)
- [Selenium and WebDriver](selenium.md)
- [Waiting Strategies](waiting-strategies.md)
- [Network Interception and Response Capture](network-interception.md)
- [Making Browsers Cheap](browser-resource-optimization.md)
- [Writing Robust Selectors](../parsing/robust-selectors.md)
