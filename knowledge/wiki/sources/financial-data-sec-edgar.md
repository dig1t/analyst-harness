---
tags: [scraping, sources, sec-edgar, xbrl, finance]
aliases: [EDGAR, SEC filings, XBRL frames, data.sec.gov]
---

# Financial Data and SEC EDGAR

> Sources: SEC, Accessing EDGAR Data (https://www.sec.gov/os/accessing-edgar-data); SEC, EDGAR Application Programming Interfaces (https://www.sec.gov/search-filings/edgar-application-programming-interfaces); SEC, New Rate Control Limits (https://www.sec.gov/oit/announcement/new-rate-control-limits); SEC, EDGAR Full Text Search (https://www.sec.gov/edgar/search/); SEC, Financial Statement Data Sets (https://www.sec.gov/dera/data/financial-statement-data-sets); SEC Developer Resources (https://www.sec.gov/developer)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

EDGAR, the SEC's filing system, is the reference example of a source that wants to be used by machines. Filings are free, the SEC publishes JSON APIs on `data.sec.gov` that need no key, nightly bulk archives exist, and the rules are explicit: declare who you are in the User-Agent and stay under 10 requests per second in total. Use the JSON APIs for company metadata and XBRL financial facts, the Archives tree for filing documents, index files or bulk ZIPs for history, and full-text search for discovery. Never scrape the HTML browse pages when a JSON or index equivalent exists.

## Fair access rules (as of 2026-10)

- **Rate:** at most 10 requests per second, counted across all machines you use. The SEC may limit further requests from an IP that exceeds this for 10 minutes, and continuing to exceed the limit during the time-out extends it. The SEC reserves the right to change limits and does not support debugging of scripts.
- **Identification:** declare a User-Agent with your company or project name and an administrative contact email. The SEC's own sample is `Sample Company Name AdminContact@<sample company domain>.com`. Generic library user agents get blocked.
- **Efficiency:** download only what you need, prefer bulk files for history, and cache. See [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md) and [Identifying Your Bot](../anti-bot/identifying-your-bot.md).

## Endpoints

| Purpose | URL pattern |
|---|---|
| Company filings history and metadata | `https://data.sec.gov/submissions/CIK##########.json` |
| One XBRL concept for one company | `https://data.sec.gov/api/xbrl/companyconcept/CIK##########/us-gaap/AccountsPayableCurrent.json` |
| All XBRL facts for one company | `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` |
| One concept across all companies for one period | `https://data.sec.gov/api/xbrl/frames/us-gaap/AccountsPayableCurrent/USD/CY2019Q1I.json` |
| Bulk archives (nightly, about 3:00 a.m. ET) | `submissions.zip` and `companyfacts.zip` linked from the EDGAR API page |
| Ticker to CIK map | `https://www.sec.gov/files/company_tickers.json` (`cik_str`, `ticker`, `title`) |
| Filing documents | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession_without_dashes}/{document}` |
| Quarterly and daily indexes | `https://www.sec.gov/Archives/edgar/full-index/{year}/QTR{n}/` (`master.idx`, `form.idx`, `company.idx`) and `daily-index/` |

CIKs are zero-padded to 10 digits in `data.sec.gov` URLs. The JSON is updated throughout the day as filings are disseminated. `data.sec.gov` does not support CORS, so browser-only apps need a server-side component. Frames periods use `CY2019` for annual data, `CY2019Q1` for quarterly durations and `CY2019Q1I` for instantaneous values (balance sheet items); each frame holds the one fact per filer that best fits the calendar period, so period end dates vary across companies with different fiscal years.

**Full-text search** covers filings from 2001 onward through the web interface at `sec.gov/edgar/search`. The JSON backend that the page calls is not a documented API; if you use it, apply the same fair access limits and expect it to change.

## Minimal example

```python
import time
import httpx

UA = "Example Analytics admin@example.com"   # name plus contact email, per SEC fair access
client = httpx.Client(headers={"User-Agent": UA}, timeout=30)
_last = 0.0

def get_json(url: str) -> dict:
    """GET with a simple throttle of about 5 requests/second, well under the 10/s ceiling."""
    global _last
    wait = 0.2 - (time.monotonic() - _last)
    if wait > 0:
        time.sleep(wait)
    _last = time.monotonic()
    r = client.get(url)
    r.raise_for_status()
    return r.json()

cik10 = "320193".zfill(10)   # Apple Inc.
subs = get_json(f"https://data.sec.gov/submissions/CIK{cik10}.json")
recent = subs["filings"]["recent"]          # parallel arrays; older pages listed in subs["filings"]["files"]
ten_ks = [(recent["filingDate"][i], recent["accessionNumber"][i], recent["primaryDocument"][i])
          for i, form in enumerate(recent["form"]) if form == "10-K"]

concept = get_json(f"https://data.sec.gov/api/xbrl/companyconcept/CIK{cik10}/us-gaap/NetIncomeLoss.json")
annual = [f for f in concept["units"]["USD"] if f.get("form") == "10-K" and f.get("fp") == "FY"]

frame = get_json("https://data.sec.gov/api/xbrl/frames/us-gaap/AccountsPayableCurrent/USD/CY2019Q1I.json")
print(len(ten_ks), annual[-1]["end"], annual[-1]["val"], len(frame["data"]))
```

## XBRL data model

Each fact carries a taxonomy (`us-gaap`, `ifrs-full`, `dei`, or a company extension), a concept tag, a unit (`USD`, `shares`, `USD/shares`), a value, start and end dates (or an instant), fiscal year and period (`fy`, `fp`), the form and filing date, the accession number and, where assigned, a `frame`. Points that matter in practice:

- **The same fact appears many times.** A 10-K reports the current year and comparatives; later filings repeat or restate them. Deduplicate on concept, unit, period and value, and decide explicitly whether you want "as first reported" or "latest restated".
- **Durations versus instants.** Income statement items are durations; quarterly 10-Q values can be three-month or year-to-date. Check `start` and `end`, not just `fp`.
- **Concept choice varies.** Companies use different tags for similar items (for example several revenue concepts) and custom extensions. Map concepts per company and test coverage.
- **Amendments.** `10-K/A` and `10-Q/A` restate earlier filings.

For quarterly snapshots of all filers in flat tables, the SEC's Financial Statement Data Sets (`sub`, `num`, `tag`, `pre` files) are often easier than millions of API calls.

## Other financial sources

Ownership filings (Forms 3, 4 and 5) and institutional holdings (Form 13F) are filed as structured XML in EDGAR. Macro data is in central bank and statistics APIs ([Government and Open Data Portals](government-open-data.md)). Market prices from exchanges are licensed products; scraping quote pages of finance portals breaks their terms and gives you unlicensed data.

## Legal and personal-data notes

EDGAR data is public and reuse is broadly allowed, but filings contain personal data: insiders' names and addresses in ownership forms, related persons in offering notices, and occasionally personal details in exhibits. Use them for their market-disclosure purpose, minimize, and do not build profiles of private individuals ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Pitfalls

- Missing or generic User-Agent: immediate 403s or throttling.
- Parallel workers on several machines that together exceed 10 requests per second.
- Forgetting the 10-digit CIK padding, or mixing accession formats with and without dashes.
- Treating fiscal periods as calendar periods; use frames or compute calendar alignment yourself.
- Summing quarterly values that are actually year-to-date.
- Company names and tickers change; key on CIK (the submissions JSON lists former names).
- Pulling every filing document when the index or JSON already answers the question.

## Checklist

- [ ] User-Agent with organization name and contact email on every request.
- [ ] Global throttle below 10 requests per second across all workers.
- [ ] Bulk ZIPs used for backfills; JSON APIs for incremental updates.
- [ ] Facts deduplicated with an explicit "as reported" or "restated" policy.
- [ ] Durations, instants and units validated before aggregation.
- [ ] Personal data in ownership filings handled for its intended purpose only.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Government and Open Data Portals](government-open-data.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
