---
tags: [scraping, tools, devtools, recon, har]
aliases: [Chrome DevTools, browser developer tools, Network panel, copy as cURL, HAR file, preserve log]
---

# Browser DevTools for Scrapers

> Sources: Chrome DevTools, Network features reference (https://developer.chrome.com/docs/devtools/network/reference); Chrome DevTools, Console Utilities API reference (https://developer.chrome.com/docs/devtools/console/utilities); Chrome DevTools, Local overrides (https://developer.chrome.com/docs/devtools/overrides); Chrome DevTools, Recorder (https://developer.chrome.com/docs/devtools/recorder); DevTools frontend source, for current UI labels (https://github.com/ChromeDevTools/devtools-frontend); Firefox DevTools, Network Monitor (https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/); Playwright, mocking with HAR files (https://playwright.dev/docs/mock) and codegen (https://playwright.dev/docs/codegen); W3C HAR draft (https://w3c.github.io/web-performance/specs/HAR/Overview.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

The browser's developer tools are the most important reconnaissance instrument for scraping. In a few minutes they answer the questions that decide the whole design: is the data in the HTML or loaded by JavaScript, which request carries it, which headers, cookies and parameters it needs, and how pagination works. The usual outcome is that a page that "needs a browser" actually calls a JSON endpoint you can request directly. The workflow below uses Chrome; Firefox and Safari have close equivalents. What DevTools reveals about a site's own frontend is not a grant of permission: terms, rate limits and personal-data rules still apply (see [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).

## A recon workflow

1. Open the page, then DevTools (F12, or Cmd+Option+I on macOS) and the **Network** panel.
2. Tick **Preserve log** (labelled **Keep log** in current DevTools builds) so requests survive navigations and redirects, and **Disable cache** so you see real network traffic.
3. Reload. Filter by **Fetch/XHR** to hide images, fonts and scripts; use **Doc** to see the HTML document itself.
4. Press Ctrl+F (Cmd+F) with the Network panel focused to **search across all requests and responses** for a value you can see on the page, such as a price or a product name. The matching request is your data source.
5. Inspect that request: **Headers** (method, URL, status, request headers), **Payload** (query string or body), **Preview** and **Response** (JSON or HTML), **Initiator** (the script and call stack that sent it) and **Timing**.
6. Trigger pagination, filters or "load more" and watch which parameter changes (`page`, `offset`, `cursor`, a GraphQL variable). See [Pagination Patterns](../crawling/pagination-patterns.md).
7. Right-click the request and choose **Copy > Copy as cURL (bash)**, replay it in a terminal, then remove headers and cookies one at a time until it stops working. What remains is the minimal request your scraper needs.

## Static or dynamic?

- Compare **view-source:** (the server's HTML) with the **Elements** panel (the live DOM after JavaScript). Data present in view-source can be scraped with plain HTTP.
- Open the Command Menu (Ctrl+Shift+P, or Cmd+Shift+P) and run **Disable JavaScript**, then reload. Whatever still shows is server-rendered.
- Search view-source for JSON blobs such as `__NEXT_DATA__`, `application/ld+json` or inline state; they are often richer than the visible page (see [JSON and Embedded Data](../parsing/json-and-embedded-data.md) and [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)).

## Elements and Console: testing selectors

- Right-click a node in **Elements** for **Copy selector**, **Copy XPath**, **Copy full XPath** or **Copy JS path**. Generated selectors are brittle (positional, tied to generated class names); use them as a starting point and rewrite them around stable anchors (see [Writing Robust Selectors](../parsing/robust-selectors.md)).
- Ctrl+F inside the Elements panel accepts plain text, CSS selectors and XPath.
- Console utilities test selectors against the live DOM:

```javascript
$$("article.product_pod h3 a").length                  // CSS, returns an array of elements
$$("article.product_pod h3 a").map((a) => a.title)
$x("//p[@class='price_color']/text()").map((t) => t.textContent)   // XPath
copy($$("article.product_pod h3 a").map((a) => a.href))  // copy results to the clipboard
$0                                                       // the element selected in Elements
```

Remember that the live DOM can differ from the HTML your HTTP client receives; confirm selectors against the raw response too.

## Network panel features worth knowing

| Feature | Use |
|---|---|
| Initiator tab | Find the script and function that builds the API request (signatures, parameter encoding) |
| WS and EventStream views | Read WebSocket frames and server-sent events (see [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md)) |
| Block request URL or domain | Check whether the page works without a script, tracker or API call |
| Network throttling | Reproduce slow loads and timeouts |
| Override headers or content (local overrides) | Test how the page behaves with a modified response, without touching the server |
| Copy as fetch, Copy as fetch (Node.js), Copy as PowerShell, Copy as cURL (cmd or bash) | Replay requests in other environments |

The **Application** panel shows cookies, localStorage, sessionStorage, IndexedDB, service workers and cache storage: the state a request depends on. **Clear site data** reproduces a first visit, which is what your scraper sees (see [Cookies, Sessions and State](../http/cookies-and-sessions.md)). The **Sources** panel's global search (Ctrl+Shift+F) finds endpoint paths, GraphQL operation names and parameter names inside the site's JavaScript bundles (see [GraphQL Endpoints](../apis/graphql.md)).

## HAR files

A HAR (HTTP Archive) file is a JSON log of every request and response in a session, defined by a W3C draft format that DevTools, Firefox, Playwright and many tools read and write.

- In Chrome, right-click the request list and choose **Copy all as HAR (sanitized)** or save the HAR from the panel's export button. The sanitized export removes cookies, `Set-Cookie`, `Cookie` and `Authorization` headers. Exports **with sensitive data** appear only after enabling the setting **Allow to generate HAR with sensitive data**.
- Sanitizing does **not** remove tokens in URLs or query strings, POST bodies, custom auth headers such as `X-API-Key`, or personal data in responses. Review a HAR before sharing it, and never commit one (see [Secrets and Configuration](../operations/secrets-and-config.md)).
- Playwright can record and replay HAR files, which makes realistic offline fixtures:

```bash
npx playwright open --save-har=example.har --save-har-glob="**/api/**" https://example.com
```

```typescript
await page.routeFromHAR("./example.har", { url: "**/api/**", update: false }); // replay without the network
```

Recording and replaying network traffic in automated browsers is covered in [Network Interception and Response Capture](../browser-automation/network-interception.md).

## Turning recon into code

- **Recorder panel** (Chrome) records clicks and form input as a user flow and exports Puppeteer scripts; `npx playwright codegen https://example.com` does the same for Playwright. Both produce selectors you should then harden.
- From a copied cURL command, keep only the headers the endpoint truly needs, and replace cookies from your personal session with a proper, permitted authentication flow (see [Authentication Patterns](../http/authentication-patterns.md)).
- Write down what you found (endpoint, parameters, pagination, rate behavior) in the scraper spec so the next maintainer does not repeat the recon (see [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md)).

## Firefox equivalents

Firefox's Network Monitor offers **Persist Logs**, **Disable Cache**, filtering by XHR, **Copy as cURL**, **Edit and Resend** for tweaking and replaying a request in place, and **Save All As HAR**. Its console supports `$$()` and `$x()` as well.

## Pitfalls

- Forgetting Preserve log or Keep log and losing the request that happened before a redirect.
- Copying a cURL command with your session cookie into code, a ticket or a chat.
- Trusting "Copy selector" output as production-ready.
- Testing selectors only on the live DOM, then finding the raw HTML has a different structure.
- Leaving "Disable cache" on and misreading caching behavior, or leaving it off and missing requests served from cache.
- Sharing "sanitized" HAR files that still contain tokens in URLs or personal data in bodies.
- Treating an undocumented endpoint as a public API without reading the terms.

## Checklist

- [ ] Preserve log and Disable cache enabled before reloading
- [ ] Data request found by searching for a visible value
- [ ] Static vs dynamic decided (view-source, Disable JavaScript)
- [ ] Minimal request reproduced with curl outside the browser
- [ ] Pagination and parameters documented
- [ ] Selectors rewritten around stable anchors and tested on raw HTML
- [ ] No cookies, tokens or HAR files left in code or tickets

## See Also

- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
- [curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md)
- [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)
- [Command-Line Tools](cli-tools.md)
- [Secrets and Configuration](../operations/secrets-and-config.md)
