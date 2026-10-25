---
tags: [scraping, anti-bot, waf, cdn, verified-bots]
aliases: [WAF, web application firewall, CDN bot management, verified bots program, bot manager]
---

# WAFs and CDN Bot Management

> Sources: OWASP CRS project (https://coreruleset.org/); OWASP CRS rules (https://github.com/coreruleset/coreruleset); Cloudflare docs, Bots (https://developers.cloudflare.com/bots/); Cloudflare docs, Bot scores (https://developers.cloudflare.com/bots/concepts/bot-score/); Cloudflare docs, Verified bots (https://developers.cloudflare.com/bots/concepts/bot/verified-bots/); Cloudflare docs, Bot Fight Mode (https://developers.cloudflare.com/bots/get-started/bot-fight-mode/); Cloudflare docs, Interstitial Challenge Pages (https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/); Cloudflare docs, Block AI Bots (https://developers.cloudflare.com/bots/additional-configurations/block-ai-bots/); Cloudflare docs, What is Pay Per Crawl (https://developers.cloudflare.com/ai-crawl-control/features/pay-per-crawl/what-is-pay-per-crawl/); Cloudflare docs, HTTP headers (https://developers.cloudflare.com/fundamentals/reference/http-headers/); AWS WAF Developer Guide, Bot Control (https://docs.aws.amazon.com/waf/latest/developerguide/waf-bot-control.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A web application firewall (WAF) inspects HTTP requests and blocks those that match attack signatures or the site's own rules. Bot management classifies clients as likely human, likely automated or verified bot, and applies the action the site owner chose: allow, log, rate limit, challenge or block. Both usually run at the CDN edge (Cloudflare, Akamai, Fastly, Amazon CloudFront with AWS WAF, Google Cloud Armor and others) in front of the origin server, so a scraper is often talking to the edge's policy rather than the site's application. Knowing what these products do helps you classify blocks correctly, avoid tripping generic rules by accident, and use the legitimate routes they offer: verified-bot programs, allowlisting by the site owner, and AI crawler controls that state the owner's preferences explicitly.

## What a WAF does

- **Managed signature rules.** The OWASP Core Rule Set (CRS) is the widely used open source example: rules for SQL injection, cross-site scripting, protocol violations and more, usually in anomaly-scoring mode with selectable paranoia levels.
- **Protocol enforcement.** CRS rule 920320 flags a request with no User-Agent header, and 920330 an empty one.
- **Scanner detection.** CRS rule 913100 matches User-Agents associated with security scanners.
- **IP, geo and reputation rules**, and **rate limiting** per IP, path or other keys.
- **Custom rules** written by the owner, including allowlists for partners.

Scrapers trip WAF rules by accident more often than people expect: a missing User-Agent, search terms with quotes or SQL keywords in the query string, odd header combinations, or plain volume. These false positives are usually fixed by a polite message to the site.

## What bot management adds

| Capability | Example | What a scraper sees |
|---|---|---|
| Detection engines | Heuristics, machine learning, per-site anomaly detection, JavaScript detections (Cloudflare) | Nothing directly; a score attached to each request |
| Bot score | Cloudflare: 1 (automated) to 99 (human); groups "automated" (1), "likely automated" (2 to 29), "likely human" (30 to 99), plus "verified bot" | Actions at thresholds the owner chose |
| Fingerprints | JA3 and JA4 values with per-fingerprint statistics | Consistent treatment of a client type across IPs |
| Challenges | Non-interactive, managed and interactive challenge pages; Turnstile widgets | HTML challenge pages, `cf-mitigated: challenge` |
| Category controls | AWS WAF Bot Control labels requests by bot category and verification status, with common and targeted inspection levels | Category-wide allow or block |
| Free tiers | Cloudflare Bot Fight Mode sends computationally expensive challenges to traffic matching known bot patterns | Slow or failing requests from simple clients |
| Traps | Cloudflare AI Labyrinth: hidden links that only crawlers ignoring no-crawl instructions follow | Endless decoy pages if you ignore directives |
| Verified bots | Allowlists of identified, well-behaved crawlers | Your bot let through, once verified |

Cloudflare's docs point out that challenge pages cannot work for non-HTML requests such as fetch/XHR calls, which is why an API endpoint behind a challenge suddenly returns HTML. Details of the signals are in [How Bot Detection Works](how-bot-detection-works.md).

## Recognizing which edge you are talking to

Response headers usually reveal the CDN, which tells you whose documentation and verified-bot program apply:

| Indicator | Typically means |
|---|---|
| `server: cloudflare`, `cf-ray: <id>-<data center>` | Cloudflare (quote the Ray ID when you contact the site) |
| `cf-mitigated: challenge` | A Cloudflare challenge page |
| `x-amz-cf-id`, `via: ... (CloudFront)` | Amazon CloudFront, often with AWS WAF |
| `server: AkamaiGHost` on error pages | Akamai |
| `x-served-by: cache-...` | Fastly |

These are hints, not guarantees, because headers can be customized. Store them with the block evidence ([Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md)).

## Verified-bot programs

Verification is the legitimate way through bot management at scale.

- **Cloudflare** defines a verified bot as one that is transparent about who it is and what it does: honest self-identification (Web Bot Auth signatures, a published IP list with a stable User-Agent, or reverse DNS) plus non-abusive behavior (obeying robots.txt and crawl directives, reasonable request rates, no evasion of site owner preferences). Applications go through the BotBase submission form in the dashboard. Since July 1, 2026 bots are classified by behavior (Search, Agent, Training, Transact, Data Collection, Security Testing, SEO, Ads Verification, Social / Link Preview, Feed Fetching, Monitoring & Operations) and labeled Direct (one operator) or Intermediary (a service that many end users drive). Listed breaches that remove a bot from the allowlist include IPs not used solely by the service, traffic that does not match the declared purpose, and an AI crawler that ignores `crawl-delay`.
- **AWS WAF Bot Control** recognizes verified bots and labels them, so owners can treat them separately from unverified automation.
- Other vendors keep comparable known-bot directories.

Prepare as described in [Identifying Your Bot](identifying-your-bot.md): a stable token, a bot page, stable IPs or signing keys, and behavior that would pass review.

## AI crawler controls

CDNs now let owners set policy per crawler purpose. Cloudflare offers presets for Search, Agent and Training behavior, each with block, block-on-pages-with-ads or allow options. From September 15, 2026, new domains default to blocking Training and Agent bots on pages that display ads while allowing Search, and crawlers that mix search and training are blocked by any setting that blocks training. Cloudflare's pay-per-crawl feature (in closed beta) answers AI crawlers with HTTP 402 Payment Required and a price unless they present payment intent. For LLM-related collection this means more explicit "no" answers to respect, and new paid or permissioned paths to use ([AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)).

## If you own the site

- Start new rules in log-only mode and review false positives before enforcing them.
- Let your own monitors and scrapers through with skip rules for your IPs or signed requests, rather than weakening protection for everyone.
- Use CAPTCHA and Turnstile test keys in staging, never in production ([CAPTCHAs and What They Mean for Your Project](captchas.md)).
- Watch for corporate proxies that strip the User-Agent; Cloudflare documents that such traffic scores as automated.

## Pitfalls

- Assuming a CDN block is an accident. The edge enforces the owner's policy, so contact the owner rather than probing for gaps.
- Hunting for the origin server's IP to go around the CDN. That deliberately circumvents the site's protection; do not do it.
- Treating verified status as unlimited permission. Programs require reasonable rates and remove bots that misbehave.
- Using a verified identity for a purpose other than the one declared.
- Confusing WAF false positives (a quote in a query string) with bot blocks; the fixes differ.

## Checklist

- [ ] Block evidence includes CDN indicators and any Ray or reference ID
- [ ] Descriptive User-Agent on every request (avoids protocol-enforcement rules)
- [ ] Query strings and payloads reviewed for accidental WAF triggers
- [ ] Verified-bot program requirements met before applying
- [ ] Each source's AI-crawler policy checked and respected

## See Also

- [How Bot Detection Works](how-bot-detection-works.md)
- [Identifying Your Bot](identifying-your-bot.md)
- [CAPTCHAs and What They Mean for Your Project](captchas.md)
- [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md)
- [Browser and TLS Fingerprinting](fingerprinting.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
