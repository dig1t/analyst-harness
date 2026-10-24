---
tags: [scraping, anti-bot, bot-detection, bot-management, rate-limiting]
aliases: [bot detection, anti-bot systems, bot management basics, how sites detect scrapers]
---

# How Bot Detection Works

> Sources: OWASP Automated Threats to Web Applications (https://owasp.org/www-project-automated-threats-to-web-applications/); Cloudflare docs, Bot scores (https://developers.cloudflare.com/bots/concepts/bot-score/); Cloudflare docs, Bot detection engines (https://developers.cloudflare.com/bots/concepts/bot-detection-engines/); Cloudflare docs, JA3/JA4 fingerprint (https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/); Cloudflare docs, AI Labyrinth (https://developers.cloudflare.com/bots/additional-configurations/ai-labyrinth/); AWS WAF Developer Guide, Bot Control (https://docs.aws.amazon.com/waf/latest/developerguide/waf-bot-control.html); W3C, Mitigating Browser Fingerprinting in Web Specifications (https://www.w3.org/TR/fingerprinting-guidance/); RFC 6585, status code 429 (https://www.rfc-editor.org/rfc/rfc6585)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Bot detection is layered. Cheap checks run on every request (IP reputation, TLS and HTTP fingerprints, header sanity), statistical checks run over time (rates, paths, ratios), and expensive checks run only when needed (JavaScript environment probes, behavioral signals, challenges). The outputs are combined, often by machine learning trained across many sites, into a score or classification, and the site's own policy maps that score to an action: allow, log, rate limit, challenge, block or serve something else. For a scraper the practical lessons are that detection is probabilistic and cumulative, that honest and slow clients are usually the least suspicious, and that every action you see was configured by the site owner, who can also be asked to make an exception.

## Why sites run it

The OWASP Automated Threats handbook names 21 kinds of unwanted automation, among them OAT-011 Scraping, OAT-008 Credential Stuffing, OAT-005 Scalping, OAT-021 Denial of Inventory and OAT-015 Denial of Service. Even when a scraper means no harm, the defender sees the same traffic shapes as abuse: many requests, from infrastructure IPs, from clients that skip images and scripts. A growing driver is control over AI crawling, with CDNs offering per-category blocking of training crawlers and agents ([AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)).

## The layers

```text
client
  |
  v
[1] IP and network reputation        every request, very cheap
[2] TLS and HTTP/2 fingerprint       every connection, cheap
[3] HTTP headers and semantics       every request, cheap
[4] Rate and pattern analysis        per IP, session or fingerprint, over time
[5] JavaScript environment checks    needs a page load, runs in the browser
[6] Behavioral signals               needs interaction
[7] Scoring and reputation           combines all of the above, often across many sites
  |
  v
policy: allow | log | rate limit (429) | challenge | block (403) | alternate content
```

1. **IP and network reputation.** Is the address in a cloud or hosting network, a known proxy or VPN range, a residential or mobile network? Has it attacked other sites? Does it match the published ranges or reverse DNS of a known crawler ([Identifying Your Bot](identifying-your-bot.md))?
2. **Transport fingerprints.** The TLS ClientHello and HTTP/2 settings identify the client software family. Cloudflare exposes JA3 and JA4 fingerprints to bot management customers, along with per-fingerprint statistics such as how often that fingerprint looks like a browser or hits cache ([Browser and TLS Fingerprinting](fingerprinting.md)).
3. **Request semantics.** Header presence, values and order; a User-Agent consistent with everything else; `Accept-Language`, cookies and client hints that a real browser would send. Cloudflare's docs note that requests with a missing or empty User-Agent are immediately scored as automated ([Request Headers That Matter](../http/http-headers-for-scrapers.md)).
4. **Rate and pattern analysis.** Requests per time window per IP, session or fingerprint; burstiness and machine-regular intervals; sequential ID enumeration; deep links without the pages that normally precede them; only HTML and never assets; high error rates.
5. **JavaScript checks.** Scripts probe the browser environment for automation and inconsistencies, may run proof-of-work, and set a cookie or token that later requests must carry ([How Headless Browsers Are Detected](../browser-automation/headless-detection-explained.md)).
6. **Behavior.** Pointer movement, scrolling, keystroke timing and touch events on pages where people interact.
7. **Scoring.** Heuristics give high-confidence verdicts; machine learning and per-site anomaly detection produce graded scores. Cloudflare's bot score runs from 1 (almost certainly automated) to 99 (almost certainly human), with verified bots as a separate class. AWS WAF Bot Control similarly labels requests by bot category and verification status and offers a "targeted" level for sophisticated bots.

Traps complement the layers: links or form fields invisible to people, disallowed paths monitored for visitors, and decoy mazes. Cloudflare's AI Labyrinth, for example, injects hidden links that only crawlers ignoring no-crawl instructions follow, and records them.

## What each layer means for a polite scraper

| Layer | Example signal | Takeaway |
|---|---|---|
| IP reputation | Cloud ASN, shared proxy range | Run from stable, published egress IPs and say who you are |
| Fingerprints | Library TLS stack with a browser User-Agent | Do not claim to be a browser; honest claims are consistent claims |
| Headers | Missing User-Agent | Always send a descriptive User-Agent with contact details |
| Rate and patterns | 20 requests per second, sequential IDs | Pace per host, add jitter, prefer sitemaps and feeds ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)) |
| JS checks | Challenge cookie required | You have reached a gate; see [CAPTCHAs and What They Mean for Your Project](captchas.md) |
| Traps | Requests to hidden or disallowed URLs | Honor robots.txt and `nofollow`, cap depth ([Spider Traps and Crawl Hygiene](../crawling/spider-traps.md)) |
| Scoring | Low score across many sites | Reputation is shared; misbehavior on one site follows you |

## Enforcement actions

- **Allow or log only**, often the default for new rules.
- **Rate limit** with HTTP 429, ideally with `Retry-After` ([API Rate Limits and Quotas](../apis/api-rate-limits.md)).
- **Challenge** with a non-interactive, managed or interactive challenge page.
- **Block** with HTTP 403, sometimes with a reference ID you can quote when contacting the site.
- **Serve alternate content**: cached, degraded or decoy pages, or simply fewer results. These soft blocks are covered in [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md).
- **Allowlist** verified bots and partners, which is why identification and verification programs matter ([WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)).

## Pitfalls

- "The right headers are enough." Headers are one cheap layer among many.
- "Rotating IPs fixes it." It is evasion, it is detectable (fingerprints and behavior persist across IPs), and it turns a polite request into an adversarial one.
- "A 200 means success." Challenge and decoy pages often return 200; validate content.
- "Bot management ignores robots.txt." Verified-bot programs require obeying it, and traps catch crawlers that do not.
- Assuming detection is personal. Most rules are generic; contacting the site often resolves a false positive quickly.

## Checklist

- [ ] Descriptive User-Agent with contact details on every request
- [ ] Stable egress IPs, ideally documented on a bot page
- [ ] Per-host rate limits with jitter, plus backoff on 429 and 503
- [ ] Content validation that detects challenge and decoy pages
- [ ] robots.txt honored, traps avoided with depth and parameter limits
- [ ] A contact path ready for when a site blocks you

## See Also

- [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md)
- [Browser and TLS Fingerprinting](fingerprinting.md)
- [WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)
- [Identifying Your Bot](identifying-your-bot.md)
- [How Headless Browsers Are Detected](../browser-automation/headless-detection-explained.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
