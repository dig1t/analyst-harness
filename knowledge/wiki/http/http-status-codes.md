---
tags: [scraping, http, status-codes, retries, soft-404]
aliases: [HTTP status codes, Status codes, 429 Too Many Requests, 503 Service Unavailable, Soft 404]
---

# HTTP Status Codes and How to React

> Sources: RFC 9110, section 15, Status Codes (https://www.rfc-editor.org/rfc/rfc9110); RFC 6585, Additional HTTP Status Codes (429) (https://www.rfc-editor.org/rfc/rfc6585); RFC 7725, 451 Unavailable For Legal Reasons (https://www.rfc-editor.org/rfc/rfc7725); RFC 8470, Using Early Data in HTTP (425) (https://www.rfc-editor.org/rfc/rfc8470); MDN, HTTP response status codes (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Status); Google Search Central, How HTTP status codes and network and DNS errors affect Google Search (https://developers.google.com/search/docs/crawling-indexing/http-network-errors); curl manual, --retry (https://curl.se/docs/manpage.html#--retry)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A status code is the server's summary of what happened, and a scraper must turn each one into an action: store the content, keep the old copy, follow, retry later, slow down, re-authenticate, mark the record gone, or stop and ask a human. The three expensive mistakes are retrying what should never be retried (401, 403, 451), not waiting when the server says how long to wait (429 and 503 with `Retry-After`), and trusting 200 responses that are really errors (soft 404s, block pages, consent walls). Decide the reaction per code class up front, make retries idempotent and budgeted, and validate content even on success.

## The reaction table

| Code | Meaning | Reaction |
|---|---|---|
| 200 OK | Success | Validate the content before parsing (soft 404 and block-page checks below) |
| 202 Accepted | Work queued | Poll the status URL the API gives you (async exports) |
| 204 No Content | Success, empty body | "Nothing here", not an error |
| 206 Partial Content | Range response | Expected when resuming downloads |
| 301, 308 | Moved permanently | Follow; update the stored URL for future runs |
| 302, 303, 307 | Temporary redirect | Follow; keep the original URL as the identifier |
| 304 Not Modified | Your cached copy is current | Reuse the stored body ([HTTP Caching and Conditional Requests](caching-and-conditional-requests.md)) |
| 400 Bad Request | Malformed request | Your bug: fix parameters, do not retry |
| 401 Unauthorized | Missing or invalid credentials | Re-authenticate once, then stop |
| 403 Forbidden | Refused, whoever you are | Stop and investigate; never rotate identities to get past it |
| 404 Not Found | Not there now | Retry once later, then tombstone the record |
| 405, 406, 415 | Wrong method, `Accept` or body type | Fix the request |
| 408 Request Timeout | Server gave up waiting for your request | Retry once |
| 410 Gone | Removed on purpose, likely permanent | Tombstone immediately |
| 414 URI Too Long | Query too long | Shorten it or use the documented POST search |
| 421 Misdirected Request | Wrong connection for this origin | Retry on a fresh connection (HTTP/2 connection reuse issue) |
| 422 Unprocessable Content | Valid syntax, invalid parameters | Fix the parameters |
| 425 Too Early | Server refuses possibly replayed early data | Retry after the full handshake (clients do this) |
| 429 Too Many Requests | You are rate limited | Honor `Retry-After`, slow the whole host, back off |
| 451 Unavailable For Legal Reasons | Blocked by a legal demand | Stop, record the reason, do not work around it |
| 500 Internal Server Error | Server failed | Retry a few times with backoff |
| 502, 504 | Gateway errors | Retry with backoff |
| 503 Service Unavailable | Overload or maintenance | Honor `Retry-After`, pause the host |

Non-standard codes appear in the wild. nginx logs 499 when the client closed the connection (your timeout fired). Cloudflare uses its own 52x codes for problems between the CDN and the origin: treat them as 5xx. Some sites answer bots with 418 or a custom 4xx: treat unknown 4xx as "stop" and unknown 5xx as "retry with backoff".

## Retries done right

Retry only transient failures: connection errors, timeouts, 408, 425, 429, 500, 502, 503 and 504. curl's `--retry` uses almost the same list (408, 429, 500, 502, 503, 504, 522, 524). Rules:

- **Only idempotent requests retry automatically** (RFC 9110, section 9.2.2). GET and HEAD qualify; a POST does not, unless you know it is a read.
- **`Retry-After` beats your backoff.** It holds either delay-seconds or an HTTP-date (RFC 9110, section 10.2.3). RFC 6585 allows it on 429, RFC 9110 on 503 and 3xx.
- **Exponential backoff with jitter** when there is no hint, with a cap on attempts and on total waiting (a retry budget).
- **Slow the host, not just the URL.** One 429 means every worker hitting that host is too fast. Lower per-host concurrency ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)).
- **Give up loudly.** After the budget, record the failure with the status and headers so it can be re-queued.

```python
import random
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import httpx

RETRYABLE = {408, 425, 429, 500, 502, 503, 504}
SOFT_404_MARKERS = ("page not found", "could not find", "no longer available")


def retry_after_seconds(value: str | None) -> float | None:
    """Retry-After is either delay-seconds or an HTTP-date (RFC 9110, section 10.2.3)."""
    if not value:
        return None
    value = value.strip()
    if value.isdigit():
        return float(value)
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return max(0.0, (when - datetime.now(timezone.utc)).total_seconds())


def get_with_policy(client: httpx.Client, url: str, attempts: int = 5, max_wait: float = 600) -> httpx.Response:
    """GET with retries for transient failures only. GET is idempotent, so retrying is safe."""
    for attempt in range(1, attempts + 1):
        try:
            r = client.get(url)
        except httpx.TransportError:  # DNS, connect, read timeouts, dropped connections
            r = None
        if r is not None and r.status_code not in RETRYABLE:
            return r
        if attempt == attempts:
            break
        hinted = retry_after_seconds(r.headers.get("Retry-After")) if r is not None else None
        wait = hinted if hinted is not None else min(60.0, 2.0**attempt) * random.uniform(0.5, 1.0)
        if wait > max_wait:
            raise RuntimeError(f"{url}: server asked for {wait:.0f}s, more than our budget")
        time.sleep(wait)
    raise RuntimeError(f"{url}: still failing after {attempts} attempts")


def classify(r: httpx.Response) -> str:
    """Map a final response to the action the pipeline should take."""
    if r.status_code == 304:
        return "unchanged"  # keep the stored copy
    if 200 <= r.status_code < 300:
        head = r.text[:5000].lower()
        return "soft-404" if any(m in head for m in SOFT_404_MARKERS) else "ok"
    if r.status_code in (404, 410):
        return "gone"  # tombstone the record; 410 is a stronger signal than 404
    if r.status_code in (401, 403, 407, 451):
        return "stop"  # credentials, policy or legal: a human decides, never auto-retry
    if 300 <= r.status_code < 400:
        return "redirect"  # only reached when redirects are not followed
    return "error"
```

Against a test server that answers 429 twice with `Retry-After: 1`, `get_with_policy` returns the 200 after about two seconds; a 503 carrying an HTTP-date waits until that date. Put the per-host pause and the retry budget in a shared component ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)).

## 401, 403, 429 and 503 in practice

- **401** means "authenticate": RFC 9110 requires a `WWW-Authenticate` challenge with it. Refresh the token or session once ([Authentication Patterns](authentication-patterns.md)); if it fails again, stop.
- **403** means the server understood and refuses. Causes include missing permissions, geography, hotlink rules (no same-site `Referer`), a WAF rule or bot management. RFC 9110 says a client should not repeat it with the same credentials. Investigate, slow down, and ask for access or use an official channel ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).
- **429** is an explicit rate limit, per IP, per key or per account. Honor `Retry-After`, read any quota headers the API documents ([API Rate Limits and Quotas](../apis/api-rate-limits.md)), and reduce concurrency for the rest of the run.
- **503** means overload or maintenance, and some CDNs also serve challenge pages with 403 or 503. Wait as instructed. Google's crawlers treat 429 and 5xx as signals to slow down; behave at least as politely.

## Soft 404s and block pages

Many errors arrive as 200. A soft 404 is a "not found" page with a success status; a block or challenge page may also be a 200. Detect both by checking that the page fulfils its contract, not only that error words are absent:

- **Expected structure missing**: the product title, price block or result list selector is absent.
- **Marker phrases**: "page not found", "no results", "access denied", "unusual traffic".
- **Suspicious sameness**: many different URLs return a body with the same hash, the same `<title>`, or a canonical link to the home page.
- **Redirect to a generic page**: a deleted item redirects to the category or home page.
- **Size anomaly**: the body is far smaller than the usual page of that type.

Record such pages as "soft-404" or "blocked", never as successful empty results, and alert when their share rises ([Data Quality Monitoring](../data-quality/data-quality-monitoring.md)).

## Pitfalls

- **Retrying 403 and 401 in a loop.** It never fixes them and looks hostile. Stop and escalate.
- **Ignoring `Retry-After`**, or parsing only the seconds form and crashing on an HTTP-date.
- **Per-URL backoff only.** Fifty workers each backing off politely still hammer the host. Pause the host.
- **Unbounded retries** that turn an outage into a flood when the site comes back.
- **Retrying POSTs automatically**, duplicating side effects.
- **Counting 200 as success** without validating content, so soft 404s and block pages become empty records.
- **Tombstoning on a single 404.** Deploys and CDN glitches produce transient 404s; confirm on a later run before deleting.
- **Treating 3xx as errors** when redirects are disabled, or following them blindly when the target is a login page.

## Checklist

- [ ] A written mapping from status class to action, shared by all scrapers
- [ ] Retries only for transient codes and idempotent methods, with jitter and a budget
- [ ] `Retry-After` parsed in both forms and honored
- [ ] Host-level pause on 429 and 503
- [ ] 401, 403, 407 and 451 stop the job and notify a human
- [ ] Content contract checked on every 200 (soft 404 and block detection)
- [ ] Status-code distribution per host logged and alerted on

## See Also

- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
- [Redirects and Canonical URLs](redirects-and-canonical-urls.md)
- [Monitoring and Alerting](../operations/monitoring-and-alerting.md)
