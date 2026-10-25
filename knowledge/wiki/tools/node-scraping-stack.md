---
tags: [scraping, tools, nodejs, cheerio, crawlee]
aliases: [Node.js scraping, JavaScript scraping, TypeScript scraping, fetch, undici, got, cheerio, jsdom, Crawlee]
---

# Node.js Scraping Stack

> Sources: Node.js docs, fetch (https://nodejs.org/api/globals.html#fetch) and Modules: TypeScript (https://nodejs.org/api/typescript.html); undici (https://github.com/nodejs/undici); got (https://github.com/sindresorhus/got); cheerio documentation (https://cheerio.js.org/); jsdom (https://github.com/jsdom/jsdom); Crawlee documentation (https://crawlee.dev/) and repository (https://github.com/apify/crawlee); p-limit (https://github.com/sindresorhus/p-limit) and p-queue (https://github.com/sindresorhus/p-queue); Playwright (https://playwright.dev/docs/intro)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Node.js is a natural fit for scraping: the event loop handles many concurrent requests cheaply, the browser-automation tools (Playwright, Puppeteer) are native to it, and TypeScript gives typed records end to end. A good default is the built-in **`fetch`** (backed by undici) with explicit timeouts, **cheerio** for parsing HTML, **p-limit** or **p-queue** for concurrency, and **zod** for validation. **Crawlee** adds a full crawling framework (queues, retries, sessions, storage, HTTP and browser crawlers) when the job grows beyond a script. Most of these packages are now ESM-only and require recent Node versions.

## The libraries (versions as of 2026-10)

| Package | Role | Version | Node requirement and notes |
|---|---|---|---|
| `fetch` (built in) | HTTP | Node 18+ | Backed by undici; no retries; ignores `HTTP(S)_PROXY` unless `NODE_USE_ENV_PROXY=1` (Node 22.21+) |
| undici | Low-level HTTP client, agents, pools | 8.12 | Node 22.19+; `Agent`, `Pool`, `EnvHttpProxyAgent` |
| got | HTTP with retries, hooks, pagination | 16.1 | ESM-only, Node 22+; retries 2 times by default; no default timeout |
| cheerio | jQuery-like HTML parsing | 1.2 | Node 20.18.1+; no JavaScript execution |
| jsdom | Spec-compliant DOM in Node | 30.1 | Node 22.22.2+, 24.15+ or 26+; heavy; can run page scripts |
| linkedom | Lightweight DOM | 0.18 | Fast, less complete than jsdom |
| Crawlee | Crawling framework | 3.18 | `CheerioCrawler`, `PlaywrightCrawler`, `PuppeteerCrawler` and more |
| Playwright / Puppeteer | Browser automation | 1.64 / 25.16 | See [Playwright](../browser-automation/playwright.md) and [Puppeteer](../browser-automation/puppeteer.md) |
| p-limit / p-queue | Concurrency and rate limits | 7.3 / 10.0 | ESM-only |

Since Node 22.18, `node script.ts` runs TypeScript files directly by stripping types (erasable syntax only); use `tsc` or a bundler for enums, decorators and other non-erasable features.

## HTTP clients

| Need | `fetch` | got | undici `request` |
|---|---|---|---|
| Zero dependencies | Yes | No | Bundled in Node, or install the newer package |
| Timeouts | `signal: AbortSignal.timeout(ms)`; undici's header and body timeouts default to 300 s | `timeout: { request: ms }`; none by default | `headersTimeout`, `bodyTimeout` |
| Retries | Write your own (see [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)) | Built in: 408, 413, 429, 500, 502, 503, 504, 521, 522, 524; honors `Retry-After` | Retry interceptor |
| Proxy | `NODE_USE_ENV_PROXY=1` or an undici dispatcher | `agent` option | `ProxyAgent`, `EnvHttpProxyAgent` |
| Cookies | Manual header | `cookieJar` (tough-cookie) | Manual or interceptor |

Two rules for `fetch`: always set a timeout, and always read or cancel the body. The undici docs warn that leaving bodies to the garbage collector can exhaust connections and stall requests.

## Parsing with cheerio

cheerio parses HTML (with parse5 or htmlparser2) into a jQuery-style API; it does not run scripts or compute layout. Since 1.0 it also offers `$.extract()` for declarative extraction, and `baseURI` makes `prop("href")` return absolute URLs. Tested with cheerio 1.2 on Node 22:

```typescript
import * as cheerio from "cheerio";

const res = await fetch("https://books.toscrape.com/catalogue/page-1.html", {
  headers: { "user-agent": "acme-research-bot/1.0 (+https://acme.example/bot)" },
  signal: AbortSignal.timeout(15_000),
});
if (!res.ok) throw new Error(`HTTP ${res.status}`);
const $ = cheerio.load(await res.text(), { baseURI: res.url });

const books = $("article.product_pod")
  .map((_, el) => ({
    title: $(el).find("h3 a").attr("title"),
    url: $(el).find("h3 a").prop("href"), // absolute, resolved against baseURI
    price: $(el).find("p.price_color").text().trim(),
  }))
  .get();

const page = $.extract({
  title: "title",
  next: { selector: "li.next a", value: "href" },
  links: [{ selector: "article.product_pod h3 a", value: "href" }],
});
```

Use jsdom when you need real DOM APIs (`querySelectorAll` semantics, `textContent` with full spec behavior) on static HTML. Its `runScripts: "dangerously"` option executes the page's JavaScript inside your Node process: never enable it for untrusted sites; use a real browser instead (see [When You Need a Browser](../browser-automation/when-to-use-a-browser.md)).

## Crawlee

Crawlee wraps queueing, retries, autoscaled concurrency, sessions and storage around several crawler types: `HttpCrawler`, `CheerioCrawler`, `JSDOMCrawler`, `PlaywrightCrawler` and `PuppeteerCrawler`. Results go to `./storage` (datasets, key-value stores and request queues) by default. A polite `CheerioCrawler`, tested with Crawlee 3.18 against a local copy of the books sandbox, with a link to a robots.txt-disallowed page that was correctly skipped:

```typescript
import { CheerioCrawler, Dataset } from "crawlee";

const USER_AGENT = "acme-research-bot/1.0 (+https://acme.example/bot; bot@acme.example)";

const crawler = new CheerioCrawler({
  maxConcurrency: 2,             // parallel requests overall
  maxRequestsPerMinute: 60,      // hard ceiling on request rate
  sameDomainDelaySecs: 1,        // gap between requests to the same registrable domain
  maxRequestsPerCrawl: 500,      // safety stop for runaway crawls
  maxRequestRetries: 3,
  respectRobotsTxtFile: true,    // skip URLs that robots.txt disallows (also in enqueueLinks)
  preNavigationHooks: [
    (_ctx, gotOptions) => {
      // identify the bot honestly instead of sending generated browser-like headers
      gotOptions.useHeaderGenerator = false;
      gotOptions.headers = { ...gotOptions.headers, "user-agent": USER_AGENT };
    },
  ],
  async requestHandler({ request, $, enqueueLinks, log }) {
    if (request.label === "DETAIL") {
      await Dataset.pushData({
        url: request.loadedUrl,
        title: $("div.product_main h1").text().trim(),
        price: $("div.product_main p.price_color").first().text().trim(),
      });
      return;
    }
    log.info(`listing ${request.url}`);
    await enqueueLinks({ selector: "article.product_pod h3 a", label: "DETAIL" });
    await enqueueLinks({ selector: "li.next a" });
  },
});

await crawler.run(["https://books.toscrape.com/catalogue/page-1.html"]);
```

Things to know about Crawlee's defaults:

- Its HTTP crawlers use got-scraping, which generates browser-like headers, and the browser crawlers generate browser fingerprints. These defaults are designed to look like a regular browser. For an identifiable, polite bot, turn header generation off and set your own User-Agent as above (for browser crawlers, see the `browserPoolOptions` fingerprint settings), and see [Identifying Your Bot](../anti-bot/identifying-your-bot.md).
- In our test, the robots.txt request itself was sent by Crawlee with its default browser-like User-Agent, not through `preNavigationHooks`; the rules were applied for user agent `*` unless you pass `respectRobotsTxtFile: { userAgent: "..." }`.
- `sameDomainDelaySecs` is keyed by registrable domain, so it does nothing for bare IP addresses or `localhost` in local tests.
- `retryOnBlocked` is documented as trying to bypass detected bot protection. Leave it off; treat blocks as a signal to slow down or ask for access (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).
- Always set `maxRequestsPerCrawl` (the Crawlee docs recommend it to prevent infinite loops) and a `maxRequestsPerMinute` ceiling.

## Concurrency, CPU and memory

The event loop is single-threaded: network waits are cheap, CPU work is not. Cap concurrency globally and per host with `p-limit` and `p-queue`, feed big URL lists in batches, and move CPU-heavy parsing to `worker_threads` (see [Concurrency and Async IO](../operations/concurrency-and-async.md)). Unhandled promise rejections terminate the process by default in current Node versions, so handle every task promise.

## Pitfalls

- `fetch` without `AbortSignal.timeout()`, or got without a `timeout` option.
- Not consuming or cancelling response bodies.
- Assuming `fetch` honors `HTTPS_PROXY` like curl does.
- Mixing CommonJS `require()` with ESM-only packages (got, p-limit, p-queue); use `"type": "module"` or dynamic `import()`.
- jsdom with `runScripts: "dangerously"` on untrusted pages.
- Crawlee's generated headers and fingerprints presenting your crawler as a human browser.
- Parsing multi-megabyte pages on the main thread inside a busy crawler.

## Checklist

- [ ] Node version matches package requirements (22 LTS or newer for current majors)
- [ ] Every request has a timeout; every body is consumed or cancelled
- [ ] Concurrency capped globally and per host
- [ ] Honest User-Agent; header and fingerprint generation disabled where you identify yourself
- [ ] `respectRobotsTxtFile` (Crawlee) or your own robots.txt check
- [ ] Records validated (zod) before storage
- [ ] Crawl bounded with request and rate limits

## See Also

- [Python Scraping Stack](python-scraping-stack.md)
- [Go, Rust and Other Ecosystems](go-rust-and-others.md)
- [Playwright](../browser-automation/playwright.md)
- [Concurrency and Async IO](../operations/concurrency-and-async.md)
- [CSS Selectors for Extraction](../parsing/css-selectors.md)
- [Scraping Services and Platforms](scraping-services-and-platforms.md)
