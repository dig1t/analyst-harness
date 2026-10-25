---
tags: [scraping, browser-automation, headless, bot-detection, ethics]
aliases: [headless detection, automation detection, navigator.webdriver, HeadlessChrome]
---

# How Headless Browsers Are Detected

> Sources: W3C WebDriver, Interface: navigator.webdriver (https://www.w3.org/TR/webdriver2/#interface); MDN, Navigator.webdriver (https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver); Chromium source, user_agent_utils.cc (https://github.com/chromium/chromium/blob/main/components/embedder_support/user_agent_utils.cc); Chrome for Developers, Chrome headless mode (https://developer.chrome.com/docs/chromium/headless); Cloudflare docs, Bot scores and detection engines (https://developers.cloudflare.com/bots/concepts/bot-score/); Cloudflare docs, Turnstile testing (https://developers.cloudflare.com/turnstile/troubleshooting/testing/); OWASP Automated Threats to Web Applications (https://owasp.org/www-project-automated-threats-to-web-applications/); Vastel et al., "FP-Scanner: The Privacy Implications of Browser Fingerprint Inconsistencies" (USENIX Security 2018); Vastel et al., "FP-Crawlers: Studying the Resilience of Browser Fingerprinting to Block Crawlers" (MADWeb 2020); Jonker, Krumnow and Vlot, "Fingerprint Surface-Based Detection of Web Bot Detectors" (ESORICS 2019)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Sites check whether a visitor is an automated browser because automation powers most large-scale abuse: credential stuffing, scalping, carding, fake account creation and aggressive scraping. Detection rarely relies on a single test. Bot defenses combine many weak signals (what the browser declares about itself, whether its environment is internally consistent, side effects of automation, network-level fingerprints, behavior and reputation) into a score, and then allow, challenge or block. This article explains those signal families conceptually, so you can understand why automated sessions get noticed and respond well. It deliberately does not describe how to hide automation. The vault's position is that a site's decision to limit bots is answered by slowing down, identifying yourself or asking for access.

## Why sites look for automation

The OWASP Automated Threats project catalogs the abuse behind these checks, including OAT-008 Credential Stuffing, OAT-005 Scalping, OAT-019 Account Creation, OAT-021 Denial of Inventory, OAT-009 CAPTCHA Defeat and OAT-011 Scraping. The costs are concrete: fraud losses, hoarded inventory, infrastructure load and skewed analytics. Headless browsers get extra scrutiny because they execute JavaScript and resemble real users far more than simple HTTP clients do. The same checks also catch legitimate automation: Cloudflare's Turnstile documentation says test suites built with Selenium, Cypress or Playwright are detected as bots, and gives site owners test keys for that reason.

## Signal families

| Family | What is examined (conceptually) | Why it is informative |
|---|---|---|
| Declared automation | `navigator.webdriver`; a `HeadlessChrome` token in the User-Agent | Standards and browsers announce automation on purpose |
| Environment consistency | Whether screen and window metrics, fonts, graphics stack, languages, time zone and client hints agree with each other and with the claimed browser and OS | Automated and virtualized environments often have unusual or contradictory combinations |
| Automation side effects | Traces that automation protocols or injected scripts leave in the page environment, and timing anomalies | Driving a browser programmatically is not perfectly invisible |
| Network fingerprints | TLS and HTTP/2 characteristics compared with the claimed browser; datacenter IP ranges | A Chrome User-Agent over a different network stack is a contradiction ([Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md)) |
| Behavior | Pointer movement, scrolling, typing cadence, navigation paths, request timing and volume | Scripts are fast, regular and goal-directed in ways people are not |
| Reputation and history | IP and network reputation, cookie history, earlier challenges passed or failed | Past behavior predicts future behavior |

Cloudflare's documentation, for example, lists heuristics, machine learning, anomaly detection and a dedicated "JavaScript detections" engine that targets headless browsers and other automation tools. Other vendors describe similar layers ([How Bot Detection Works](../anti-bot/how-bot-detection-works.md)).

## Declared signals

The W3C WebDriver specification defines a `webdriver-active` flag and the `navigator.webdriver` attribute, described as "a standard way for co-operating user agents to inform the document that it is controlled by WebDriver". MDN documents that Chrome sets it when launched with `--enable-automation` or `--headless` (or with a remote debugging port of 0), and Firefox when Marionette is enabled. Chromium's User-Agent code prefixes the product name with `Headless` when the `--headless` switch is present, so a default headless Chrome reports `HeadlessChrome/<version>`. These are intentional disclosures, which says something about the norms of the web platform: automation is expected to be identifiable.

## Headless modes are not invisibility

Chrome's new headless mode is the real Chrome browser running without a window, and the older implementation now ships separately as chrome-headless-shell. The new mode removed many accidental differences from headed Chrome, but detection never depended on one quirk. Research shows why patching individual signals does not work well: FP-Scanner (USENIX Security 2018) showed that fingerprints altered by spoofing tools contain detectable inconsistencies, FP-Crawlers (MADWeb 2020) measured how fingerprint-based detection holds up against crawlers that try to evade it, and Jonker and colleagues (ESORICS 2019) showed that bot detectors are themselves recognizable from the browser properties they probe. Defenders that aggregate many signals keep the advantage over automation that patches signals one at a time.

## What detection looks like from your side

- Nothing visible, but the session is scored and logged.
- A JavaScript or managed challenge page, sometimes an interactive CAPTCHA ([CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)).
- Rate limiting (HTTP 429) or a block (HTTP 403), often issued by the CDN rather than the origin ([WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md)).
- Soft blocks: empty results, truncated pages, decoy content, or honeypot link mazes aimed at crawlers that ignore no-crawl instructions.
- Restrictions on the account you were logged in with.

## Responding responsibly

1. **Treat detection as a message.** The site has decided how much automation it accepts on that path.
2. **Do not try to hide.** Tools that mask automation signals exist. Using them against a site that limits bots is out of scope for this vault: it is deceptive, often breaches terms of service, can add legal risk ([Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md)) and starts an escalating arms race.
3. **Identify yourself.** A descriptive User-Agent with contact details, a public bot page and, where available, a verified-bot program ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)).
4. **Shrink your footprint.** Fewer pages, lower concurrency, longer delays, HTTP instead of a browser where possible, and robots.txt honored.
5. **Ask for access.** An official API, a data feed, a license or an allowlist entry is more reliable than any browser configuration ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).
6. **On your own site**, configure bot management to let your monitors and tests through (allowlisted IPs, signed requests, CAPTCHA test keys in staging) instead of fighting your own defenses.
7. **For agents acting for a person**, prefer mechanisms built for that purpose, such as signed agents using Web Bot Auth, and hand control back to the person when a site asks for human verification ([Agentic Browsing](../llm-scraping/agentic-browsing.md)).

## Pitfalls

- Believing that headless, or new headless, means undetectable.
- Setting a User-Agent that claims a different browser or OS. The claim is false, and the mismatch with every other signal is itself conspicuous.
- Running from cloud IP ranges at high speed and expecting to be treated like a person on a home connection.
- Retrying challenged requests in tight loops, which looks like an attack.
- Treating a false positive as a puzzle to solve rather than a reason to contact the site. Privacy browsers, accessibility tools and corporate proxies trip these checks too.

## Checklist

- [ ] Automation is disclosed (default `navigator.webdriver`, honest User-Agent, contact details)
- [ ] A browser is used only where HTTP is insufficient
- [ ] Rate and concurrency are set for the site, and robots.txt is honored
- [ ] Challenges and blocks are detected and stop the job for human review
- [ ] Access requests or verified-bot applications considered for important sources

## See Also

- [How Bot Detection Works](../anti-bot/how-bot-detection-works.md)
- [Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
- [When You Need a Browser](when-to-use-a-browser.md)
- [Agentic Browsing](../llm-scraping/agentic-browsing.md)
