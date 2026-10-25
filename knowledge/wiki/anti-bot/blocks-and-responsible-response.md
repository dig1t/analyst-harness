---
tags: [scraping, anti-bot, blocking, backoff, etiquette]
aliases: [soft blocks, block detection, handling 403 and 429, responding to blocks, circuit breaker]
---

# Recognizing Blocks and Responding Responsibly

> Sources: RFC 9110, Retry-After and 503 (https://www.rfc-editor.org/rfc/rfc9110#section-10.2.3); RFC 6585, 429 Too Many Requests (https://www.rfc-editor.org/rfc/rfc6585); RFC 7725, 451 Unavailable For Legal Reasons (https://www.rfc-editor.org/rfc/rfc7725); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); Cloudflare docs, Detect a Challenge Page response (https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/detect-response/); Cloudflare docs, Interstitial Challenge Pages (https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/); Google Search Central, Reduce the Google crawl rate (https://developers.google.com/search/docs/crawling-indexing/reduce-crawl-rate)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A block is the site telling you something: too fast, not here, not you, or not without asking. Detect it explicitly (status codes alone miss most soft blocks), stop or slow down automatically, keep the evidence, and escalate to a person who can contact the site or choose another source. The response ladder runs from honoring `Retry-After`, through permanent slowdowns and re-reading robots.txt and the terms, to contacting the owner, switching to an API or licensed data, and finally accepting "no". It never includes rotating identities, IPs or accounts to continue; that converts a polite misunderstanding into deliberate circumvention.

## Hard and soft blocks

| What you see | Usual meaning | Reaction |
|---|---|---|
| 429 Too Many Requests | Rate limited (RFC 6585), often with `Retry-After` | Wait as told, then lower your steady-state rate |
| 503 with `Retry-After` | Overloaded or in maintenance (RFC 9110) | Wait as told, reduce concurrency |
| 403 Forbidden | A policy, WAF or bot rule refused you | Stop the host, diagnose, consider contacting the site |
| 401 or 407 | Authentication required (origin or proxy) | Check you are authorized; never guess credentials |
| 451 Unavailable For Legal Reasons | Legal restriction (RFC 7725) | Stop and record; involve legal review if needed |
| 200 with `cf-mitigated: challenge` | Cloudflare challenge page; its content type is always `text/html`, even for API calls | Treat as a block |
| 200 with a CAPTCHA widget or "checking your browser" interstitial | Human verification required | Stop ([CAPTCHAs and What They Mean for Your Project](captchas.md)) |
| 200 with HTML where JSON was expected | Challenge, login or error page | Treat as a block until proven otherwise |
| 200 but empty, truncated or much smaller than usual | Soft block, decoy, or a layout change | Validate against a known-good sample |
| Redirects to login, consent or a home page | Gate or soft block | Do not loop; record and review |
| Timeouts, resets, sudden slowness | Overload, tarpitting or a network-level block | Back off hard |

Site owners use these signals deliberately. Google's crawler documentation, for example, tells site owners that returning 500, 503 or 429 temporarily is the way to make Googlebot slow down. Well-behaved crawlers are expected to react.

## Detect blocks in code

The classifier below turns a response into a verdict, and the per-host breaker pauses or stops a host. It slows down and stops; it never retries from a different identity.

```python
import email.utils
import random
import time
from dataclasses import dataclass
from enum import Enum

import httpx


class Verdict(str, Enum):
    OK = "ok"
    RATE_LIMITED = "rate_limited"
    CHALLENGED = "challenged"
    BLOCKED = "blocked"
    SUSPECT = "suspect"  # 200, but it does not look like the page we expected


# Markers of human-verification widgets; a hit means "stop and let a person look".
CHALLENGE_MARKERS = ("challenges.cloudflare.com", "cf-turnstile", "g-recaptcha", "h-captcha")


def classify(resp: httpx.Response, expect_json: bool = False,
             required_text: str | None = None, min_bytes: int = 2_000) -> Verdict:
    if resp.status_code == 429:
        return Verdict.RATE_LIMITED
    if resp.headers.get("cf-mitigated") == "challenge":
        return Verdict.CHALLENGED
    if resp.status_code in (401, 403, 407, 451):
        return Verdict.BLOCKED
    if resp.status_code == 503:
        return Verdict.RATE_LIMITED
    if resp.status_code >= 400:
        return Verdict.SUSPECT
    body = resp.text
    if any(marker in body for marker in CHALLENGE_MARKERS):
        return Verdict.CHALLENGED
    if expect_json and "json" not in resp.headers.get("content-type", ""):
        return Verdict.SUSPECT
    if not expect_json and (len(resp.content) < min_bytes or (required_text and required_text not in body)):
        return Verdict.SUSPECT
    return Verdict.OK


def retry_after_seconds(resp: httpx.Response) -> float:
    value = resp.headers.get("retry-after", "").strip()
    if value.isdigit():
        return float(value)
    try:  # HTTP-date form
        return max(0.0, email.utils.parsedate_to_datetime(value).timestamp() - time.time())
    except (TypeError, ValueError):
        return 0.0


@dataclass
class HostBreaker:
    base_delay: float = 5.0
    max_delay: float = 3600.0
    trip_after: int = 3        # consecutive bad verdicts before the host is stopped
    failures: int = 0
    paused_until: float = 0.0
    tripped: bool = False

    def record(self, verdict: Verdict, resp: httpx.Response) -> None:
        if verdict is Verdict.OK:
            self.failures = 0
            return
        self.failures += 1
        delay = min(self.max_delay, self.base_delay * 2 ** self.failures) * random.uniform(1.0, 1.5)
        if verdict is Verdict.RATE_LIMITED:
            delay = max(delay, retry_after_seconds(resp))
        self.paused_until = time.time() + delay
        if verdict in (Verdict.BLOCKED, Verdict.CHALLENGED) or self.failures >= self.trip_after:
            self.tripped = True  # stop this host; a person decides what happens next

    def may_fetch(self) -> bool:
        return not self.tripped and time.time() >= self.paused_until
```

When a breaker trips, save the evidence (URL, time, status, response headers, the first few kilobytes of the body, your User-Agent and egress IP) to the raw archive, alert a person ([Monitoring and Alerting](../operations/monitoring-and-alerting.md)) and remove the host from the schedule until someone clears it. Content checks such as `required_text` or a schema validation catch the soft blocks that status codes miss ([Schema Validation](../data-quality/schema-validation.md)).

## The response ladder

1. **Stop and diagnose.** Do not hammer a host that is refusing you. Check whether the block is site-wide or path-specific, and whether your code changed recently.
2. **Honor `Retry-After` and back off** with exponential delays and jitter ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)). After a 429, lower the steady-state rate, not just the next request.
3. **Re-read robots.txt and the terms.** They may have changed, or may now name your bot ([robots.txt (RFC 9309)](../crawling/robots-txt.md), [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)).
4. **Check your identification.** A descriptive User-Agent with contact details and a `From` header let the site reach you instead of blocking you ([Identifying Your Bot](identifying-your-bot.md)).
5. **Reduce load.** Conditional requests, incremental crawling, fewer pages, off-peak schedules ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)).
6. **Contact the site owner.** Use the published contact or partnership channel and quote any block reference ID.
7. **Use an alternative**: an official API, bulk downloads, a licensed dataset, archives such as Common Crawl, or a data partnership ([Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
8. **Accept no.** Record the decision, retire the source and tell whoever depends on the data.

## A contact message that works

```text
Subject: Automated access to example.com by ExampleResearchBot

Hello,

I run ExampleResearchBot (User-Agent "ExampleResearchBot/1.0 (+https://example.org/bot;
bot-ops@example.org)"). It collects public product prices for a price-index study.
Since 2026-10-24 our requests from 203.0.113.10 receive HTTP 403 (reference 8f2c...).
We have paused all requests.

We fetch about 2,000 pages per day, one request every 5 seconds at most, honor
robots.txt and never log in. We would like to continue only in a way that works for
you: a lower rate or set hours, an API or data feed, a license, or stopping entirely.

Thank you,
Jane Doe, Example Research (https://example.org/bot)
```

## What not to do

- Rotate IPs, proxies or accounts to keep going ([Proxies: Types, Uses and Ethics](proxies-overview.md)).
- Switch to a browser User-Agent or a headless browser to look human.
- Solve or outsource CAPTCHAs, or reuse clearance cookies from another session.
- Ignore a cease-and-desist letter. Continuing after an explicit revocation is where legal risk concentrates ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)).

## Pitfalls

- Treating every non-200 as transient and retrying it immediately.
- Trusting status codes alone; many blocks arrive as 200.
- Restarting a tripped job automatically on the next schedule.
- Backing off for one request and then returning to the old rate.
- Losing the evidence that would help the site owner find and lift the block.

## Checklist

- [ ] Every response classified (status, headers, content type, size, required content)
- [ ] Per-host breaker with backoff, `Retry-After` support and a stop state
- [ ] Evidence saved and a person alerted when a host trips
- [ ] robots.txt and terms re-checked after any block
- [ ] Contact made, or an alternative source chosen, before resuming
- [ ] No identity, IP or account rotation anywhere in the pipeline

## See Also

- [How Bot Detection Works](how-bot-detection-works.md)
- [CAPTCHAs and What They Mean for Your Project](captchas.md)
- [Identifying Your Bot](identifying-your-bot.md)
- [HTTP Status Codes and How to React](../http/http-status-codes.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)
