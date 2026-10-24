---
tags: [scraping, browser-automation, selenium, webdriver, python]
aliases: [Selenium, WebDriver, Selenium Grid, WebDriver BiDi, Selenium Manager]
---

# Selenium and WebDriver

> Sources: W3C WebDriver (https://www.w3.org/TR/webdriver2/); W3C WebDriver BiDi (https://www.w3.org/TR/webdriver-bidi/); Selenium docs, Waiting strategies (https://www.selenium.dev/documentation/webdriver/waits/); Selenium docs, WebDriver BiDi (https://www.selenium.dev/documentation/webdriver/bidi/); Selenium docs, BiDi network features (https://www.selenium.dev/documentation/webdriver/bidi/network/); Selenium docs, Browser options (https://www.selenium.dev/documentation/webdriver/drivers/options/); Selenium docs, Selenium Manager (https://www.selenium.dev/documentation/selenium_manager/); Selenium docs, Grid getting started (https://www.selenium.dev/documentation/grid/getting_started/); docker-selenium README (https://github.com/SeleniumHQ/docker-selenium)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Selenium is the long-standing open source browser automation project, and its WebDriver API became the W3C WebDriver standard. A client library (Java, Python, C#, Ruby, JavaScript) sends commands to a browser-specific driver (chromedriver, geckodriver, msedgedriver, safaridriver), and the driver controls a real browser. Selenium Manager, bundled with every release since 4.6, locates or downloads the matching driver, and since 4.11 can also fetch the browser. WebDriver BiDi adds a WebSocket channel for events such as network requests and console messages. Selenium remains the right tool for multi-language teams, existing Grid or device-cloud infrastructure, real Safari and standards-first environments. For capture-heavy scraping in Python or TypeScript, [Playwright](playwright.md) is usually simpler. Examples target Selenium 4.51 (October 2026).

## How the protocol works

Classic WebDriver is request/response over HTTP with JSON bodies. A few endpoints from the spec:

| Command | HTTP |
|---|---|
| New Session | `POST /session` (capabilities in the body) |
| Navigate To | `POST /session/{session id}/url` |
| Find Element | `POST /session/{session id}/element` |
| Get Element Text | `GET /session/{session id}/element/{element id}/text` |
| Get Element Shadow Root | `GET /session/{session id}/element/{element id}/shadow` |
| Execute Script | `POST /session/{session id}/execute/sync` |
| Get Page Source | `GET /session/{session id}/source` |
| Delete Session | `DELETE /session/{session id}` |

Every command is a round trip, so latency adds up when the browser runs on a remote Grid, and there is no push channel for events. The spec also defines `navigator.webdriver`, which reports true while the browser is under remote control ([How Headless Browsers Are Detected](headless-detection-explained.md)).

WebDriver BiDi keeps the session model and adds a bidirectional WebSocket. Its modules are `session`, `browser`, `browsingContext`, `emulation`, `network`, `script`, `storage`, `log`, `input` and `webExtension`. It is designed as a standardized, cross-browser alternative to the Chrome DevTools Protocol and is still a W3C Working Draft. Selenium turns it on with a capability (`options.enable_bidi = True` in Python, `webSocketUrl: true` in the raw capabilities), and the project is moving its own implementation onto BiDi while keeping the classic API working.

## A scrape with explicit waits

```python
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"

options = webdriver.ChromeOptions()
options.add_argument("--headless=new")
options.add_argument(f"--user-agent={UA}")
options.page_load_strategy = "eager"  # return at DOM ready, then wait explicitly

driver = webdriver.Chrome(options=options)  # Selenium Manager resolves chromedriver
try:
    driver.get("https://example.com/products")
    cards = WebDriverWait(driver, timeout=15).until(
        EC.presence_of_all_elements_located((By.CSS_SELECTOR, "[data-testid='product-card']"))
    )
    rows = [
        {
            "name": card.find_element(By.CSS_SELECTOR, "h2").text.strip(),
            "price": card.find_element(By.CSS_SELECTOR, ".price").text.strip(),
        }
        for card in cards
    ]
    print(rows)
finally:
    driver.quit()
```

If many small commands make a remote session slow, one `driver.execute_script("return ...")` call that returns every value at once replaces dozens of round trips.

## Waits

- **Page load strategy** decides when navigation returns: `normal` (default, `document.readyState` is `complete`), `eager` (`interactive`, DOM ready while images may still load) or `none`.
- **Implicit wait** is a session-wide timeout for element lookups. Its default is 0.
- **Explicit wait** is `WebDriverWait(driver, timeout, poll_frequency=0.5, ignored_exceptions=...)` polling a condition; it ignores `NoSuchElementException` by default. Use `expected_conditions` such as `visibility_of_element_located`, `element_to_be_clickable`, `invisibility_of_element_located`, `text_to_be_present_in_element`, `staleness_of`, `frame_to_be_available_and_switch_to_it`, `any_of` and `all_of`, or pass a lambda.
- The Selenium docs warn: do not mix implicit and explicit waits. A 10 s implicit wait combined with a 15 s explicit wait can time out after 20 s.

More patterns are in [Waiting Strategies](waiting-strategies.md).

## Network events with BiDi

```python
from selenium import webdriver

options = webdriver.ChromeOptions()
options.enable_bidi = True
driver = webdriver.Chrome(options=options)

api_calls = []


def remember(request):
    api_calls.append((request.method, request.url))


driver.network.add_request_handler(["**/api/**"], remember)
try:
    driver.get("https://example.com/products")
    print(api_calls)
finally:
    driver.quit()
```

The high-level handler continues each request automatically after observers run, so observing never stalls the page. In 4.51, response handlers expose status and headers but not bodies. To read JSON bodies, use the low-level BiDi data collector commands (`network.addDataCollector`, `network.getData`), Chromium-only CDP through `driver.execute_cdp_cmd`, or a capture-oriented tool such as Playwright ([Network Interception and Response Capture](network-interception.md)). Selenium Wire, a popular add-on for this, is no longer maintained.

## Shadow DOM and frames

```python
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

host = driver.find_element(By.CSS_SELECTOR, "product-card")
price = host.shadow_root.find_element(By.CSS_SELECTOR, ".price").text

WebDriverWait(driver, 10).until(
    EC.frame_to_be_available_and_switch_to_it((By.CSS_SELECTOR, "iframe#reviews"))
)
reviews = [r.text for r in driver.find_elements(By.CSS_SELECTOR, ".review")]
driver.switch_to.default_content()
```

Use CSS selectors inside shadow roots; XPath support there differs between drivers. Details in [Shadow DOM, iframes and Web Components](shadow-dom-and-iframes.md).

## Selenium Grid

Grid runs sessions on other machines. Standalone mode is a single process (`java -jar selenium-server-<version>.jar standalone`) listening on `http://localhost:4444`; Hub and Node mode spreads sessions over many machines. The docker-selenium images are the fastest start, and their README passes extra shared memory because browsers crash with Docker's small default:

```bash
docker run -d -p 4444:4444 --shm-size="2g" selenium/standalone-chrome:latest
```

```python
from selenium import webdriver

driver = webdriver.Remote(command_executor="http://localhost:4444", options=webdriver.ChromeOptions())
```

## Selenium vs Playwright vs Puppeteer

| | Selenium | Playwright | Puppeteer |
|---|---|---|---|
| Protocol | W3C WebDriver, plus BiDi | CDP for Chromium, its own protocol for patched Firefox and WebKit | CDP (Chrome), BiDi (Firefox) |
| Languages | Java, Python, C#, Ruby, JavaScript | TS/JS, Python, Java, .NET | JS/TS |
| Browsers | Chrome, Edge, Firefox, real Safari | Chromium, Firefox and WebKit builds, Chrome, Edge | Chrome, Firefox |
| Auto-waiting | No, explicit waits | Yes | Locator API |
| Network capture | BiDi handlers, CDP | Built in, HAR | Built in over CDP |
| Scale-out | Grid, commercial device clouds | Your own sharding, remote browsers | Your own |
| Mobile | Appium (built on WebDriver) | Emulation | Emulation |

## When Selenium is still the right choice

- The team automates in Java, C# or Ruby, or already runs a Grid or a cloud device farm that speaks WebDriver.
- You need the real Safari through safaridriver, or vendor-supported drivers for branded browsers.
- You need native or mobile web testing through Appium.
- Policy favors a W3C standard over a single vendor's API.

## Pitfalls

- Mixing implicit and explicit waits.
- `time.sleep()` instead of a condition.
- `StaleElementReferenceException` after a re-render; locate elements again instead of caching them.
- Calling `close()` (one window) instead of `quit()` (ends the session and the driver), leaving processes behind.
- `.text` returns only rendered, visible text; hidden nodes return an empty string.
- Code copied from old tutorials using `find_element_by_*` helpers, which Selenium 4 removed.

## Checklist

- [ ] Selenium Manager or pinned drivers, with browser and driver versions logged
- [ ] Explicit waits only, implicit wait left at 0
- [ ] `driver.quit()` in `finally`
- [ ] Honest User-Agent set through browser arguments
- [ ] BiDi enabled only where needed, handlers removed after use
- [ ] Grid containers given enough shared memory

## See Also

- [Playwright](playwright.md)
- [Puppeteer](puppeteer.md)
- [Waiting Strategies](waiting-strategies.md)
- [Shadow DOM, iframes and Web Components](shadow-dom-and-iframes.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
