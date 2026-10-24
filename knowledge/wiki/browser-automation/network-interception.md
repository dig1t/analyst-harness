---
tags: [scraping, browser-automation, network, har, xhr]
aliases: [response capture, request interception, HAR recording, XHR capture, routing]
---

# Network Interception and Response Capture

> Sources: Playwright docs, Network (https://playwright.dev/docs/network); Playwright docs, Mock APIs and HAR (https://playwright.dev/docs/mock); Playwright release notes (https://playwright.dev/docs/release-notes); Puppeteer docs, Request interception (https://pptr.dev/guides/network-interception); Puppeteer docs, WebDriver BiDi support (https://pptr.dev/webdriver-bidi); Selenium docs, BiDi network features (https://www.selenium.dev/documentation/webdriver/bidi/network/); W3C WebDriver BiDi, network module (https://www.w3.org/TR/webdriver-bidi/); HAR 1.2 specification (http://www.softwareishard.com/blog/har-12-spec/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Pages that "need JavaScript" usually fetch their data as JSON (REST or GraphQL) over fetch/XHR, or receive it over a WebSocket. Capturing those responses inside the browser is more robust than parsing the rendered DOM: the JSON has stable field names, full precision and often more fields than the page shows. Capture also reveals the endpoint, so after one rendered session you can often switch to a plain, rate-limited HTTP client, which is far cheaper. There are four techniques: **observe** (response events), **wait** for one specific response, **route** (abort, modify or mock requests) and **record** (HAR files). Everything here is about traffic your own browser session sends and receives; it is not a way around authentication or bot defenses.

## Techniques by tool

| Technique | Playwright | Puppeteer | Selenium |
|---|---|---|---|
| Observe | `page.on('response')`, `context.on('response')` | `page.on('response')` | BiDi `driver.network.add_request_handler` / `add_response_handler` |
| Wait for one | `page.waitForResponse()`, Python `expect_response()` | `page.waitForResponse()` | Explicit wait on a captured flag |
| Read body | `response.json()`, `.text()`, `.body()` | `res.json()`, `.text()`, `.buffer()` (CDP only) | Low-level BiDi data collectors or CDP |
| Route | `page.route()`, `context.route()` | `setRequestInterception(true)` | BiDi request handlers |
| Record HAR | `recordHar` context option, `tracing.startHar()` (1.60) | Not built in | Not built in |
| Replay HAR | `routeFromHAR()` | Not built in | Not built in |

## Capturing JSON responses (Playwright, TypeScript)

```ts
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const UA = 'ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)';
const captured: Array<{ url: string; status: number; body: unknown }> = [];
const pending: Promise<void>[] = [];

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: UA });
const page = await context.newPage();

// Register before navigating so early responses are not missed.
page.on('response', response => {
  const type = response.request().resourceType();
  const isJson = (response.headers()['content-type'] ?? '').includes('application/json');
  if ((type === 'xhr' || type === 'fetch') && isJson && response.url().includes('/api/')) {
    pending.push(
      response
        .json()
        .then(body => { captured.push({ url: response.url(), status: response.status(), body }); })
        .catch(() => { /* body unavailable: redirect, aborted or page navigated away */ }),
    );
  }
});

try {
  await page.goto('https://example.com/search?q=widgets', { waitUntil: 'domcontentloaded' });
  await page.locator('.results li').first().waitFor();
  await Promise.all(pending);
  await writeFile('captured.json', JSON.stringify(captured, null, 2));
} finally {
  await browser.close();
}
```

## Waiting for one response (Playwright, Python)

```python
with page.expect_response(
    lambda r: "/api/search" in r.url and r.request.resource_type in ("xhr", "fetch")
) as info:
    page.get_by_role("button", name="Search").click()
response = info.value
if response.ok:
    data = response.json()
```

Glob patterns also work (`page.expect_response("**/api/search*")`). A glob must match the entire URL; `*` does not cross `/` and `**` does. Use a predicate or a regular expression for anything subtle.

## Capturing in Puppeteer and Selenium

Puppeteer's pattern is the same: register `page.on('response', ...)` before navigation, filter on `res.request().resourceType()` and the URL, and call `await res.json()`. Response bodies are available over CDP (the default for Chrome). Over WebDriver BiDi (the default for Firefox) `HTTPResponse.text()`, `buffer()` and `content()` are not supported, and neither is `resourceType()`.

Selenium's high-level BiDi handlers (checked against 4.51) expose request URLs, methods, headers and response status, which is enough to discover endpoints; bodies need the low-level `network.addDataCollector` and `network.getData` commands or CDP. See [Selenium and WebDriver](selenium.md).

## Routing: block, modify, mock

Routes sit between the page and the browser's network stack. A handler runs before the request leaves, and `continue` passes it on, `fulfill` answers it without touching the network, and `abort` fails it.

```python
BLOCK = {"image", "media", "font"}
context.route("**/*", lambda route: route.abort()
              if route.request.resource_type in BLOCK else route.continue_())
```

Things the Playwright docs call out:

- **Enabling routing disables the HTTP cache.** Blocking saves bandwidth but repeated visits lose caching; measure both.
- **Service workers can hide traffic.** If requests seem to be missing, create the context with `serviceWorkers: 'block'` (Python `service_workers="block"`).
- **Some headers belong to the network stack.** `Cookie`, `Host`, `Accept-Encoding`, `Content-Length` and `Sec-Fetch-*` are added after the route handler runs, so they are not reliably visible in `request.headers()` and cannot be overridden. A `cookie` header passed to `route.continue()` is ignored in favor of the cookie store.
- **Redirects are one unit.** The handler runs once for the original request and the browser follows redirects itself.
- **Modifying a response** means fetching the original inside the handler (`await route.fetch()`), changing it, then `route.fulfill({ response, body })`.

Resource blocking for cost reasons is covered in [Making Browsers Cheap](browser-resource-optimization.md).

## HAR files: record once, test forever

A HAR (HTTP Archive) file records requests, responses, headers, timings and optionally bodies.

```ts
const context = await browser.newContext({
  recordHar: { path: 'search.har', content: 'embed', urlFilter: '**/api/**' },
});
// ... browse ...
await context.close(); // the HAR is written when the context closes
```

```python
context = browser.new_context(record_har_path="search.har", record_har_url_filter="**/api/**")
# ... browse ...
context.close()

# Later, in a parser test: serve API calls from the file instead of the network.
page.route_from_har("tests/fixtures/search.har", url="**/api/**")
```

`content` can be `omit`, `embed` or `attach` (the default for `.zip` output), and `mode: 'minimal'` keeps only what replay needs. Since 1.60, `context.tracing.startHar()` records a HAR as a tracing operation, and since 1.61 HAR and trace recordings include WebSocket traffic. Replaying a HAR makes parser tests deterministic and keeps test runs off the live site ([Testing Scrapers](../data-quality/testing-scrapers.md)).

## From capture to a direct API client

Once you know the endpoint, its parameters and its pagination, a plain HTTP client is usually the better collector:

1. Read the captured request: method, query parameters or JSON body, and which headers actually matter.
2. Check whether the API is documented, whether the terms allow automated use, and what rate limits apply ([API Rate Limits and Quotas](../apis/api-rate-limits.md)).
3. Reproduce it with an honest User-Agent and polite pacing, and paginate as described in [Pagination Patterns](../crawling/pagination-patterns.md).
4. If requests carry per-request signatures or tokens produced by obfuscated code whose purpose is to block automation, stop there. That is an access control; ask the site for access instead.

[Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md) covers the DevTools side, [GraphQL Endpoints](../apis/graphql.md) covers operation names and persisted queries, and [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md) covers streams (Playwright exposes `page.on('websocket')` with `framesent` and `framereceived` events, plus `routeWebSocket()` for mocking).

## Pitfalls

- Registering listeners after `goto()`, so the first API calls are missed.
- Reading bodies of redirect responses, or after the page navigated away; the body is gone.
- Closing the browser while body reads are still pending.
- Filtering only on URL and capturing preflight `OPTIONS` requests, HTML error pages or challenge pages. Check method, status and content type.
- HAR files contain cookies, authorization headers and sometimes personal data. Scrub them before committing and store them like secrets.
- Assuming a captured endpoint is free to hammer. It serves the site's own users; keep the same politeness as for HTML pages.

## Checklist

- [ ] Listeners registered before navigation, filtered on type, method, status and content type
- [ ] Body reads awaited before the context closes
- [ ] Endpoint, parameters and pagination documented for a possible HTTP-only collector
- [ ] Terms and rate limits checked before calling the endpoint directly
- [ ] HAR fixtures scrubbed of secrets and personal data
- [ ] Parser tests replay HARs instead of hitting the live site

## See Also

- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [GraphQL Endpoints](../apis/graphql.md)
- [Waiting Strategies](waiting-strategies.md)
- [Making Browsers Cheap](browser-resource-optimization.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
