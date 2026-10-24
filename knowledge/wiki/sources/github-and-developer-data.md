---
tags: [scraping, sources, github, package-registries, gh-archive]
aliases: [GitHub API, GH Archive, npm registry API, PyPI JSON API, developer data]
---

# GitHub and Developer Data

> Sources: GitHub Docs, Rate limits for the REST API (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api); GitHub Docs, Rate limits and query limits for the GraphQL API (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api); GitHub Docs, REST API endpoints for search (https://docs.github.com/en/rest/search/search); GitHub Acceptable Use Policies (https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies); GH Archive (https://www.gharchive.org/); npm registry documentation (https://github.com/npm/registry/tree/main/docs); PyPI JSON API (https://docs.pypi.org/api/json/); Python Packaging User Guide, Analyzing PyPI package downloads (https://packaging.python.org/en/latest/guides/analyzing-pypi-package-downloads/); crates.io data access policy (https://crates.io/data-access); deps.dev API (https://docs.deps.dev/api/v3/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Developer ecosystems publish their data deliberately: GitHub has REST and GraphQL APIs with documented limits, GH Archive records the public event stream since 2011, and package registries expose JSON metadata, download statistics and database dumps. Scraping github.com HTML is almost never needed and runs into GitHub's Acceptable Use Policies. The work is mostly about budgeting rate limits, choosing bulk sources for history, and treating developer identities (usernames, commit emails) as personal data.

## GitHub API limits (as of 2026-10)

| Limit | Value |
|---|---|
| REST, unauthenticated | 60 requests per hour per IP |
| REST, authenticated user (PAT, OAuth, GitHub App on your behalf) | 5,000 per hour; 15,000 for apps owned by a GitHub Enterprise Cloud organization |
| `GITHUB_TOKEN` in Actions | 1,000 per hour per repository (15,000 for Enterprise Cloud resources) |
| GraphQL | 5,000 points per hour per user; `first`/`last` between 1 and 100; at most 500,000 nodes per call |
| Search | 30 requests per minute authenticated (code search 10 per minute and requires auth), 10 per minute unauthenticated; at most 1,000 results per search |
| Secondary limits | at most 100 concurrent requests; 900 points per minute per REST endpoint (2,000 for GraphQL); 90 seconds of CPU time per 60 seconds of real time; about 80 content-creating requests per minute |

Read `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` and `x-ratelimit-resource` on every response. On a 403 or 429: if `retry-after` is present wait that long; if remaining is 0 wait until the reset time; otherwise wait at least a minute and back off exponentially. Conditional requests with `If-None-Match` that return 304 do not count against the primary limit when made with authorization ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)). Paginate with the `Link` header (`per_page` up to 100).

```python
import os
import time
import httpx

client = httpx.Client(base_url="https://api.github.com", timeout=30, headers={
    "Authorization": f"Bearer {os.environ['GITHUB_TOKEN']}",
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "example-research-bot (research@example.org)",
})

def paged(path: str, max_retries: int = 5, **params):
    url, params, retries = path, {"per_page": 100, **params}, 0
    while url:
        r = client.get(url, params=params)
        if r.status_code in (403, 429) and retries < max_retries:
            retries += 1
            if "retry-after" in r.headers:
                time.sleep(int(r.headers["retry-after"]))
            elif r.headers.get("x-ratelimit-remaining") == "0":
                time.sleep(max(0, int(r.headers["x-ratelimit-reset"]) - time.time()) + 1)
            else:
                time.sleep(60 * retries)
            continue
        r.raise_for_status()
        retries = 0
        yield from r.json()
        url, params = r.links.get("next", {}).get("url"), None   # next page URL already has params

issues = list(paged("/repos/python/cpython/issues", state="closed", since="2026-10-01T00:00:00Z"))
```

Run requests serially per token; most secondary-limit trouble comes from parallel fan-out. For broad questions, GraphQL can fetch nested data in fewer calls, but compute its point cost ([GraphQL Endpoints](../apis/graphql.md)).

## GH Archive for history

GH Archive stores public GitHub events as hourly gzipped JSON files at `https://data.gharchive.org/YYYY-MM-DD-H.json.gz` (for example `2015-01-01-15.json.gz` for 3 p.m. UTC), available from 12 February 2011; data from 2015 onward is recorded from the Events API. The same data is a public BigQuery dataset (`githubarchive`, with day, month and year tables) updated hourly, where the event `payload` is a JSON string. Use it for ecosystem-wide questions instead of crawling millions of repositories.

```python
import gzip, json
import httpx

raw = httpx.get("https://data.gharchive.org/2015-01-01-15.json.gz", timeout=120).content
events = [json.loads(line) for line in gzip.decompress(raw).splitlines()]
stars = sum(1 for e in events if e["type"] == "WatchEvent")
```

The GitHub Innovation Graph publishes quarterly economy-level aggregates under CC0, and Software Heritage archives public source code with its own API.

## Package registries

- **npm.** Package metadata ("packument") at `https://registry.npmjs.org/{package}`; send `Accept: application/vnd.npm.install-v1+json` for the abbreviated version. Download counts at `https://api.npmjs.org/downloads/point/{period}/{package}` and `/downloads/range/...`; bulk queries take up to 128 unscoped packages and 365 days, other queries up to 18 months, with data from 10 January 2015. The replication (changes) feed at `replicate.npmjs.com` changed in 2025 and legacy endpoints were retired on 29 May 2025.
- **PyPI.** `GET https://pypi.org/pypi/{project}/json` and `/pypi/{project}/{version}/json`; the `releases` key is deprecated in favor of the Index (Simple) API. Download statistics live in the public BigQuery table `bigquery-public-data.pypi.file_downloads` (the `pypinfo` tool wraps it).
- **crates.io.** The data access policy asks API users for at most 1 request per second and a User-Agent that identifies the application uniquely; a full database dump is published every 24 hours at `https://static.crates.io/db-dump.tar.gz`, and crate files should come from the static CDN.
- **deps.dev.** Google's Open Source Insights API (`https://api.deps.dev/v3/systems/npm/packages/{name}`) gives versions, dependency graphs, licenses and advisories across ecosystems in one place.

## Acceptable use and personal data

GitHub's Acceptable Use Policies allow researchers to use public, non-personal information for research only if resulting publications are open access, and archivists to use public information for archival purposes. Information from GitHub, whether scraped or from the API, may not be used for spam, unsolicited email or selling personal information, for example to recruiters. Usernames, profile data and commit author emails are personal data; collect them only when the purpose needs them, secure them, and honor removal requests ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Pitfalls

- Parallel workers sharing one token trip secondary limits long before the hourly limit.
- Search caps at 1,000 results; slice queries by date range (`created:2026-01-01..2026-01-31`) to cover more.
- Renamed or transferred repositories redirect; deleted users appear as "ghost".
- Bots dominate some event types; filter them before measuring human activity.
- Stars and download counts are popularity signals with known gaming and CI noise.
- Event payload schemas change over time; parse defensively.

## Checklist

- [ ] Bulk source (GH Archive, BigQuery, registry dumps) considered before API crawling.
- [ ] Authenticated requests with an identifying User-Agent; rate-limit headers honored.
- [ ] Serial requests per token; secondary-limit backoff implemented.
- [ ] ETag caching for repeated reads.
- [ ] Personal data minimized; AUP restrictions on use respected.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [GraphQL Endpoints](../apis/graphql.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Pagination Patterns](../crawling/pagination-patterns.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
