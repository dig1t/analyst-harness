---
tags: [scraping, anti-bot, captcha, accessibility, ethics]
aliases: [CAPTCHA, reCAPTCHA, hCaptcha, Turnstile, human verification, challenge page]
---

# CAPTCHAs and What They Mean for Your Project

> Sources: von Ahn, Blum, Hopper and Langford, "CAPTCHA: Using Hard AI Problems for Security" (EUROCRYPT 2003); W3C, Inaccessibility of CAPTCHA (https://www.w3.org/TR/turingtest/); Google, reCAPTCHA v3 (https://developers.google.com/recaptcha/docs/v3); Cloudflare docs, Turnstile (https://developers.cloudflare.com/turnstile/); Cloudflare docs, Test your Turnstile implementation (https://developers.cloudflare.com/turnstile/troubleshooting/testing/); Cloudflare docs, Interstitial Challenge Pages (https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/); IETF Privacy Pass working group documents (https://github.com/ietf-wg-privacypass/base-drafts); OWASP OAT-009 CAPTCHA Defeat (https://owasp.org/www-project-automated-threats-to-web-applications/assets/oats/EN/OAT-009_CAPTCHA_Defeat.html); Motoyama et al., "Re: CAPTCHAs: Understanding CAPTCHA-Solving Services in an Economic Context" (USENIX Security 2010); Searles et al., "An Empirical Study & Evaluation of Modern CAPTCHAs" (USENIX Security 2023)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A CAPTCHA (Completely Automated Public Turing test to tell Computers and Humans Apart) is a test a site uses to let people through and keep automated clients out, at least at that point and at that volume. When a scraper meets one, the site has made a decision about automated access, so the right response for this harness is to stop, not to solve. Solving CAPTCHAs at scale, by software or by paid human solvers, is out of bounds for this vault: OWASP lists "CAPTCHA Defeat" as an automated threat (OAT-009), it defeats an access control the site chose, and it raises legal, ethical and data-quality problems. This article explains what CAPTCHAs are for, the main types, how to recognize them, what to do instead, and how site owners can test their own forms.

## What CAPTCHAs are for

Sites put human-verification gates in front of actions that automation abuses: account creation (OAT-019), login (credential stuffing, OAT-008), checkout and ticketing (scalping, OAT-005), comments and contact forms (spamming, OAT-017), and expensive searches. CDNs also use challenges as a graded response when a bot score is borderline. Seeing a CAPTCHA usually means one of three things: you hit a protected action, your traffic pattern crossed a threshold, or the whole site gates unverified clients.

## Types

| Type | How it works | Notes |
|---|---|---|
| Distorted text | Read warped characters | The original 2000s design; now weak and largely retired |
| Image selection | Pick tiles containing an object | Common interactive fallback |
| Checkbox with risk analysis | Click "I'm not a robot"; hidden signals decide whether a puzzle follows | reCAPTCHA v2 style |
| Invisible, score-based | Script returns a score and the site decides | reCAPTCHA v3 returns 0.0 to 1.0 per request, 1.0 meaning very likely a good interaction |
| Managed challenge | Vendor chooses non-interactive or interactive checks per visitor | Cloudflare recommends Managed Challenges for most rules; Turnstile is its embeddable widget |
| Proof of work | Browser burns CPU to raise the cost of each request | Used by some challenge pages and open source widgets |
| Audio | Spoken digits or words | Accessibility alternative, itself hard for many users |
| Attestation tokens | A trusted issuer vouches for the client without revealing identity | IETF Privacy Pass, used for "private access tokens" |

## Recognizing one in your pipeline

- Iframes or scripts from verification providers (for example `www.google.com/recaptcha/`, `hcaptcha.com`, `challenges.cloudflare.com`).
- Form fields such as `g-recaptcha-response`, `h-captcha-response` or `cf-turnstile-response` (Turnstile adds an invisible input with that name).
- A Cloudflare challenge response, which carries `cf-mitigated: challenge` and always has an HTML content type.
- An interstitial page whose title or text asks the visitor to verify they are human.

Classify these as "challenged" and stop the host, as in the classifier in [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md).

## Why solving them at scale is out of bounds

1. **It overrides the site's decision.** The CAPTCHA is the site saying "people only, here". Getting past it with automation is the definition of circumventing an access control, which this vault does not do.
2. **Legal and contractual risk.** Terms of service usually forbid it, and defeating technical barriers can turn otherwise permitted access into unauthorized access. This is not legal advice; see [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md) and [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md).
3. **Human solving farms.** Motoyama and colleagues (USENIX Security 2010) documented the low-wage human labor markets behind commercial solving services. Routing challenges to such services, or to your own colleagues so a crawler can continue, is outsourcing the circumvention.
4. **Machine solving is an arms race.** Searles and colleagues (USENIX Security 2023) found that bots can match or beat humans on many modern CAPTCHAs, which is why vendors lean on risk signals rather than the puzzle. A solved puzzle does not make a flagged client trusted; it invites stronger defenses and more blocks.
5. **Data quality.** Clients that defeat challenges are often served degraded or decoy content later. Data obtained that way is hard to defend in an analysis.
6. **Collateral harm.** Every escalation by defenders makes the web harder for people with disabilities. The W3C note on CAPTCHA inaccessibility explains how visual and audio tests exclude many users.

## What to do instead

- **Stop and back off.** Reduce rate and concurrency drastically; some challenges were triggered by volume alone.
- **Avoid the protected action.** If the challenge guards search, login or checkout, look for the same data on public listing pages, sitemaps or feeds ([XML Sitemaps](../crawling/sitemaps.md)).
- **Use an official channel**: a documented API, bulk export, data feed or licensed dataset ([Catalog of Useful Open APIs](../apis/official-apis-catalog.md)).
- **Ask.** Contact the site, explain the purpose and volume, and ask for an API key, an allowlist entry or a data agreement.
- **Get verified.** If you operate a crawler at scale, verified-bot programs give site owners a reason to let you through ([WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)).
- **Agents acting for a person**: when a site asks for human verification during a task a user requested, hand control back to that user in their own session rather than solving it on their behalf ([Agentic Browsing](../llm-scraping/agentic-browsing.md)). That is a person using a site, not a crawler paging humans to keep running.
- **Accept reduced coverage** when none of the above works, and document the gap.

## Testing CAPTCHAs on your own site

If you own the site and your end-to-end tests or monitors hit your own CAPTCHA, configure the test environment, not the bot. Cloudflare publishes dummy Turnstile site keys and secret keys that always pass, always fail or force an interactive challenge, noting that automated suites are otherwise detected as bots; Google documents test keys for reCAPTCHA as well. Use them only in non-production environments, and use WAF skip rules or allowlists for your own monitoring traffic in production.

## Pitfalls

- Treating a CAPTCHA as a parsing problem instead of a policy signal.
- Retrying a challenged URL from the same job in a loop.
- Pausing a crawl to "let someone solve it" and then continuing at full speed.
- Assuming invisible scoring means no CAPTCHA is present; the site may silently serve different data to low scores.
- Shipping CAPTCHA test keys to production on your own site.

## Checklist

- [ ] CAPTCHA and challenge markers detected and mapped to a stop verdict
- [ ] Host paused, evidence saved and a person alerted
- [ ] Protected actions (login, search, checkout) avoided where public pages carry the data
- [ ] API, bulk data, license or permission explored before any resumption
- [ ] No solving services, solver libraries or human-in-the-loop solving queues in the pipeline

## See Also

- [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md)
- [How Bot Detection Works](how-bot-detection-works.md)
- [WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)
- [Agentic Browsing](../llm-scraping/agentic-browsing.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
