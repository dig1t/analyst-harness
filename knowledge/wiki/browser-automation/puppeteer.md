---
tags: [scraping, browser-automation, puppeteer, cdp, typescript]
aliases: [Puppeteer, puppeteer-core, Chrome DevTools Protocol automation]
---

# Puppeteer

> Sources: Puppeteer docs, What is Puppeteer (https://pptr.dev/guides/what-is-puppeteer); Puppeteer docs, Page interactions (https://pptr.dev/guides/page-interactions); Puppeteer docs, Request interception (https://pptr.dev/guides/network-interception); Puppeteer docs, Headless mode (https://pptr.dev/guides/headless-modes); Puppeteer docs, Browser management (https://pptr.dev/guides/browser-management); Puppeteer docs, WebDriver BiDi support (https://pptr.dev/webdriver-bidi); Puppeteer docs, Configuration (https://pptr.dev/guides/configuration); Puppeteer docs, Troubleshooting (https://pptr.dev/troubleshooting); Chrome DevTools Protocol (https://chromedevtools.github.io/devtools-protocol/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Puppeteer is a JavaScript/TypeScript library from the Chrome team that controls Chrome or Firefox. With Chrome it speaks the Chrome DevTools Protocol (CDP) by default; with Firefox it uses WebDriver BiDi. The `puppeteer` package downloads a matching Chrome for Testing build when installed, while `puppeteer-core` is the library alone, for when you bring your own browser. It suits Node-only teams that mostly target Chrome and want direct CDP access. Compared with [Playwright](playwright.md) it offers fewer conveniences (no Python binding, no HAR recorder, narrower browser coverage) in exchange for a thinner layer over Chrome. This page reflects Puppeteer 25 (October 2026).

## First script

```ts
// scrape.mts
import puppeteer from 'puppeteer';

const UA = 'ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)';

const browser = await puppeteer.launch(); // new headless mode by default
const context = await browser.createBrowserContext(); // isolated cookies and storage
const page = await context.newPage();
await page.setUserAgent({ userAgent: UA });
page.setDefaultTimeout(15_000);
try {
  await page.goto('https://example.com/products', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="product-card"]').wait();
  const items = await page.$$eval('[data-testid="product-card"]', cards =>
    cards.map(c => ({
      name: c.querySelector('h2')?.textContent?.trim() ?? null,
      price: c.querySelector('.price')?.textContent?.trim() ?? null,
    })),
  );
  console.log(items);
} finally {
  await context.close();
  await browser.close();
}
```

The string form `page.setUserAgent(ua)` still works but is deprecated in favor of the options object. Older tutorials use `createIncognitoBrowserContext()`, `page.waitForTimeout()` and `page.$x()`; none of them exist in current releases.

## Locators and selectors

- `page.locator(selector)` is the recommended way to interact. Before clicking, it ensures the element is in the viewport, visible, enabled and has had a stable bounding box for two consecutive animation frames. Useful methods: `.setTimeout(ms)`, `.filter(fn)`, `.map(fn)`, `.wait()`, `.waitHandle()`.
- Non-CSS queries are CSS pseudo-elements with a `-p` prefix: `::-p-text(Checkout)`, `::-p-aria(Submit)`, `::-p-xpath(//h2)`.
- Shadow DOM: `>>>` (deep descendant) and `>>>>` (deep child) combinators, for example `page.locator('product-list >>> .price')`. The legacy `pierce/` prefix still works.
- `page.waitForSelector()` is lower level: it does not retry actions, and the ElementHandle it returns must be disposed.
- `page.$`, `page.$$`, `page.$eval` and `page.$$eval` query immediately, without waiting.

## Navigation and waiting

`page.goto()` and `page.waitForNavigation()` accept `waitUntil`: `load` (the default), `domcontentloaded`, `networkidle0` (no network connections for at least 500 ms) or `networkidle2` (no more than 2 connections for at least 500 ms). The default timeout is 30 000 ms; change it with `page.setDefaultNavigationTimeout()` and `page.setDefaultTimeout()`. Prefer waiting for the response that carries the data, started together with the action that triggers it:

```ts
const [res] = await Promise.all([
  page.waitForResponse(r => r.url().includes('/api/search') && r.status() === 200),
  page.locator('button[type="submit"]').click(),
]);
const data = await res.json();
```

`page.waitForNetworkIdle({ idleTime: 500, concurrency: 0 })` exists but has the pitfalls described in [Waiting Strategies](waiting-strategies.md).

## Request interception

```ts
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.isInterceptResolutionHandled()) return;
  const type = req.resourceType();
  if (type === 'image' || type === 'media' || type === 'font') req.abort();
  else req.continue();
});
```

Once interception is on, every request stalls until a handler continues, responds to or aborts it (or it completes from the browser cache). Always check `isInterceptResolutionHandled()` first, because another handler (including one registered by a third-party package) may already have resolved the request. When several handlers must cooperate, pass a numeric `priority` to `continue`, `abort` and `respond` to use Cooperative Intercept Mode.

## Talking CDP directly

```ts
const cdp = await page.createCDPSession();
await cdp.send('Network.enable');
cdp.on('Network.responseReceived', event => {
  if (event.type === 'XHR' || event.type === 'Fetch') {
    console.log(event.response.status, event.response.url);
  }
});
```

CDP exposes everything DevTools can do (performance metrics, coverage, network conditions, screencasts), but it is Chromium-only, changes with browser versions, and is not available when Puppeteer runs over WebDriver BiDi.

## Firefox and WebDriver BiDi

```ts
const firefox = await puppeteer.launch({ browser: 'firefox' }); // BiDi by default
const chromeOverBidi = await puppeteer.launch({ browser: 'chrome', protocol: 'webDriverBiDi' });
```

Firefox is not downloaded by default: enable it in the Puppeteer configuration file (`firefox: { skipDownload: false }`) and run `npx puppeteer browsers install`. Some features are unsupported over BiDi. For scraping the important gaps are response bodies (`HTTPResponse.text()`, `buffer()` and `content()`), `HTTPRequest.resourceType()` and `page.createCDPSession()`. Keep Chrome on CDP when you need to read API responses.

## Headless modes

| Launch option | Mode | When to use |
|---|---|---|
| `headless: true` (default since v22) | New headless: the real Chrome without a window | Default; most faithful |
| `headless: 'shell'` | chrome-headless-shell, the old headless mode shipped as a separate binary | Faster for simple jobs that do not need full Chrome behavior |
| `headless: false` | Headed | Debugging |

## Puppeteer vs Playwright

| | Puppeteer | Playwright |
|---|---|---|
| Maintainer | Chrome team (Google) | Microsoft |
| Languages | JavaScript, TypeScript | TS/JS, Python, Java, .NET |
| Browsers | Chrome/Chromium (CDP), Firefox (BiDi) | Chromium, patched Firefox and WebKit builds, branded Chrome and Edge |
| Isolation | `browser.createBrowserContext()` | `browser.newContext()` with per-context options |
| Auto-waiting | Locator API | Locators plus auto-retrying assertions |
| Interception | `setRequestInterception()` plus request events | `page.route()` and `context.route()` with globs |
| HAR | Not built in | `recordHar`, `routeFromHAR`, `tracing.startHar()` |
| Debugging | DevTools, Chrome performance traces | Trace viewer, codegen |
| Raw protocol access | Full CDP | CDP sessions for Chromium only |

## When to choose Puppeteer

- A Node-only codebase that targets Chrome and needs CDP features.
- Existing Puppeteer code, plugins or team knowledge.
- Pre-rendering, PDF or screenshot services where Chrome fidelity matters.

For most new scraping projects, Playwright is the more productive default.

## Docker notes

Run Chrome as a non-root user so its sandbox works. The troubleshooting guide's sample Dockerfile creates a `pptruser` account for exactly that reason and calls `--no-sandbox` strongly discouraged unless you absolutely trust the content. Use `docker run --init` (or another init process) so zombie Chrome processes get reaped. More levers are in [Making Browsers Cheap](browser-resource-optimization.md).

## Pitfalls

- Interception enabled but a code path that never calls `continue`, `abort` or `respond`: the page hangs.
- ElementHandles from `waitForSelector` never disposed, leaking memory in long runs.
- `networkidle0` never resolving on pages with polling or long-lived connections.
- Relying on response bodies while running over BiDi.
- Clicking and then calling `waitForNavigation()` or `waitForResponse()` separately, which races; start the wait first or use `Promise.all`.
- Copying code from old tutorials (incognito contexts, `waitForTimeout`, `$x`).

## Checklist

- [ ] `puppeteer` or `puppeteer-core` pinned, browser version recorded in logs
- [ ] One browser per worker, one browser context per job, closed in `finally`
- [ ] Honest User-Agent set with `page.setUserAgent({ userAgent })`
- [ ] Waits target selectors or responses, not idle heuristics
- [ ] Every interception handler checks `isInterceptResolutionHandled()`
- [ ] Non-root container user, `--init`, explicit timeouts

## See Also

- [Playwright](playwright.md)
- [Selenium and WebDriver](selenium.md)
- [Network Interception and Response Capture](network-interception.md)
- [Shadow DOM, iframes and Web Components](shadow-dom-and-iframes.md)
- [Node.js Scraping Stack](../tools/node-scraping-stack.md)
