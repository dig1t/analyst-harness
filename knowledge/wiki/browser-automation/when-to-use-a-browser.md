---
tags: [scraping, browser-automation, headless-browser, rendering, cost]
aliases: [Do I need a headless browser, browser vs HTTP client, JavaScript rendering decision]
---

# When You Need a Browser

> Sources: Playwright docs, Browsers and headless shell (https://playwright.dev/docs/browsers); Playwright docs, Docker (https://playwright.dev/docs/docker); Puppeteer docs, What is Puppeteer (https://pptr.dev/guides/what-is-puppeteer); Chrome for Developers, Chrome headless mode (https://developer.chrome.com/docs/chromium/headless); MDN, Lazy loading (https://developer.mozilla.org/en-US/docs/Web/Performance/Guides/Lazy_loading); MDN, template element and declarative shadow DOM (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/template)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A real browser (driven by Playwright, Puppeteer or Selenium) is the most expensive and most fragile way to get web data. Use one only when the data does not exist in any response you can request directly, or when the task truly requires an interaction you are allowed to perform. Most "JavaScript sites" still ship their data as JSON from an API or embed it in the initial HTML, and a plain HTTP client reads either at a small fraction of the cost. The decision is empirical: test the page with a plain request first, inspect the network traffic second, and reach for a browser last. When you do render, render only the pages that need it.

## What a browser costs

| Dimension | HTTP client (httpx, fetch, curl) | Headless browser |
|---|---|---|
| Work per page | One request, one response | The document plus every script, stylesheet, font, image and XHR it triggers |
| Memory | Small, mostly the response body | Tens to hundreds of MB per page, plus a browser process per worker |
| Throughput limit | Usually your politeness delay, not your machine | CPU and memory; expect far fewer pages per machine |
| Failure modes | Status codes, timeouts, parse errors | All of those plus renderer crashes, hung scripts and timing races |
| Maintenance | Selectors or JSON paths | Selectors, waits, browser upgrades, container quirks |
| What the site can observe | Headers, TLS handshake, IP | All of those plus a full JavaScript environment that bot defenses inspect |
| Security | Parses bytes | Executes untrusted code from every site you visit |

The security row is easy to forget. Playwright's Docker guide recommends, for scraping and crawling untrusted sites, a separate non-root user plus a seccomp profile so the Chromium sandbox stays enabled.

## Signs you do not need a browser

- A value you can see on screen (a price, a title, an ID) appears in `curl` output or in `view-source:`.
- The HTML carries embedded state: `<script type="application/ld+json">`, a `__NEXT_DATA__` blob or another `window.__STATE__` style object. See [JSON and Embedded Data](../parsing/json-and-embedded-data.md) and [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).
- The DevTools Network panel, filtered to Fetch/XHR, shows a JSON or GraphQL response that contains the data. Call that endpoint politely with an HTTP client after checking the terms ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).
- The site offers an official API, a feed, a sitemap or a bulk download ([Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
- Web components are server-rendered with declarative shadow DOM (`<template shadowrootmode="open">`), which an ordinary HTML parser reads as a `template` element.

## Signs you do need a browser

1. **The data exists only after client code runs** and the underlying requests cannot reasonably be replayed: payloads assembled from several calls, binary or streaming protocols, or output drawn into a canvas. If the requests carry tokens designed specifically to stop automation, treat that as the site saying no and ask for access instead of reverse engineering it ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).
2. **Navigation requires interaction with no URL equivalent**: client-side filters, "load more" buttons, multi-step forms ([Infinite Scroll and Lazy Loading](infinite-scroll-and-lazy-loading.md)).
3. **You need what a person sees**: screenshots, PDFs, computed layout or visibility, the accessibility tree, or a visual check of your own site.
4. **An authorized login flow needs a real browser** (SSO redirects, WebAuthn) and the account owner permits automation ([Authentication Patterns](../http/authentication-patterns.md)).
5. **State lives only in the running app**, for example a dashboard fed by a WebSocket, and no documented API exists ([WebSockets and Server-Sent Events](../apis/websockets-and-sse.md)).

## A five-minute test

1. Fetch the URL with an HTTP client and search the body for a known visible value.
2. Compare `view-source:` (server HTML) with the Elements panel (live DOM), as described in [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md).
3. Reload with JavaScript disabled in DevTools and see what survives.
4. Watch the Network panel while the data appears and look for JSON.
5. Only if all of that fails, render.

The script below automates steps 1 and 5. It uses an honest bot User-Agent in both modes.

```python
"""Usage: python needs_browser.py URL "text you can see on the page" """
import sys

import httpx
from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"


def in_raw_html(url: str, needle: str) -> bool:
    resp = httpx.get(url, headers={"User-Agent": UA}, follow_redirects=True, timeout=30)
    resp.raise_for_status()  # a 403 or 429 here is a signal to stop, not to render
    return needle in resp.text


def in_rendered_dom(url: str, needle: str) -> bool:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        try:
            page = browser.new_page(user_agent=UA)
            page.goto(url, wait_until="domcontentloaded")
            page.get_by_text(needle).first.wait_for(timeout=15_000)
            return True
        except PlaywrightTimeoutError:
            return False
        finally:
            browser.close()


if __name__ == "__main__":
    url, needle = sys.argv[1], sys.argv[2]
    if in_raw_html(url, needle):
        print("In the raw HTML: use an HTTP client and an HTML parser.")
    elif in_rendered_dom(url, needle):
        print("Only in the rendered DOM: look for the JSON request in DevTools before committing to a browser.")
    else:
        print("Not found: check spelling, consent walls, geo restrictions or login requirements.")
```

## Hybrid patterns

- **Discover with a browser, collect with HTTP.** Render once, watch the responses or record a HAR ([Network Interception and Response Capture](network-interception.md)), then page through the JSON endpoint with a rate-limited HTTP client.
- **Render as a fallback.** Parse with HTTP first; send a page to the browser only when the parse fails schema validation.
- **Log in with a browser, reuse the session.** For accounts you are authorized to automate, save the browser's storage state and load the cookies into an HTTP client where the site's terms allow it ([Cookies, Sessions and State](../http/cookies-and-sessions.md)).
- **Never** use a browser to collect a bot defense's challenge or clearance cookies so a faster client can replay them. That defeats an access control the site chose; see [How Headless Browsers Are Detected](headless-detection-explained.md).

## Picking a tool

| Situation | Good default |
|---|---|
| New project in Python or TypeScript | [Playwright](playwright.md) |
| Node-only team, Chrome-centric, wants raw DevTools Protocol access | [Puppeteer](puppeteer.md) |
| Java, C# or Ruby shop, existing Grid, real Safari, W3C standard protocol | [Selenium and WebDriver](selenium.md) |
| An LLM agent operating a browser for a user | [Agentic Browsing](../llm-scraping/agentic-browsing.md) |

## Pitfalls

- Assuming React, Vue or Angular means a browser is required. Many such sites are server-rendered or hydrate from embedded JSON.
- Rendering every page of a crawl when only a few need it, multiplying cost and load on the site.
- Waiting for "network idle" instead of the element or response that proves the data is present ([Waiting Strategies](waiting-strategies.md)).
- Treating a browser as a way around blocks. Bot defenses inspect browsers more deeply than HTTP clients, and the right response to a block is to slow down or ask.
- Missing lazy content: MDN notes that the `load` event can fire while lazily loaded images and iframes in the viewport have not loaded yet.
- Running untrusted pages as root with the sandbox disabled.

## Checklist

- [ ] Searched the raw HTML and embedded JSON for a known visible value
- [ ] Checked DevTools Network for a JSON or GraphQL source, and checked for an official API or feed
- [ ] Wrote down why a browser is needed (interaction, rendering, authorized login)
- [ ] Planned to render only the pages that need it
- [ ] Browser runs in a container as a non-root user, with timeouts and memory limits
- [ ] Honest User-Agent with contact details set on the browser context

## See Also

- [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Playwright](playwright.md)
- [Making Browsers Cheap](browser-resource-optimization.md)
