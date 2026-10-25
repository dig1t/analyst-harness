---
tags: [scraping, sources, wikipedia, wikidata, sparql]
aliases: [Wikipedia API, Wikidata SPARQL, Wikimedia dumps, MediaWiki Action API]
---

# Wikipedia and Wikidata

> Sources: Wikimedia Foundation User-Agent Policy (https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy); MediaWiki, API:Etiquette (https://www.mediawiki.org/wiki/API:Etiquette); MediaWiki, Wikimedia APIs/Rate limits (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits); MediaWiki, Manual:Maxlag parameter (https://www.mediawiki.org/wiki/Manual:Maxlag_parameter); Wikitech, Robot policy (https://wikitech.wikimedia.org/wiki/Robot_policy); Wikitech, API Portal/Deprecation (https://wikitech.wikimedia.org/wiki/API_Portal/Deprecation); Wikidata, WDQS graph split (https://www.wikidata.org/wiki/Wikidata:SPARQL_query_service/WDQS_graph_split); Wikimedia Downloads (https://dumps.wikimedia.org/); Wikimedia Enterprise API (https://enterprise.wikimedia.com/api/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Wikimedia projects publish everything they host through APIs and dumps, so scraping rendered Wikipedia HTML is never the right approach. Use the MediaWiki Action API or REST APIs for targeted reads, the Wikidata Query Service (SPARQL) for structured questions, EventStreams for live changes, and the dumps (or Wikimedia Enterprise snapshots) for anything large. Every request must carry an identifying User-Agent with contact details. Since 2026 Wikimedia enforces global per-minute rate limits whose tier depends on how your client identifies itself. Wikipedia text is CC BY-SA licensed, Wikidata is CC0.

## Rules of the road (as of 2026-10)

- **User-Agent policy.** Send `<client name>/<version> (<contact information>) <library/framework name>/<version>`, where contact is an email, a website or a wiki user page. Requests without a User-Agent, or with a stock library one, may be blocked without notice. Browser JavaScript, which cannot set User-Agent, sends `Api-User-Agent` instead.
- **Global rate limits.** Introduced in 2026 for both the Action API and REST APIs, enforced per minute and per client, and described by Wikimedia as experimental. Unidentified traffic gets the lowest tier (reported as 10 requests per minute), clients with a policy-compliant User-Agent get more (reported as 200 per minute), and authenticated clients get more again; tools hosted on Toolforge and Wikimedia Cloud Services are treated differently. On HTTP 429 read `Retry-After` and wait.
- **Etiquette.** Make requests in series, not in parallel. Add `maxlag=5` to non-interactive bot requests; when replicas lag, the API returns a `maxlag` error with `Retry-After` and you should back off. Batch titles with `|` in one request instead of one call per page, use continuation tokens, and accept gzip.
- **API Portal deprecation.** The old `api.wikimedia.org` gateway was deprecated, moved onto the global limits in March 2026 and scheduled for shutdown in June 2026; use per-wiki endpoints.

## Endpoints

| Need | Endpoint |
|---|---|
| Queries, page content, categories, search | Action API `https://en.wikipedia.org/w/api.php` (`action=query`, `prop=revisions`, `list=categorymembers`, `prop=extracts`, `formatversion=2`) |
| Page source, HTML, search over REST | MediaWiki core REST API `https://en.wikipedia.org/w/rest.php/v1/page/{title}` (and `/html`, `/search/page?q=`) |
| Page summaries | `https://en.wikipedia.org/api/rest_v1/page/summary/{title}` |
| Entity JSON | `https://www.wikidata.org/wiki/Special:EntityData/Q42.json` or Action API `action=wbgetentities` |
| SPARQL | `https://query.wikidata.org/sparql` (main graph); scholarly articles at `https://query-scholarly.wikidata.org/sparql` |
| Live changes | EventStreams, e.g. `https://stream.wikimedia.org/v2/stream/recentchange` (server-sent events) |
| Pageviews | `https://wikimedia.org/api/rest_v1/metrics/pageviews/...` |

Since 9 May 2025 the Wikidata Query Service is split: `query.wikidata.org` serves the main graph without scholarly articles, which live on `query-scholarly.wikidata.org`. Queries that need both must use SPARQL federation. WDQS queries time out after 60 seconds, so design queries that finish well under that, and add `LIMIT` while developing.

## Minimal example

```python
import time
import httpx

UA = "ExampleWikiResearch/0.1 (https://example.org/contact; wiki-bot@example.org) httpx"
API = "https://en.wikipedia.org/w/api.php"

def call(client: httpx.Client, params: dict) -> dict:
    """One Action API call that honors 429 and maxlag back-off."""
    while True:
        r = client.get(API, params=params)
        if r.status_code == 429:
            time.sleep(int(r.headers.get("Retry-After", "10")))
            continue
        r.raise_for_status()
        data = r.json()
        if data.get("error", {}).get("code") == "maxlag":
            time.sleep(int(r.headers.get("Retry-After", "5")))
            continue
        return data

def category_members(category: str):
    params = {"action": "query", "list": "categorymembers", "cmtitle": f"Category:{category}",
              "cmlimit": "max", "format": "json", "formatversion": "2", "maxlag": "5"}
    with httpx.Client(headers={"User-Agent": UA}, timeout=30) as client:
        while True:
            data = call(client, params)
            yield from data["query"]["categorymembers"]
            if "continue" not in data:
                break
            params = {**params, **data["continue"]}      # serial continuation, no parallelism

SPARQL = """SELECT ?city ?cityLabel ?population WHERE {
  ?city wdt:P31 wd:Q515; wdt:P1082 ?population .
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?population) LIMIT 10"""

rows = httpx.get("https://query.wikidata.org/sparql", params={"query": SPARQL, "format": "json"},
                 headers={"User-Agent": UA}, timeout=70).json()["results"]["bindings"]
```

## Bulk data

- **Dumps** at `dumps.wikimedia.org`: per-wiki XML dumps (for example `enwiki-latest-pages-articles-multistream.xml.bz2` with its index for random access), produced about twice a month, plus SQL tables and pageview files. Stream-parse them; they are tens of gigabytes compressed.
- **Wikidata JSON dumps** at `dumps.wikimedia.org/wikidatawiki/entities/` (`latest-all.json.gz` and `.bz2`), produced weekly, with one entity per line so they can be processed line by line.
- **Wikimedia Enterprise** sells high-volume, structured access and also has a free tier with monthly On-demand and Snapshot allowances, which were raised in 2026; check the current numbers on its site.

## Data model notes

- Page ids are stable; titles change (moves) and redirects point elsewhere. Normalize titles (underscores versus spaces, first-letter case) and resolve redirects.
- Revisions have ids and timestamps; record which revision you extracted from.
- Prefer Wikidata over parsing infoboxes. Statements have qualifiers, references and ranks (preferred, normal, deprecated); quantities carry units and dates carry precision (year-only dates are common).
- Cross-language links come from Wikidata sitelinks or `prop=langlinks`.

## Licensing and attribution

Wikipedia text is available under CC BY-SA 4.0 (much of it also under the GFDL): credit the article with a link, and share derivatives of the text under the same license. Media files on Commons carry individual licenses; check each file. Wikidata's structured data is CC0. Wikimedia logos and names are trademarks. See [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).

## Pitfalls

- Crawling `/wiki/` HTML pages instead of using the API or dumps.
- Parallel request fan-out; the etiquette asks for serial requests.
- Generic User-Agent strings (default library agents have been blocked outright in the past).
- Ignoring `maxlag` errors, which return HTTP 200 with an error body.
- WDQS timeouts from unbounded queries, and scholarly-article queries that silently return nothing on the main graph since the split.
- Taking the current revision as truth during an edit war or vandalism; keep the revision id and consider recency.
- Mixing licenses when combining Wikipedia text (share-alike) with other content.

## Checklist

- [ ] Compliant User-Agent with contact details on every request.
- [ ] Serial requests, `maxlag` on bot traffic, 429 and `Retry-After` honored.
- [ ] Dumps or Enterprise snapshots used for bulk; API for targeted reads.
- [ ] SPARQL queries bounded and tested against the right graph.
- [ ] Revision ids stored; titles normalized; redirects resolved.
- [ ] Attribution and share-alike obligations met for reused text.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
- [Academic and Research Data](academic-and-research-data.md)
- [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)
