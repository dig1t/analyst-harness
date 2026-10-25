---
tags: [scraping, apis, open-data, api-catalog, reference]
aliases: [open APIs, public APIs, free data APIs, API directory, GitHub API, Wikipedia API, SEC EDGAR API, arXiv API]
---

# Catalog of Useful Open APIs

> Sources: GitHub Docs, Rate limits for the REST API (https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) and API versions (https://docs.github.com/en/rest/about-the-rest-api/api-versions); Hacker News API (https://github.com/HackerNews/API); Wikimedia APIs, Rate limits (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits); MediaWiki, API:Etiquette (https://www.mediawiki.org/wiki/API:Etiquette); Wikimedia Foundation User-Agent Policy (https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy); OpenAlex developer documentation (https://developers.openalex.org/); SEC, Accessing EDGAR Data (https://www.sec.gov/os/accessing-edgar-data) and EDGAR API documentation (https://www.sec.gov/edgar/sec-api-documentation); FRED API documentation (https://fred.stlouisfed.org/docs/api/fred/); World Bank, About the Indicators API (https://datahelpdesk.worldbank.org/knowledgebase/articles/889392); US Census Bureau, Census Data API User Guide (https://www.census.gov/data/developers/guidance/api-user-guide.html); OpenStreetMap wiki, Overpass API (https://wiki.openstreetmap.org/wiki/Overpass_API); OSMF, Nominatim Usage Policy (https://operations.osmfoundation.org/policies/nominatim/); arXiv API User Manual (https://info.arxiv.org/help/api/user-manual.html) and Terms of Use (https://info.arxiv.org/help/api/tou.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Before scraping a site, check whether its data is already published through an API or bulk download. This catalog covers ten widely used, free (or free-tier) APIs with the details an agent needs to call them correctly: base URL, authentication, rate limits and etiquette, a minimal request, and the bulk alternative for large jobs. Details were checked in October 2026 and **change often** (2026 alone brought mandatory OpenAlex API keys, Wikimedia's global rate limits and a new GitHub REST API version), so treat the numbers as a starting point and confirm against the linked documentation before a large run. Three rules apply everywhere: send a descriptive User-Agent with contact details, keep one request in flight per host unless the provider says otherwise, and use the bulk download when you need most of the dataset.

## Quick reference

| API | Base URL | Auth | Limits and etiquette (October 2026) | Bulk alternative |
|---|---|---|---|---|
| GitHub REST | `https://api.github.com` | optional token | 60 req/h unauthenticated, 5,000 req/h with a token; secondary limits | GH Archive |
| Hacker News | `https://hacker-news.firebaseio.com/v0/` | none | no published limit; be gentle | no official dump; Algolia HN Search for queries |
| Wikimedia | `https://en.wikipedia.org/w/api.php` and others | none for reads | User-Agent required; identity-based limits (10 req/min unidentified, 200 req/min with a compliant User-Agent) | dumps.wikimedia.org |
| OpenAlex | `https://api.openalex.org` | free API key | metered daily budget; per-second cap | OpenAlex snapshot |
| SEC EDGAR | `https://data.sec.gov` | none | declared User-Agent; at most 10 req/s | nightly ZIP files |
| FRED | `https://api.stlouisfed.org/fred/` | free API key | about 120 req/min per key | v2 release observations |
| World Bank | `https://api.worldbank.org/v2/` | none | no published limit; large `per_page` | bulk CSV downloads |
| US Census | `https://api.census.gov/data/` | key optional | 500 queries/day per IP without a key | bulk files on census.gov |
| OpenStreetMap | Overpass, Nominatim | none | Overpass under 10,000 queries/day; Nominatim at most 1 req/s | planet file, Geofabrik extracts |
| arXiv | `https://export.arxiv.org/api/query` | none | 1 request every 3 s, one connection | OAI-PMH, S3 bulk |

## GitHub REST and GraphQL

- **Data**: repositories, issues, pull requests, releases, commits, users, organizations, search; GraphQL for nested queries ([GitHub and Developer Data](../sources/github-and-developer-data.md)).
- **Auth**: public REST data works without a token at 60 requests per hour per IP. A personal access token or GitHub App user token gives 5,000 per hour; GitHub App installations get 5,000 to 12,500 depending on size (15,000 on Enterprise Cloud); `GITHUB_TOKEN` in Actions gets 1,000 per hour per repository. The GraphQL API (`https://api.github.com/graphql`) requires a token and is budgeted at 5,000 points per hour for users.
- **Secondary limits**: at most 100 concurrent requests, 900 points per minute on REST endpoints, 90 seconds of CPU time per 60 seconds; search is 30 requests per minute authenticated and 10 unauthenticated (code search: 10, token required), and any search returns at most 1,000 results.
- **Etiquette**: a `User-Agent` header is required; send `Accept: application/vnd.github+json` and pin `X-GitHub-Api-Version` (`2026-03-10` is the newest; `2022-11-28` remains the default and is supported until March 10, 2028). Paginate with `Link` headers and `per_page=100`; conditional requests answered with 304 do not count against the primary limit when authorized.
- **Bulk**: GH Archive records the public event timeline as hourly archives (also on BigQuery).

```bash
curl -s -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2026-03-10" \
  -H "User-Agent: ExampleBot/1.0 (+https://example.org/bot)" \
  "https://api.github.com/repos/scrapy/scrapy/issues?state=open&per_page=5"
```

## Hacker News

- **Data**: every story, comment, job, poll and user, as JSON, via Firebase.
- **Endpoints**: `/v0/item/<id>.json`, `/v0/user/<id>.json`, `/v0/maxitem.json`, up to 500 ids in `/v0/topstories.json`, `/v0/newstories.json` and `/v0/beststories.json`, up to 200 in `/v0/askstories.json`, `/v0/showstories.json` and `/v0/jobstories.json`, and recently changed items and profiles in `/v0/updates.json`.
- **Auth and limits**: none; the official README says "There is currently no rate limit." That is not an invitation to fetch every item in parallel: cache items, walk down from `maxitem` for incremental syncs, and use `updates` to refresh changed ones.
- **Search**: Algolia's HN Search API (`https://hn.algolia.com/api/v1/search?query=...&tags=story`, plus `search_by_date` with `numericFilters=created_at_i>...` for time windows) answers queries the Firebase API cannot.

```bash
curl -s "https://hacker-news.firebaseio.com/v0/item/8863.json"
```

## Wikipedia and Wikimedia

- **APIs**: the MediaWiki Action API at `https://<lang>.wikipedia.org/w/api.php` (same on every Wikimedia wiki); REST endpoints under `/w/rest.php/v1/` and the older `/api/rest_v1/`; the Wikidata Query Service at `https://query.wikidata.org/sparql`; EventStreams for live changes over SSE ([WebSockets and Server-Sent Events](websockets-and-sse.md)). Details are in [Wikipedia and Wikidata](../sources/wikipedia-and-wikidata.md).
- **Auth**: none for reading; logging in (OAuth or bot passwords) raises limits.
- **Rate limits (new in 2026)**: Wikimedia enforces global API limits that depend on how identifiable you are. The published table in October 2026: 10 requests per minute for clients identified only by IP, 200 per minute for unauthenticated clients with a policy-compliant User-Agent, 200 per minute for new or low-activity accounts and more for established ones; accounts in a bot group and traffic from Toolforge/Wikimedia Cloud Services are exempt. Wikimedia labels these numbers experimental. Exceeding them returns 429 with `Retry-After`; the contact for access questions is bot-traffic@wikimedia.org.
- **Etiquette**: a descriptive User-Agent with contact details is required by policy; make requests in series rather than in parallel; batch titles (up to 50 per request, 500 for accounts with higher limits); bots running non-interactive jobs should send `maxlag`. Automated dump downloads also require a valid User-Agent.
- **Bulk**: database dumps at `https://dumps.wikimedia.org/`; Wikimedia Enterprise for high-volume commercial use.

```bash
curl -s -H "User-Agent: ExampleBot/1.0 (https://example.org/bot; bot@example.org)" \
  "https://en.wikipedia.org/w/api.php?action=query&prop=info|extracts&exintro=1&explaintext=1&titles=Web_scraping&format=json&formatversion=2"
```

## OpenAlex

- **Data**: an open catalog of scholarly works, authors, sources, institutions, topics, publishers and funders ([Academic and Research Data](../sources/academic-and-research-data.md)).
- **Auth (changed February 13, 2026)**: an API key is required for real use, passed as the `api_key` parameter; keys are free. Keyless requests get only a small testing allowance, and the old `mailto` "polite pool" no longer exists.
- **Limits**: usage is metered against a daily budget, with lookups by id the cheapest and list, filter and search calls costing more, plus a per-second cap; responses carry headers with the remaining budget, and exceeding it returns 429. OpenAlex has adjusted the pricing model during 2026, so read the current figures on developers.openalex.org before planning a large job.
- **Paging**: `per_page` up to 200; cursor paging (`cursor=*`, then `meta.next_cursor`) for deep result sets.
- **Bulk**: the full OpenAlex snapshot is available for download; use it instead of paging the API for whole-database work.

```bash
curl -s "https://api.openalex.org/works?search=web%20crawler&filter=publication_year:2024&per_page=25&api_key=$OPENALEX_API_KEY"
```

## SEC EDGAR

- **Data**: company filings and XBRL financial data ([Financial Data and SEC EDGAR](../sources/financial-data-sec-edgar.md)).
- **Endpoints** (CIK zero-padded to 10 digits): `https://data.sec.gov/submissions/CIK##########.json` (filing history), `/api/xbrl/companyfacts/CIK##########.json` (all facts), `/api/xbrl/companyconcept/CIK##########/us-gaap/AccountsPayableCurrent.json` (one concept), `/api/xbrl/frames/us-gaap/AccountsPayableCurrent/USD/CY2019Q1I.json` (one concept across companies for one period); ticker to CIK map at `https://www.sec.gov/files/company_tickers.json`.
- **Auth**: none; no API keys.
- **Fair access rules**: declare a User-Agent with your organization and an admin email (the SEC's sample is `Sample Company Name AdminContact@<sample company domain>.com`), use gzip, and stay at or below 10 requests per second. Undeclared or excessive traffic is temporarily blocked with 403. The JSON APIs do not support CORS, so call them from a server or script.
- **Bulk**: `companyfacts.zip` and `submissions.zip` are rebuilt nightly (`https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip`, `.../daily-index/bulkdata/submissions.zip`).

```bash
curl -s --compressed -H "User-Agent: Example Org data-team@example.org" \
  "https://data.sec.gov/submissions/CIK0000320193.json"
```

## FRED (Federal Reserve Bank of St. Louis)

- **Data**: hundreds of thousands of economic time series, plus ALFRED vintages (`realtime_start`, `realtime_end`) for historical revisions.
- **Auth**: a free API key, sent as `api_key`; add `file_type=json` (the default is XML). A v2 endpoint, `https://api.stlouisfed.org/fred/v2/release/observations`, returns every series of a release in one cursor-paged call and takes the key as a Bearer token.
- **Limits**: about 120 requests per minute per key, the figure FRED client libraries are built around; excess requests get 429. Confirm the current limit in the FRED API documentation.
- **Terms**: some series are copyrighted by their original sources; check the series notes before redistributing.

```bash
curl -s "https://api.stlouisfed.org/fred/series/observations?series_id=UNRATE&observation_start=2020-01-01&file_type=json&api_key=$FRED_API_KEY"
```

## World Bank Indicators

- **Data**: World Development Indicators and other databases, by country and year.
- **Auth and limits**: no key and no published rate limit; keep requests sequential.
- **Usage**: add `format=json` (the default is XML); responses are a two-element array, `[metadata, rows]`, where metadata has `page`, `pages`, `per_page` (default 50) and `total`. Join several countries with `;` and give years as `date=2015:2024`.

```bash
curl -s "https://api.worldbank.org/v2/country/USA;CHN/indicator/NY.GDP.MKTP.CD?format=json&date=2015:2024&per_page=1000"
```

## US Census Bureau Data API

- **Data**: decennial census, American Community Survey, economic surveys and more ([Government and Open Data Portals](../sources/government-open-data.md)).
- **Auth**: up to 500 queries per IP address per day work without a key; register a free key (`https://api.census.gov/data/key_signup.html`) for anything more and pass it as `key`.
- **Usage**: discover datasets at `https://api.census.gov/data.json` and variables at `/data/<year>/<dataset>/variables.json`; select geography with `for=` and `in=` (for example `for=county:*&in=state:06`). Responses are JSON arrays of arrays with a header row first.

```bash
curl -s "https://api.census.gov/data/2023/acs/acs5?get=NAME,B01003_001E&for=state:*&key=$CENSUS_API_KEY"
```

## OpenStreetMap: Overpass and Nominatim

- **Overpass API** (`https://overpass-api.de/api/interpreter`) queries OSM data by tag and area. Its guidance: you will not disturb other users below about 10,000 queries and 1 GB of downloads per day (divide by 100 for regular automated use), do not run several scripts in parallel, and use a self-hosted or paid instance for commercial volumes.
- **Nominatim** (`https://nominatim.openstreetmap.org/search?q=...&format=jsonv2`) geocodes addresses under a strict usage policy: an absolute maximum of 1 request per second, an identifying User-Agent or Referer, no heavy or bulk geocoding, cache results, and display attribution. For bulk geocoding, run your own Nominatim.
- **Main API** (`https://api.openstreetmap.org/api/0.6/`) is for editing, not bulk reading; for large areas download the planet file (`https://planet.openstreetmap.org/`) or regional extracts (Geofabrik).
- **License**: ODbL; credit "© OpenStreetMap contributors" and share derived databases alike ([Maps and Local Business Data](../sources/maps-and-local-business.md)).

```bash
curl -s -A "ExampleBot/1.0 (bot@example.org)" --data-urlencode \
  'data=[out:json][timeout:25];node["amenity"="cafe"](52.36,4.88,52.38,4.91);out;' \
  "https://overpass-api.de/api/interpreter"
```

## arXiv

- **Data**: metadata and abstracts for preprints, as Atom XML.
- **Query**: `search_query` with field prefixes (`ti:`, `au:`, `abs:`, `cat:`, `all:`), `id_list`, `start`, `max_results`, `sortBy` (`relevance`, `lastUpdatedDate`, `submittedDate`) and `sortOrder`. Large result sets are limited to 30,000 results in slices of at most 2,000.
- **Terms**: for the legacy APIs (the query API, OAI-PMH and RSS), make no more than one request every three seconds over a single connection, counted across all machines you control.
- **Bulk**: harvest metadata through OAI-PMH at `https://oaipmh.arxiv.org/oai`; full PDFs and sources are in requester-pays S3 buckets.

```bash
curl -s "https://export.arxiv.org/api/query?search_query=cat:cs.IR+AND+ti:crawler&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending"
```

## Code: one polite client for all of them

Python 3.11 with `httpx`. One shared instance per process keeps one request in flight per host and spaces requests by per-host intervals taken from the rules above. Create a single instance and share it; two instances do not know about each other's requests. Tested against mocked versions of the Hacker News, World Bank and arXiv endpoints, with the interval enforced on concurrent calls.

```python
import asyncio
import time
from urllib.parse import urlsplit

import httpx

USER_AGENT = "ExampleOrg-research-bot/1.0 (+https://example.org/bot; data-team@example.org)"

# Minimum seconds between requests per host, derived from each provider's published rules
# (with headroom). One request in flight per host at a time.
MIN_INTERVAL = {
    "export.arxiv.org": 3.0,              # arXiv: 1 request / 3 s, single connection
    "oaipmh.arxiv.org": 3.0,
    "nominatim.openstreetmap.org": 1.0,   # Nominatim: absolute maximum 1 request / s
    "overpass-api.de": 10.0,              # Overpass: far below 10,000 queries/day, never parallel
    "data.sec.gov": 0.15,                 # SEC: at most 10 requests / s
    "www.sec.gov": 0.15,
    "api.stlouisfed.org": 0.6,            # FRED: about 120 requests / min per key
    "api.github.com": 0.5,                # GitHub: avoid bursts (secondary limits)
}
DEFAULT_INTERVAL = 1.0


class OpenDataClient:
    def __init__(self, extra_headers: dict[str, str] | None = None):
        self.http = httpx.AsyncClient(headers={"User-Agent": USER_AGENT, **(extra_headers or {})},
                                      timeout=60, follow_redirects=True)
        self.locks: dict[str, asyncio.Lock] = {}
        self.last: dict[str, float] = {}

    async def get(self, url: str, **kwargs) -> httpx.Response:
        host = urlsplit(url).hostname or ""
        async with self.locks.setdefault(host, asyncio.Lock()):
            wait = self.last.get(host, 0.0) + MIN_INTERVAL.get(host, DEFAULT_INTERVAL) - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            try:
                return await self.http.get(url, **kwargs)
            finally:
                self.last[host] = time.monotonic()

    async def aclose(self) -> None:
        await self.http.aclose()


async def demo() -> None:
    c = OpenDataClient()
    try:
        top = (await c.get("https://hacker-news.firebaseio.com/v0/topstories.json")).json()[:3]
        stories = [(await c.get(f"https://hacker-news.firebaseio.com/v0/item/{i}.json")).json() for i in top]
        meta, rows = (await c.get("https://api.worldbank.org/v2/country/USA/indicator/SP.POP.TOTL",
                                  params={"format": "json", "date": "2019:2024"})).json()
        feed = await c.get("https://export.arxiv.org/api/query",
                           params={"search_query": "cat:cs.IR AND ti:crawler", "max_results": 5})
        print([s["title"] for s in stories], meta["total"], len(feed.text))
    finally:
        await c.aclose()


if __name__ == "__main__":
    asyncio.run(demo())
```

For per-key quotas (GitHub, FRED, OpenAlex) add header-driven budgeting from [API Rate Limits and Quotas](api-rate-limits.md), and for paging use the helpers in [Pagination Patterns](../crawling/pagination-patterns.md).

## Pitfalls

- Copying numbers from this table without checking the provider's current documentation before a large job.
- Generic or missing User-Agents: Wikimedia's lowest tier, SEC 403s and Nominatim blocks all start there.
- Parallel requests to providers that ask for serial access (arXiv, Wikimedia, Overpass).
- Paging an API to reconstruct a whole database that is available as a bulk download.
- Keys in shell history, notebooks or committed code; use environment variables ([Secrets and Configuration](../operations/secrets-and-config.md)).
- Ignoring licenses: ODbL share-alike for OSM, third-party copyright on some FRED series, attribution requirements elsewhere.

## Checklist

- [ ] Current docs and terms checked for each API before a large run; date of the check recorded.
- [ ] Descriptive User-Agent with contact details on every request.
- [ ] Per-host interval and one-in-flight rule from the provider's guidance; keys for higher tiers where offered.
- [ ] Bulk download used instead of the API for whole-dataset jobs.
- [ ] Keys stored as secrets; license and attribution requirements recorded with the data.

## See Also

- [GitHub and Developer Data](../sources/github-and-developer-data.md)
- [Wikipedia and Wikidata](../sources/wikipedia-and-wikidata.md)
- [Academic and Research Data](../sources/academic-and-research-data.md)
- [Financial Data and SEC EDGAR](../sources/financial-data-sec-edgar.md)
- [Government and Open Data Portals](../sources/government-open-data.md)
- [Maps and Local Business Data](../sources/maps-and-local-business.md)
