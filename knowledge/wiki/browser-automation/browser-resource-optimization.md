---
tags: [scraping, browser-automation, performance, cost, docker]
aliases: [Making browsers cheap, headless performance, browser pooling, blocking resources]
---

# Making Browsers Cheap

> Sources: Playwright docs, Network: abort requests (https://playwright.dev/docs/network); Playwright docs, Isolation (https://playwright.dev/docs/browser-contexts); Playwright docs, Browsers and headless shell (https://playwright.dev/docs/browsers); Playwright docs, Docker (https://playwright.dev/docs/docker); Puppeteer docs, Request interception (https://pptr.dev/guides/network-interception); Puppeteer docs, Headless mode (https://pptr.dev/guides/headless-modes); Puppeteer docs, Troubleshooting (https://pptr.dev/troubleshooting); Chromium source, base_switches.h (https://github.com/chromium/chromium/blob/main/base/base_switches.h); Docker docs, docker container run (https://docs.docker.com/reference/cli/docker/container/run/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Browser cost comes from process startup, a renderer per page, every subresource the page pulls in, JavaScript execution, layout and paint. The big wins, in order: do not use a browser (use HTTP or the site's JSON API); render fewer pages; block resources you do not need; keep one long-lived browser per worker and give each job a fresh, short-lived context; bound concurrency by memory, not CPU count; recycle browsers periodically; and run them in containers configured for Chromium. Measure pages per minute, bytes and memory per page, and crash rate, and tune from data. Cheaper browsers also mean lighter load on the sites you visit.

## Levers at a glance

| Lever | Typical effect | Risk or cost |
|---|---|---|
| Use HTTP or the JSON API instead | Largest | Requires finding the endpoint ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)) |
| Render only pages that need it | Large | Needs a reliable "HTTP parse failed" signal |
| Block images, media, fonts | Large bandwidth and time savings | Image-dependent checks break |
| Block third-party hosts you verified are unnecessary | Medium | Pages that depend on them can break |
| One browser per worker, new context per job | Avoids repeated process startup | Contexts must always be closed |
| Concurrency sized by memory | Prevents out-of-memory crashes | Too low wastes capacity |
| Recycle the browser after N jobs | Caps slow memory growth | A restart every N jobs |
| chromium-headless-shell for simple pages | Lower overhead | Less faithful than new headless |
| No video, trace or screenshots by default | Small to medium | Less evidence; enable on failure |

## Block what you do not need

Images, media and fonts are usually the bulk of the bytes. Analytics and ad scripts add CPU time and requests. Stylesheets are tempting but risky: Playwright's visibility checks depend on computed styles, so blocking CSS can make hidden elements look visible or break layout-dependent pages.

```ts
// Playwright (TypeScript): block heavy types and hosts you have checked are not needed
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);
const BLOCKED_HOSTS = ['analytics.example.net', 'ads.example.net'];

await context.route('**/*', route => {
  const req = route.request();
  const host = new URL(req.url()).hostname;
  if (BLOCKED_TYPES.has(req.resourceType()) || BLOCKED_HOSTS.some(h => host === h || host.endsWith(`.${h}`))) {
    return route.abort();
  }
  return route.continue();
});
```

```ts
// Puppeteer: the same idea with request interception
await page.setRequestInterception(true);
page.on('request', req => {
  if (req.isInterceptResolutionHandled()) return;
  if (['image', 'media', 'font'].includes(req.resourceType())) req.abort();
  else req.continue();
});
```

In Playwright, enabling routing disables the HTTP cache. For crawls that revisit the same site, compare the bytes saved by blocking with the bytes lost to caching before deciding. Never block the XHR or fetch requests that carry your data; check the Network panel first ([Network Interception and Response Capture](network-interception.md)).

## Reuse, isolate, bound and recycle

Playwright describes browser contexts as fast and cheap to create and completely isolated, even within one browser. That gives a simple model: each worker owns one browser, each job gets a new context, and the context is closed when the job ends. The Python sketch below adds memory-safe concurrency, per-page timeouts and periodic recycling.

```python
import asyncio

from playwright.async_api import async_playwright

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"
WORKERS = 3              # size by available memory, and by the target site's rate limits
JOBS_PER_BROWSER = 200   # recycle to cap slow memory growth
PAGE_TIMEOUT_MS = 30_000
BLOCK = {"image", "media", "font"}


async def block_heavy(route):
    if route.request.resource_type in BLOCK:
        await route.abort()
    else:
        await route.continue_()


async def scrape_one(browser, url: str) -> dict:
    context = await browser.new_context(user_agent=UA, viewport={"width": 1280, "height": 800})
    try:
        await context.route("**/*", block_heavy)
        page = await context.new_page()
        page.set_default_timeout(PAGE_TIMEOUT_MS)
        await page.goto(url, wait_until="domcontentloaded")
        return {"url": url, "title": await page.title()}
    finally:
        await context.close()  # frees the renderer even when the job fails


async def worker(pw, queue: asyncio.Queue, results: list) -> None:
    browser = await pw.chromium.launch()
    jobs = 0
    try:
        while True:
            url = await queue.get()
            try:
                if jobs >= JOBS_PER_BROWSER or not browser.is_connected():
                    await browser.close()
                    browser = await pw.chromium.launch()
                    jobs = 0
                results.append(await scrape_one(browser, url))
            except Exception as exc:  # record and move on; crashes happen at scale
                results.append({"url": url, "error": repr(exc)})
            finally:
                jobs += 1
                queue.task_done()
    finally:
        await browser.close()


async def main(urls: list[str]) -> list:
    queue: asyncio.Queue = asyncio.Queue()
    for url in urls:
        queue.put_nowait(url)
    results: list = []
    async with async_playwright() as pw:
        tasks = [asyncio.create_task(worker(pw, queue, results)) for _ in range(WORKERS)]
        await queue.join()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    return results


if __name__ == "__main__":
    print(asyncio.run(main(["https://example.com/a", "https://example.com/b"])))
```

For higher density, run several contexts concurrently inside one browser; for stronger isolation, one browser per worker as above. If many URLs belong to one host, add a per-host limit on top of the worker count ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md), [Concurrency and Async IO](../operations/concurrency-and-async.md)). Watch for crashes with `page.on('crash')` in Playwright or the `'error'` page event in Puppeteer.

## Pick the lighter browser build when it is enough

- Playwright's default headless launch uses chromium-headless-shell, and headless-only images can install just that with `playwright install --only-shell`. `channel: 'chromium'` switches to the new headless mode, which is the real Chrome and more faithful.
- Puppeteer defaults to the new headless mode; `headless: 'shell'` selects chrome-headless-shell, which its docs describe as more performant when the complete Chrome feature set is not needed.

## Containers and memory

- **Shared memory.** Docker gives containers a small `/dev/shm` by default. Playwright recommends `--ipc=host` for Chromium ("without it, Chromium can run out of memory and crash"); docker-selenium passes `--shm-size="2g"`. Chromium's own `--disable-dev-shm-usage` switch, documented in its source for environments where `/dev/shm` is too small, makes it use a temporary directory instead.
- **Init process.** `docker run --init` avoids zombie browser processes (recommended by both Playwright and Puppeteer).
- **Sandbox.** For scraping untrusted sites, Playwright recommends a separate non-root user with its seccomp profile; Puppeteer strongly discourages `--no-sandbox` unless the content is fully trusted.
- **Limits.** Set container memory and CPU limits and alert on resident memory per worker.

```bash
docker run --rm --init --ipc=host --user pwuser \
  --security-opt seccomp=seccomp_profile.json --memory=2g --cpus=2 \
  mcr.microsoft.com/playwright/python:v1.64.1-noble python scrape.py
```

## Smaller levers

- Extract with one `evaluate` or `evaluateAll` call instead of many element round trips.
- Fetch JSON with `context.request` (it shares cookies) instead of navigating a page to it.
- Keep viewports modest and skip screenshots, PDFs, video and tracing unless a job fails.
- Cache static responses during development with HAR replay instead of re-downloading.
- Schedule heavy rendering jobs off-peak for the target site.

## Pitfalls

- Contexts or pages not closed on exceptions, slowly exhausting memory.
- Concurrency set from CPU count; browsers usually run out of memory first.
- Blocking stylesheets or scripts the page needs, then debugging "missing" elements.
- Serverless functions with small `/tmp` space, cold starts and execution limits ([Cheap Hosting for Scrapers](../operations/cheap-hosting.md)).
- Tracing every job in production.
- Treating cost savings as license to crawl faster than the site allows.

## Checklist

- [ ] Browser use justified per page type; HTTP path used where possible
- [ ] Images, media and fonts blocked unless needed
- [ ] One browser per worker, fresh context per job, closed in `finally`
- [ ] Concurrency sized by memory and per-host limits
- [ ] Browser recycled after N jobs and on disconnect or crash
- [ ] Container uses `--init`, enough shared memory, a non-root user and limits
- [ ] Metrics recorded: pages per minute, bytes and memory per page, crash rate

## See Also

- [Cost Control](../operations/cost-control.md)
- [Concurrency and Async IO](../operations/concurrency-and-async.md)
- [Cheap Hosting for Scrapers](../operations/cheap-hosting.md)
- [When You Need a Browser](when-to-use-a-browser.md)
- [Network Interception and Response Capture](network-interception.md)
- [Playwright](playwright.md)
