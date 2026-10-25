---
tags: [scraping, sources, scholarly-metadata, openalex, crossref]
aliases: [scholarly data, bibliometrics, paper metadata, arXiv API, OpenAlex API]
---

# Academic and Research Data

> Sources: OpenAlex documentation, Rate limits and authentication (https://docs.openalex.org/how-to-use-the-api/rate-limits-and-authentication); OpenAlex blog, New features and usage-based pricing (https://blog.openalex.org/openalex-api-new-features-and-usage-based-pricing/); Crossref, REST API access and authentication (https://www.crossref.org/documentation/retrieve-metadata/rest-api/access-and-authentication/); Crossref blog, Announcing changes to REST API rate limits (https://www.crossref.org/blog/announcing-changes-to-rest-api-rate-limits/); arXiv, Terms of Use for arXiv APIs (https://info.arxiv.org/help/api/tou.html); arXiv API User Manual (https://info.arxiv.org/help/api/user-manual.html); arXiv bulk data access (https://info.arxiv.org/help/bulk_data.html); Semantic Scholar API (https://www.semanticscholar.org/product/api); NCBI, A General Introduction to the E-utilities (https://www.ncbi.nlm.nih.gov/books/NBK25497/); Unpaywall REST API (https://unpaywall.org/products/api)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scholarly metadata is unusually open: OpenAlex and arXiv metadata are released as CC0, Crossref distributes the metadata publishers deposit with DOIs, PubMed has a long-standing public API, and most services offer bulk snapshots for heavy users. There is almost never a reason to scrape publisher sites or search engines for bibliographic data. Full texts are different: they are copyrighted unless an open license says otherwise, and publishers offer text-and-data-mining (TDM) APIs and licenses for bulk access. Several of these APIs changed their access rules in 2025 and 2026, so read the current limits before a large job.

## Sources and access rules (as of 2026-10)

| Source | Best for | Access and limits |
|---|---|---|
| OpenAlex | Works, authors, institutions, sources, topics, citation graph | API key required for production use since 13 February 2026; usage is metered against a free daily allowance (single-entity lookups cost far less than list and filter queries) with a ceiling of 100 requests per second; 429 when exceeded; full snapshot available for bulk use |
| Crossref | Authoritative DOI metadata from publishers | Public pool and "polite" pool (identify with `mailto` or a User-Agent email). Since December 2025: public pool 5 requests/s for single records and 1/s for lists, concurrency 1; polite pool 10/s single and 3/s lists, concurrency 3. Headers `x-rate-limit-limit`, `x-rate-limit-interval`, `x-rate-limit-type`. Paid Metadata Plus for production services |
| arXiv | Preprints in physics, math, CS and more | Terms: no more than one request every three seconds and a single connection at a time, across all your machines. API returns Atom; `max_results` up to 2,000 per call and 30,000 per query. Bulk: OAI-PMH at `https://oaipmh.arxiv.org/oai`, full text on Amazon S3 (requester pays), and a Kaggle dataset |
| Semantic Scholar | Paper graph, embeddings, citations | Unauthenticated requests share a common pool that is throttled under load; a free API key starts at 1 request per second; Datasets API for bulk |
| PubMed (NCBI E-utilities) | Biomedical literature | 3 requests/s per IP without a key, 10/s with an API key; send `tool` and `email` parameters; run large jobs on weekends or between 9 p.m. and 5 a.m. US Eastern on weekdays |
| Unpaywall | Open access locations for DOIs | Free; include `email`; up to 100,000 calls per day; use the snapshot for heavier needs |
| Europe PMC, DataCite, ORCID | Life sciences full text, data DOIs, researcher ids | Public REST APIs; ORCID records are personal data |

Google Scholar offers no public API; use the open sources above instead of automating queries against it.

## Minimal example

```python
import os
import httpx

OPENALEX_KEY = os.environ["OPENALEX_API_KEY"]
MAILTO = "research@example.org"

def openalex_works(filter_expr: str, max_pages: int = 5):
    """Cursor-paginate OpenAlex works, e.g. filter_expr='publication_year:2025,is_oa:true'."""
    cursor = "*"
    with httpx.Client(timeout=60) as client:
        for _ in range(max_pages):
            r = client.get("https://api.openalex.org/works", params={
                "filter": filter_expr, "per-page": 200, "cursor": cursor,
                "select": "id,doi,title,publication_year,cited_by_count", "api_key": OPENALEX_KEY})
            r.raise_for_status()
            body = r.json()
            yield from body["results"]
            cursor = body["meta"].get("next_cursor")
            if not cursor:
                break

def crossref_work(doi: str) -> dict:
    """Fetch one DOI from the Crossref polite pool."""
    r = httpx.get(f"https://api.crossref.org/works/{doi}", params={"mailto": MAILTO},
                  headers={"User-Agent": f"ExampleBibBot/1.0 (mailto:{MAILTO})"}, timeout=30)
    r.raise_for_status()
    return r.json()["message"]
```

Batch where the API allows it: OpenAlex accepts OR filters with many ids in one request, which is cheaper than one call per DOI. For millions of records use the snapshots; an API backfill at the published limits takes days and wastes shared capacity.

## Identifiers and entity resolution

- **DOIs** are case-insensitive; normalize to lowercase and strip `https://doi.org/`.
- **arXiv ids** carry versions (`2401.01234v2`); store the base id and the version separately.
- **PMID and PMCID** link PubMed and PubMed Central; **ORCID** identifies people; **ROR** identifies institutions; **OpenAlex ids** (`W...`, `A...`, `I...`) are stable keys inside OpenAlex.
- The same work exists as preprint and published version with different ids. Link them, but do not merge blindly; their dates and contents differ.
- Author disambiguation is imperfect in every source. Keep source ids and confidence instead of forcing one "true" author record ([Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)).

## Licensing and full text

- OpenAlex data and arXiv metadata are CC0. Crossref metadata is generally free to reuse, but abstracts deposited by publishers may be copyrighted.
- arXiv e-prints remain under their authors' or publishers' copyright; redistribution needs permission or a permissive license on the specific paper, and tools built on arXiv full text must link back to arXiv.
- Open access articles carry per-article licenses (CC BY, CC BY-NC and others); record the license with each document.
- Publishers offer TDM APIs and licenses; in the EU, research organizations have a TDM exception for scientific research. See [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).
- PDFs need careful parsing ([PDF Data Extraction](../parsing/pdf-extraction.md)).

## Pitfalls

- Hard-coded limits from older docs. OpenAlex moved to keys and metered usage in 2026, and Crossref split limits by request type in December 2025.
- Several dates per work: created, published online, published in print, issued. Pick one definition and document it.
- Citation counts differ between sources because coverage differs; never mix them in one metric without noting the source.
- OpenAlex stores abstracts as an inverted index (`abstract_inverted_index`); rebuild the text before analysis.
- Retracted papers stay in the record; Crossref now distributes the Retraction Watch database, which you can join on DOI.
- Titles and abstracts contain HTML, JATS or MathML markup; clean before text analysis ([Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)).
- Parallel arXiv requests violate its single-connection rule even when the average rate is low.

## Checklist

- [ ] Snapshot or bulk route considered before any large API backfill.
- [ ] API keys, `mailto` and identifying User-Agent configured per service.
- [ ] Per-service throttles set from current documentation, not memory.
- [ ] Identifiers normalized; preprint and published versions linked.
- [ ] Licenses recorded for metadata and for each full text.
- [ ] Personal data (ORCID, author emails) minimized.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Pagination Patterns](../crawling/pagination-patterns.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
- [PDF Data Extraction](../parsing/pdf-extraction.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
