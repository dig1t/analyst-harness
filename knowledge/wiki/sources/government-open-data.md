---
tags: [scraping, sources, open-data, ckan, socrata]
aliases: [open data portals, government data, data.gov, statistical agency APIs]
---

# Government and Open Data Portals

> Sources: Data.gov Catalog API (https://resources.data.gov/catalog-api/); GSA data.gov wiki, catalog.data.gov (https://github.com/GSA/data.gov/wiki/catalog.data.gov); api.data.gov Developer Manual (https://api.data.gov/docs/developer-manual/); CKAN API guide (https://docs.ckan.org/en/latest/api/); Socrata Developer Portal, Queries using SODA3 and Application Tokens (https://dev.socrata.com/docs/queries/); US Census Bureau, Census Data API User Guide (https://www.census.gov/data/developers/guidance/api-user-guide.html); BLS Public Data API FAQs (https://www.bls.gov/developers/api_faqs.htm); Eurostat, API getting started (https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started); 17 U.S.C. 105 (https://www.law.cornell.edu/uscode/text/17/105); UK Open Government Licence v3.0 (https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Government data is the friendliest source category: it is published on purpose, usually under an explicit open license, and almost always available as bulk files or through an API. The work is discovery (which portal, which dataset, which version), correct use of the platform's API (CKAN, Socrata, ArcGIS, custom catalogs, statistical agency APIs) and careful handling of revisions, codes and footnotes. Scraping HTML tables from a government site is rarely necessary; look for the download link or the API behind the page first.

## Portal platforms

**CKAN** powers many national and regional catalogs. Its Action API lives under `/api/3/action/`: `package_search` (query, filters, `rows`, `start`), `package_show` (one dataset with its resources and download URLs) and, where the DataStore extension is enabled, `datastore_search` for row-level queries on tabular resources.

**data.gov (United States) is no longer CKAN.** In 2025 GSA replaced the legacy CKAN catalog with a custom Flask and OpenSearch application; the old CKAN catalog remains at `catalog-old.data.gov` only through fall 2026, and CKAN-style `/api/3/action/` calls against `catalog.data.gov` do not work. The new Catalog API is at `https://api.gsa.gov/technology/datagov/v4/` with a `GET /search` endpoint (`q`, `per_page`, `org_id`, `keyword`, `after` cursor and more), returns DCAT-US 3 metadata, and expects an api.data.gov key in the `X-Api-Key` header. api.data.gov keys default to 1,000 requests per hour; the shared `DEMO_KEY` is limited to 30 requests per IP per hour and 50 per day (as of 2026-10). US agencies also publish their own `data.json` catalogs.

**Socrata** (Tyler Technologies' Data and Insights platform, common for US cities and states) serves each dataset at `/resource/{id}.json` (SODA 2) with SoQL parameters such as `$select`, `$where`, `$order`, `$limit` and `$offset`. SODA3 uses `/api/v3/views/{id}/query.json` with a full SoQL `query` and page objects, and requires an application token (header `X-App-Token`) or user authentication for query requests; full exports of public datasets through `/api/v3/views/{id}/export` do not. Always send an app token.

**ArcGIS REST services** back many geographic portals. Feature layers answer `/query?where=1=1&outFields=*&f=json`, paged with `resultOffset` and `resultRecordCount` up to the layer's `maxRecordCount`.

## Statistical agencies (as of 2026-10)

| Source | Access | Key facts |
|---|---|---|
| US Census Data API | `api.census.gov` | Free key required beyond 500 queries per IP per day; app traffic counts cumulatively |
| BLS Public Data API | v2 with free registration | 500 queries per day, up to 50 series and 20 years per query; unregistered v1 allows 25 queries per day |
| Eurostat | Statistics API, `ec.europa.eu/eurostat/api/dissemination/statistics/1.0/` | No key, JSON-stat 2.0, CORS enabled; SDMX 2.1 and 3.0 APIs too; full datasets can take minutes |
| World Bank | Indicators API v2, `api.worldbank.org/v2/` | No key; add `format=json`; paged with `per_page` |
| FRED and others | API keys | Read each terms page for limits and attribution |

## Minimal examples

```python
import httpx

UA = "ExampleOpenDataBot/1.0 (+https://example.org/bot; data@example.org)"

def ckan_search(base: str, q: str, rows: int = 100):
    """Iterate datasets on any CKAN portal, e.g. ckan_search("https://demo.ckan.org", "transport")."""
    start = 0
    with httpx.Client(headers={"User-Agent": UA}, timeout=60) as client:
        while True:
            r = client.get(f"{base}/api/3/action/package_search",
                           params={"q": q, "rows": rows, "start": start})
            r.raise_for_status()
            result = r.json()["result"]
            for pkg in result["results"]:
                yield {"id": pkg["id"], "title": pkg["title"], "license": pkg.get("license_id"),
                       "modified": pkg.get("metadata_modified"),
                       "resources": [(res.get("format"), res.get("url")) for res in pkg.get("resources", [])]}
            start += rows
            if start >= result["count"]:
                break

def socrata_rows(domain: str, dataset_id: str, app_token: str, page_size: int = 1000):
    """Page through a Socrata dataset with SODA 2, ordered by the system id for stable paging."""
    offset = 0
    with httpx.Client(headers={"User-Agent": UA, "X-App-Token": app_token}, timeout=60) as client:
        while True:
            batch = client.get(f"https://{domain}/resource/{dataset_id}.json",
                               params={"$limit": page_size, "$offset": offset, "$order": ":id"}).json()
            if not batch:
                break
            yield from batch
            offset += len(batch)
```

For large tables, download the bulk export (CSV or Parquet where offered) instead of paging an API row by row, and store it as received ([File Formats for Scraped Data](../storage/file-formats.md)).

## Licensing

- **US federal works** are not protected by copyright in the US (17 U.S.C. 105), but federal datasets can contain third-party material, and state and local governments set their own terms.
- **UK** public sector data is mostly under the Open Government Licence v3.0, which requires attribution.
- **EU** portals commonly use CC BY 4.0 or CC0, and the Open Data Directive pushes high-value datasets (geospatial, statistics, companies, mobility and others) toward free, machine-readable APIs and bulk downloads.
- Record the license per dataset in your provenance metadata ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

## Data quality realities

- **Revisions and vintages.** Statistical series get revised; store the release date (vintage) with every value so you can reproduce what was known when.
- **Flags and suppression.** Footnote markers, suppressed cells and status flags (provisional, estimated) are data. Do not coerce them to nulls silently.
- **Code lists change.** Geographic codes (FIPS, NUTS versions), industry and occupation classifications evolve; keep the code system version.
- **Metadata drift.** "Last modified" on a catalog entry may reflect a metadata edit, not new data; compare file hashes ([Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).

## Personal data

Open does not mean anonymous. Court records, business registers, campaign finance donors, licensing databases and procurement records name people. Minimize, avoid building profiles of individuals, and follow data protection rules where they apply ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Pitfalls

- Scraping a portal's HTML preview instead of using the export link.
- Unstable pagination without an `$order` (Socrata) or with offsets past result limits; use cursors where offered ([Pagination Patterns](../crawling/pagination-patterns.md)).
- Hard-coded CKAN calls to catalog.data.gov after the 2025 migration.
- Mixing vintages or seasonal adjustment variants in one series.
- Treating `DEMO_KEY` as production credentials.

## Checklist

- [ ] Portal platform identified; official API or bulk export chosen.
- [ ] API key or app token obtained where the platform expects one.
- [ ] License recorded per dataset; attribution text stored.
- [ ] Vintage, flags and code system versions kept with values.
- [ ] Changes detected by content hash, not catalog timestamps alone.
- [ ] Personal data reviewed before reuse.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [Consuming REST APIs Well](../apis/rest-api-consumption.md)
- [Pagination Patterns](../crawling/pagination-patterns.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Financial Data and SEC EDGAR](financial-data-sec-edgar.md)
