---
tags: [scraping, fundamentals, rendering, javascript, hydration]
aliases: [Static sites, Dynamic sites, Client-side rendering, Server-side rendering, SSR, CSR, Hydration, JavaScript-rendered pages]
---

# Static vs Dynamic Sites

> Sources: web.dev, Rendering on the Web (https://web.dev/articles/rendering-on-the-web); Google Search Central, Understand JavaScript SEO basics (https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics); Google Search Central, Dynamic rendering as a workaround (https://developers.google.com/search/docs/crawling-indexing/javascript/dynamic-rendering); React, hydrateRoot (https://react.dev/reference/react-dom/client/hydrateRoot); Next.js documentation (https://nextjs.org/docs); Nuxt documentation (https://nuxt.com/docs); Chrome DevTools, Network panel (https://developer.chrome.com/docs/devtools/network); Playwright for Python (https://playwright.dev/python/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A static or server-rendered page delivers its data in the HTML response; a client-rendered page delivers a shell and fetches the data with JavaScript after loading. Most modern sites are hybrids: the server renders HTML and also embeds the data as JSON so the browser can "hydrate" the page, or it renders part of the page and loads the rest later. For a scraper the useful question is not "static or dynamic?" but "where does the value I need first appear?": in the raw HTML, in an embedded JSON blob, in an XHR or fetch response, or only after an interaction. Check in that order, because each answer is cheaper and more stable than the next, and reach for a headless browser only when the data truly exists nowhere else.

## Rendering models

| Model | What the first response contains | Where the data is | Scraper approach |
|---|---|---|---|
| Static files, static generation (SSG) | Complete HTML built at deploy time | In the HTML | HTTP client and parser |
| Server-side rendering (SSR) | Complete HTML rendered per request | In the HTML, often also in an embedded JSON blob | Parse the JSON blob if present, else the HTML |
| Incremental or cached regeneration | SSR output cached and refreshed periodically | As SSR, possibly a little stale | As SSR |
| Client-side rendering (CSR, single-page apps) | A shell such as `<div id="root"></div>` plus scripts | In JSON from XHR or fetch calls | Call the JSON endpoint |
| Hydration | SSR or SSG HTML, then scripts attach behavior | HTML plus serialized state | Serialized state first |
| Streaming SSR, React Server Components | HTML in chunks plus a component payload | Inside script-pushed payload chunks | Prefer JSON-LD or the API; payloads are hard to parse |
| Islands, partial hydration | Mostly static HTML with interactive islands | Mostly in the HTML | HTTP client and parser |

Google describes serving pre-rendered pages only to bots ("dynamic rendering") as a workaround it no longer recommends; when you see different HTML for bots and browsers, compare both before trusting either.

## How to tell, in five minutes

1. **View source versus the Elements panel.** View source (Ctrl+U) shows the raw response; the Elements panel shows the live DOM after scripts. Data present only in Elements is added by JavaScript.
2. **Search the raw HTML for a distinctive value**, such as a price or an ID: `curl -s URL | grep -c '89.00'`.
3. **Disable JavaScript** (DevTools command menu, "Disable JavaScript") and reload. Whatever remains is server-rendered.
4. **Network panel, Fetch/XHR filter**, then search response bodies for the value. A JSON response containing it is your best source ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).
5. **Framework fingerprints** in the HTML:

| Marker | Meaning |
|---|---|
| `<script id="__NEXT_DATA__" type="application/json">` | Next.js pages router: full page props as JSON |
| `self.__next_f.push(...)` script chunks | Next.js App Router: React Server Components payload |
| `<script id="__NUXT_DATA__" type="application/json">` | Nuxt 3: flat array payload (devalue format) |
| `window.__NUXT__=` | Nuxt 2 state |
| `window.__APOLLO_STATE__` | Apollo GraphQL normalized cache |
| `window.__INITIAL_STATE__`, `window.__PRELOADED_STATE__` | Hand-rolled or Redux server state |
| `ng-version="..."` attribute | Angular |
| An empty `<div id="root">` or `<div id="app">`, a `<noscript>` "enable JavaScript" message | Client-rendered shell |

The recon script in [Choosing an Acquisition Strategy](scraping-decision-framework.md) automates checks 2 and 5.

## Measuring the difference

Comparing raw HTML with the rendered DOM settles the question for a specific page:

```python
import httpx
from playwright.sync_api import sync_playwright  # pip install playwright && playwright install chromium

URL, NEEDLE = "https://example.com/products/trail-shoe", "Trail Shoe"

raw = httpx.get(URL, timeout=15.0, follow_redirects=True).text
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.goto(URL)
    page.wait_for_selector("#root h1")  # wait for the element you need, not for "network idle"
    rendered = page.content()  # the serialized DOM after scripts ran
    browser.close()

print(f"raw HTML: {len(raw):>5} bytes, needle present: {NEEDLE in raw}")
print(f"rendered: {len(rendered):>5} bytes, needle present: {NEEDLE in rendered}")
```

On a client-rendered test page this prints `needle present: False` for the raw HTML and `True` after rendering. Before concluding "needs a browser", look at what the page's script requested: here it was a single JSON call to `/api/product/A-100`, which an HTTP client can make directly.

## Getting data out of hydrated pages

Serialized state is usually the best source on a server-rendered page: it is the exact data the page was rendered from, typed, and unaffected by CSS class churn.

```python
import json

import httpx
from selectolax.lexbor import LexborHTMLParser

r = httpx.get("https://example.com/products/trail-shoe", timeout=15.0, follow_redirects=True)
node = LexborHTMLParser(r.text).css_first("script#__NEXT_DATA__")
data = json.loads(node.text()) if node else {}
product = data.get("props", {}).get("pageProps", {}).get("product")
print(product)  # {'sku': 'A-100', 'name': 'Trail Shoe', 'price': 89.0}
```

- **Nuxt 3** stores a flat array in which values point at other indexes. Decode it with the `devalue` package's `parse`, passing pass-through revivers for Nuxt's markers (`Reactive`, `ShallowReactive`, `Ref`, `ShallowRef`).
- **State assigned in a script** (`window.__INITIAL_STATE__ = {...}`) is a JavaScript object literal, not always valid JSON. Parse it with a JS-object parser such as Python's `chompjs` (which, for example, turns `undefined` into the string `'undefined'`) instead of `eval`, which would execute site code in your process.
- **Next.js App Router payloads** are a streaming component format split across `self.__next_f.push` calls; parsing them is fragile. Prefer JSON-LD, the underlying API, or the HTML.

More patterns are in [JSON and Embedded Data](../parsing/json-and-embedded-data.md) and [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).

## Decision rules

- **If the value is in the raw HTML**, use an HTTP client and a parser.
- **If it is in an embedded JSON blob**, parse the blob; it survives redesigns better than selectors.
- **If it arrives through XHR or fetch**, call that endpoint with the parameters the page uses, at the pace a browser would.
- **If it appears after scrolling or clicking**, find the request the interaction triggers (infinite scroll is usually a paginated API) ([Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md)).
- **If requests are signed, encrypted or computed in heavy client code**, use a browser on as few pages as possible, blocking images and fonts ([Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)).
- **If a bot challenge appears instead of content**, stop and read [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md).

A useful hybrid: let a browser load the page once while capturing network responses to discover the JSON endpoints, then collect with a plain HTTP client ([Network Interception and Response Capture](../browser-automation/network-interception.md)).

## Pitfalls

- **Launching a browser for data that sits in `__NEXT_DATA__`** or a JSON endpoint.
- **Assuming your client sees what your browser sees.** Responses vary by cookies, language, location and bot detection; compare raw responses from your actual runtime.
- **Waiting for "network idle".** Analytics and long polling keep pages busy forever; wait for the element or response you need ([Waiting Strategies](../browser-automation/waiting-strategies.md)).
- **Selecting on generated class names** such as `css-1x2y3z`, which change on every deploy ([Writing Robust Selectors](../parsing/robust-selectors.md)).
- **Missing lazily loaded sections**: server rendering often covers only the first screen.
- **Running site JavaScript with `eval`** to read a state object.

## Checklist

- [ ] Value searched in raw HTML, embedded JSON and network responses, in that order
- [ ] Framework markers noted in the recon report
- [ ] Serialized state preferred over DOM selectors where available
- [ ] JSON endpoints called with the page's own parameters and pacing
- [ ] Browser used only for what nothing else provides, with a reason recorded

## See Also

- [JSON and Embedded Data](../parsing/json-and-embedded-data.md)
- [When You Need a Browser](../browser-automation/when-to-use-a-browser.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Choosing an Acquisition Strategy](scraping-decision-framework.md)
- [HTML and the DOM](../parsing/html-and-the-dom.md)
