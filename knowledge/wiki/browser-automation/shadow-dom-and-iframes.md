---
tags: [scraping, browser-automation, shadow-dom, iframes, web-components]
aliases: [Shadow DOM, iframes, web components, frame handling, declarative shadow DOM]
---

# Shadow DOM, iframes and Web Components

> Sources: MDN, Using shadow DOM (https://developer.mozilla.org/en-US/docs/Web/API/Web_components/Using_shadow_DOM); MDN, Element.attachShadow (https://developer.mozilla.org/en-US/docs/Web/API/Element/attachShadow); MDN, template element and shadowrootmode (https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/template); MDN, Element.getHTML (https://developer.mozilla.org/en-US/docs/Web/API/Element/getHTML); Playwright docs, Locate in Shadow DOM (https://playwright.dev/docs/locators#locate-in-shadow-dom); Playwright docs, Frames (https://playwright.dev/docs/frames); Puppeteer docs, Querying elements in Shadow DOM (https://pptr.dev/guides/page-interactions); Selenium docs, Finders (https://www.selenium.dev/documentation/webdriver/elements/finders/); Selenium docs, Working with frames (https://www.selenium.dev/documentation/webdriver/interactions/frames/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Web components hide their internals in a **shadow root** attached to a host element. A plain `document.querySelector()` does not cross that boundary, and neither do the standard HTML serializations (`innerHTML`, `outerHTML`, Playwright's `page.content()` by default). **iframes** embed a separate document, possibly from another origin and, in Chromium, often in another process. Each automation tool handles these differently: Playwright's CSS and text locators pierce open shadow roots automatically; Puppeteer adds `>>>` combinators; Selenium exposes `shadow_root`. Frames need a frame locator or an explicit switch. Closed shadow roots are deliberately unreachable from outside, and server-rendered declarative shadow DOM can often be parsed without a browser at all.

## Shadow DOM in one minute

- A **host** element (for example `<product-card>`) gets a shadow root via `attachShadow({ mode: 'open' })` or `'closed'`. For closed roots, `host.shadowRoot` returns `null`.
- **Slots** project the host's light DOM children into the shadow tree. Slotted content stays in the light DOM, so normal selectors find it; only the component's own markup lives in the shadow root.
- **Declarative shadow DOM** puts the shadow root in the HTML as `<template shadowrootmode="open">` inside the host. The browser's parser converts it into a real shadow root. An offline HTML parser just sees a `template` element with children, which you can usually select directly (older pages may use the non-standard `shadowroot` attribute that Chrome supported for a while).
- **Serialization**: `Element.getHTML({ serializableShadowRoots: true })` includes shadow roots marked serializable, and its `shadowRoots` option includes specific roots you pass in. Playwright 1.64 added `page.content({ includeShadow: true })`, which serializes open roots as declarative shadow DOM.

## Tool support

| Situation | Playwright | Puppeteer | Selenium | Plain DOM |
|---|---|---|---|---|
| Open shadow root | CSS and text locators pierce it by default | `host >>> .inner`, `>>>>` for the immediate root, legacy `pierce/` | `host.shadow_root.find_element(...)` | `host.shadowRoot.querySelector()` |
| Closed shadow root | Not supported | Not reachable | Not reachable | `shadowRoot` is `null` |
| XPath into shadow trees | No | No (`::-p-xpath` uses `document.evaluate`) | Varies by driver; use CSS | No |
| Same-origin iframe | `frameLocator()`, `locator.contentFrame()` | `elementHandle.contentFrame()` | `switch_to.frame()` | `iframe.contentDocument` |
| Cross-origin iframe | Same API | Same API | Same API | `contentDocument` is `null` |

## Reading shadow content

```ts
// Playwright: chain from the host; the inner locator searches the host's shadow root too
const cards = page.locator('product-card');
await cards.first().waitFor();
const names = await cards.locator('h3').allTextContents();
await cards.filter({ hasText: 'Blue mug' }).getByRole('button', { name: 'Add to cart' }).click();
```

```ts
// Puppeteer: deep combinator
const prices = await page.$$eval('product-card >>> .price', els => els.map(e => e.textContent?.trim()));
```

```python
# Selenium
from selenium.webdriver.common.by import By

for host in driver.find_elements(By.CSS_SELECTOR, "product-card"):
    root = host.shadow_root
    print(root.find_element(By.CSS_SELECTOR, "h3").text, root.find_element(By.CSS_SELECTOR, ".price").text)
```

When you extract with one `evaluate` call (Playwright or Puppeteer), walk open roots yourself:

```ts
const prices = await page.evaluate(() => {
  function deepQueryAll(root: Document | ShadowRoot, selector: string, out: Element[] = []): Element[] {
    out.push(...root.querySelectorAll(selector));
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, out);
    }
    return out;
  }
  return deepQueryAll(document, '.price').map(e => e.textContent?.trim() ?? '');
});
```

To archive or parse later, serialize with shadow content and use an ordinary parser:

```python
from bs4 import BeautifulSoup

html = page.content(include_shadow=True)  # Playwright 1.64+, open roots only
soup = BeautifulSoup(html, "html.parser")
prices = [el.get_text(strip=True) for el in soup.select("product-card template[shadowrootmode] .price")]
```

The same selector works on server-rendered declarative shadow DOM fetched with plain HTTP. Check how your parser treats `template` contents before relying on it ([HTML and the DOM](../parsing/html-and-the-dom.md)).

**Closed roots** are the component author's explicit choice to hide internals. Treat them as a signal to look for the data elsewhere: the network response that fed the component ([Network Interception and Response Capture](network-interception.md)), embedded JSON, or the visible text exposed through accessible roles and labels.

## Working with iframes

First, consider whether you need the parent page at all. If the iframe's `src` is an ordinary page you are allowed to fetch, loading it directly is simpler and cheaper. Some embeds need the parent context (a referrer, a token passed by `postMessage`); in that case work through the frame.

```ts
// Playwright
const reviews = page.frameLocator('iframe#reviews').locator('.review');
await reviews.first().waitFor();
const texts = await reviews.allTextContents();

const frame = page.locator('iframe[title="Reviews"]').contentFrame(); // from a locator (1.43+)
await frame.getByRole('button', { name: 'More reviews' }).click();

await page.frameLocator().getByRole('button', { name: 'Show all' }).click(); // any frame (1.63+)
```

```python
# Playwright (Python)
reviews = page.frame_locator("iframe#reviews").locator(".review")
reviews.first.wait_for()
texts = reviews.all_text_contents()
frame = page.frame(url=r".*reviews\.example\.com.*")  # a Frame object, for evaluate() and friends
```

```ts
// Puppeteer
const handle = await page.waitForSelector('iframe#reviews');
const frame = await handle?.contentFrame();
if (!frame) throw new Error('reviews iframe not found');
const texts = await frame.$$eval('.review', els => els.map(e => e.textContent?.trim()));
await handle?.dispose();
// Or wait for the frame by URL: await page.waitForFrame(f => f.url().includes('reviews.example.com'))
```

```python
# Selenium: switch in, work, switch back
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

WebDriverWait(driver, 10).until(EC.frame_to_be_available_and_switch_to_it((By.CSS_SELECTOR, "iframe#reviews")))
texts = [r.text for r in driver.find_elements(By.CSS_SELECTOR, ".review")]
driver.switch_to.default_content()  # or switch_to.parent_frame() for one level up
```

Script running in the parent cannot read a cross-origin frame (`contentDocument` is `null` under the same-origin policy), so run evaluation in the frame itself (`frame.evaluate()` in Playwright and Puppeteer, or `execute_script` after switching in Selenium). Nested frames chain: a frame locator inside a frame locator, or successive switches.

## Pitfalls

- XPath selectors that silently find nothing inside shadow trees.
- Archiving `page.content()` without `includeShadow` and losing component content.
- Selenium code that forgets `switch_to.default_content()`, so later lookups fail.
- Stale frame references after the iframe navigates or is re-created; re-locate it.
- Lazy iframes (`loading="lazy"`) that have no content until scrolled near.
- Since Playwright 1.64, elements inside hidden iframes count as hidden, so visibility waits on them time out.
- Patching page internals to force closed roots open; it changes the page under test and breaks easily.

## Checklist

- [ ] Checked whether the data is in declarative shadow DOM or a JSON response first
- [ ] CSS (not XPath) used inside shadow trees
- [ ] iframe `src` evaluated as a direct fetch target
- [ ] Frame locators or explicit switches, with switch-back in Selenium
- [ ] Shadow content included when archiving rendered HTML

## See Also

- [Playwright](playwright.md)
- [Puppeteer](puppeteer.md)
- [Selenium and WebDriver](selenium.md)
- [CSS Selectors for Extraction](../parsing/css-selectors.md)
- [HTML and the DOM](../parsing/html-and-the-dom.md)
- [Writing Robust Selectors](../parsing/robust-selectors.md)
