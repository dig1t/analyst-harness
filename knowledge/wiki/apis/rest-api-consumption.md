---
tags: [scraping, apis, rest, http-clients, sdks]
aliases: [REST API client, consuming APIs, API integration, OpenAPI, problem details, API versioning]
---

# Consuming REST APIs Well

> Sources: RFC 9110, HTTP Semantics (https://www.rfc-editor.org/rfc/rfc9110); RFC 9457, Problem Details for HTTP APIs (https://www.rfc-editor.org/rfc/rfc9457); RFC 8594, The Sunset HTTP Header Field (https://www.rfc-editor.org/rfc/rfc8594); RFC 9745, The Deprecation HTTP Response Header Field (https://www.rfc-editor.org/rfc/rfc9745); IETF draft, The Idempotency-Key HTTP Header Field (https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/); OpenAPI Specification (https://spec.openapis.org/oas/latest.html); JSON:API specification (https://jsonapi.org/format/); GitHub Docs, Best practices for using the REST API (https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

When a source offers an API, use it: the data is structured, the terms are explicit, and the provider has budgeted capacity for you. Consuming it *well* means reading the documentation and terms first, authenticating with the narrowest credentials, asking the server to do the filtering and field selection, paging correctly, keeping inside rate limits, revalidating with ETags instead of refetching, retrying only what is safe to retry, handling errors as structured data (RFC 9457 problem details where offered), pinning an API version and watching deprecation signals, and validating every response at the boundary. Official SDKs save time on auth, paging and retries; a thin client over `httpx` or `fetch` gives transparency and control. Either way, keep requests observable: log the URL, status, request id and rate-limit headers.

## Before the first request

- **Docs and machine-readable descriptions.** Many APIs publish an OpenAPI description (the current major line is 3.x, with 3.2 the newest minor release); GitHub, for example, publishes its full REST description in the `github/rest-api-description` repository. A spec gives you every parameter, enum and error shape, and can generate a typed client.
- **Terms and licensing.** API terms often restrict caching duration, redistribution, commercial use or combining data with other sources. They bind you once you register a key (see [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)).
- **Limits and costs.** Record rate limits, quotas and pricing before designing the job ([API Rate Limits and Quotas](api-rate-limits.md)).
- **Bulk alternatives.** Dumps, snapshots and bulk files (Wikimedia dumps, SEC nightly ZIPs, OpenAlex snapshots) beat millions of item calls ([Catalog of Useful Open APIs](official-apis-catalog.md)).
- **Credentials.** Use read-only, least-privilege tokens; store them in environment variables or a secret store, never in code or logs ([Authentication Patterns](../http/authentication-patterns.md), [Secrets and Configuration](../operations/secrets-and-config.md)).

## Ask for less, get more per call

| Technique | Examples | Effect |
|---|---|---|
| Server-side filtering | `?state=open`, `?since=2026-10-01T00:00:00Z`, `?updated_after=` | fewer pages; the basis of incremental sync |
| Field selection | JSON:API sparse fieldsets `?fields[articles]=title,body`; `fields=` partial responses in Google APIs; GraphQL selections | smaller payloads, sometimes cheaper quota |
| Expansion and embedding | JSON:API `?include=author`; Stripe `expand[]=`; WordPress `?_embed` | avoids N+1 follow-up calls |
| Maximum page size | `per_page=100` (GitHub), `limit=1000` | fewer round trips |
| Conditional requests | `If-None-Match` with the stored ETag | 304 with no body; free on some APIs (GitHub, when authorized) |
| Compression and connection reuse | `Accept-Encoding: gzip, br`; one pooled client | lower latency and bandwidth |
| Batch endpoints | bulk lookups by id lists | one request instead of hundreds |

Paging details are in [Pagination Patterns](../crawling/pagination-patterns.md).

## Errors, retries and idempotency

- **Classify by status.** 400 and 422 mean your request is wrong: fix it, do not retry. 401 means bad or expired credentials; 403 means forbidden (or rate-limited, on some APIs); 404 may mean "no access" on private resources; 409 is a conflict; 429 and 503 are retry-later; other 5xx are usually transient ([HTTP Status Codes and How to React](../http/http-status-codes.md)).
- **Problem details.** RFC 9457 (which obsoletes RFC 7807) defines `application/problem+json` with `type`, `title`, `status`, `detail` and `instance`. Keep the whole object in your error logs, along with the server's request id header.
- **Retry safely.** GET, HEAD, PUT and DELETE are idempotent by definition; POST is not. For POST, use the provider's idempotency key (the IETF Idempotency-Key draft standardizes the `Idempotency-Key` header that Stripe and others already use) or do not retry automatically ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)).
- **Timeouts.** Always set connect and read timeouts; a missing timeout is how a nightly job hangs for a week.

## Versioning and deprecation

Pin the version your parser was written against: GitHub uses the `X-GitHub-Api-Version` header (calendar versions such as `2022-11-28` and `2026-03-10`; requests without the header get the oldest supported one), Stripe uses `Stripe-Version`, many APIs put `/v2/` in the path. Watch for the `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) response headers and log them as warnings; they are your notice period. Subscribe to the provider's changelog.

## SDK or raw HTTP?

| | Official SDK | Thin client (`httpx`, `fetch`) | Generated from OpenAPI |
|---|---|---|---|
| Auth, paging, retries | built in | you write them (once) | partly |
| Types and models | usually | your own (pydantic, zod) | yes |
| Transparency | requests hidden | every request visible | visible |
| Dependency risk | lags or breaks on upgrades | none | regenerate on spec changes |
| Fit | big, complex APIs (cloud providers, Stripe) | small APIs, scraping-style jobs | typed access to wide APIs |

Whichever you choose, validate responses against a schema at the boundary, so a silent API change fails loudly ([Schema Validation](../data-quality/schema-validation.md)).

## Code: a thin Python client

Python 3.11 with `httpx` and `pydantic`. Explicit headers and timeouts, connection-level retries in the transport, status-level retries with `Retry-After` and full jitter for GET only, an in-memory ETag cache, problem-details errors with the request id, and a model that validates the fields you depend on. Tested against a mocked API: a 503 was retried after its `Retry-After`, the second call was answered by a 304 from cache, and a 404 `application/problem+json` became a typed exception.

```python
import asyncio
import logging
import random
from datetime import datetime
from email.utils import parsedate_to_datetime

import httpx
from pydantic import BaseModel

log = logging.getLogger("api")
RETRYABLE = {429, 500, 502, 503, 504}


class ApiError(Exception):
    """Carries RFC 9457 problem details (or the raw body) and the server's request id."""

    def __init__(self, r: httpx.Response):
        self.status = r.status_code
        self.request_id = r.headers.get("x-request-id") or r.headers.get("x-github-request-id")
        ctype = r.headers.get("content-type", "")
        self.problem = r.json() if "json" in ctype else {"detail": r.text[:500]}
        super().__init__(f"{self.status} {self.problem.get('title') or self.problem.get('message') or ''}"
                         f" (request id {self.request_id})")


def _retry_delay(r: httpx.Response, attempt: int) -> float:
    ra = r.headers.get("retry-after", "")
    if ra.isdigit():
        return float(ra)
    if ra:
        try:
            return max(0.0, parsedate_to_datetime(ra).timestamp() - datetime.now().timestamp())
        except (TypeError, ValueError):
            pass
    return random.uniform(0, min(60.0, 2 ** attempt))      # full jitter


class ApiClient:
    def __init__(self, base_url: str, token: str | None = None, max_retries: int = 4,
                 user_agent: str = "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)"):
        headers = {"User-Agent": user_agent, "Accept": "application/json"}
        if token:
            headers["Authorization"] = f"Bearer {token}"     # from env or a secret store, never code
        self.http = httpx.AsyncClient(
            base_url=base_url, headers=headers,
            timeout=httpx.Timeout(30.0, connect=5.0),
            transport=httpx.AsyncHTTPTransport(retries=2),   # connection errors only
        )
        self.max_retries = max_retries
        self.cache: dict[str, tuple[str, object]] = {}      # url -> (etag, parsed body)

    async def get_json(self, path: str, params: dict | None = None) -> object:
        """GET with conditional revalidation and retries (GET is safe to retry)."""
        url = str(self.http.build_request("GET", path, params=params).url)
        headers = {"If-None-Match": self.cache[url][0]} if url in self.cache else {}
        for attempt in range(self.max_retries + 1):
            r = await self.http.get(url, headers=headers)
            log.info("GET %s -> %s", url, r.status_code)
            if r.status_code == 304:
                return self.cache[url][1]
            if r.status_code in RETRYABLE and attempt < self.max_retries:
                await asyncio.sleep(_retry_delay(r, attempt))
                continue
            if r.is_error:
                raise ApiError(r)
            data = r.json()
            if etag := r.headers.get("etag"):
                self.cache[url] = (etag, data)
            return data
        raise AssertionError("unreachable")

    async def aclose(self) -> None:
        await self.http.aclose()


class Issue(BaseModel):                                    # validate at the boundary
    number: int
    title: str
    state: str
    updated_at: datetime
```

Usage: `api = ApiClient("https://api.github.com", token=os.environ.get("GITHUB_TOKEN"))`, then `issues = [Issue.model_validate(x) for x in await api.get_json("/repos/OWNER/REPO/issues", {"state": "open", "per_page": 100})]`. Add the `X-GitHub-Api-Version` header for GitHub, and follow `Link` headers for more pages. Unknown fields are ignored by default in pydantic, which is what you want for forward compatibility.

## Code: a TypeScript fetch wrapper

Node 18 or newer. Tested against a local server returning 503 with `Retry-After: 1` and then 200, and a 404 problem response.

```typescript
export class ApiError extends Error {
  status: number;
  body: unknown;
  requestId: string | null;
  constructor(status: number, body: unknown, requestId: string | null) {
    super(`HTTP ${status}${requestId ? ` (request id ${requestId})` : ""}`);
    this.status = status;
    this.body = body;
    this.requestId = requestId;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra && /^\d+$/.test(ra)) return Number(ra) * 1000;
  const date = ra ? Date.parse(ra) : NaN;
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return Math.random() * Math.min(60_000, 1000 * 2 ** attempt); // full jitter
}

export async function getJson<T>(
  url: string,
  { token, retries = 4, timeoutMs = 30_000 }: { token?: string; retries?: number; timeoutMs?: number } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)", // Node only; browsers forbid it
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return (await res.json()) as T;
    if (RETRYABLE.has(res.status) && attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs(res, attempt)));
      continue;
    }
    const isJson = (res.headers.get("content-type") ?? "").includes("json");
    throw new ApiError(res.status, isJson ? await res.json() : await res.text(), res.headers.get("x-request-id"));
  }
}
```

## Observability

Log, per request: method, URL without secrets, status, duration, the server's request id (`x-request-id`, `x-github-request-id` and similar), rate-limit headers and any `Deprecation` or `Sunset` header. Store the API version and fetch time with each record ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)). Never log `Authorization` headers or full query strings that carry keys.

## Pitfalls

- Pulling everything and filtering locally when the API supports server-side filters.
- Retrying 400 and 422 responses forever, or retrying POSTs without idempotency keys.
- Unpinned versions: the provider's default changes and the parser breaks on a Tuesday.
- Trusting response shapes without validation; nullable fields and new enum values appear silently.
- One HTTP client per request, losing connection reuse and making rate limiting impossible.
- Tokens with write scopes for read-only jobs; keys in code, logs or URLs.
- Ignoring the API's caching and redistribution terms.

## Checklist

- [ ] Docs, terms, limits, versioning policy and bulk alternatives reviewed.
- [ ] Least-privilege credentials from a secret store; descriptive User-Agent.
- [ ] Server-side filters, field selection, expansion and maximum page size used.
- [ ] ETag revalidation; retries only for safe methods or with idempotency keys.
- [ ] Problem details and request ids captured in errors; timeouts everywhere.
- [ ] API version pinned; `Deprecation` and `Sunset` headers logged as warnings.
- [ ] Responses validated against a schema at the boundary.

## See Also

- [Pagination Patterns](../crawling/pagination-patterns.md)
- [API Rate Limits and Quotas](api-rate-limits.md)
- [Authentication Patterns](../http/authentication-patterns.md)
- [Schema Validation](../data-quality/schema-validation.md)
- [Catalog of Useful Open APIs](official-apis-catalog.md)
- [Finding Hidden APIs with DevTools](finding-hidden-apis.md)
