---
tags: [scraping, sources, jobs, ats, structured-data]
aliases: [job scraping, job board APIs, ATS APIs, Greenhouse API, Lever API]
---

# Job Postings

> Sources: Greenhouse Job Board API (https://developers.greenhouse.io/job-board.html); Lever Postings API (https://github.com/lever/postings-api); Ashby developer documentation (https://developers.ashbyhq.com/); SmartRecruiters developer documentation (https://developers.smartrecruiters.com/); schema.org JobPosting (https://schema.org/JobPosting); Google Search Central, Job posting structured data (https://developers.google.com/search/docs/appearance/structured-data/job-posting); USAJOBS Developer, Search API and Authentication (https://developer.usajobs.gov/); Directive (EU) 2023/970 on pay transparency (https://eur-lex.europa.eu/eli/dir/2023/970/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most company career pages are rendered from an applicant tracking system (ATS), and several ATS vendors expose public, unauthenticated JSON endpoints so that companies can embed their openings anywhere. Those endpoints are the best acquisition route for employer-level job data: they are stable, complete for the published board, cheap to poll and intended for public consumption. Career pages that are not backed by such an endpoint usually carry `JobPosting` JSON-LD for Google's job search. Aggregators such as large job boards and professional networks prohibit scraping in their terms and are the wrong target. Government job services often have proper APIs with keys.

## Public ATS endpoints

| ATS | List endpoint | Notes (as of 2026-10) |
|---|---|---|
| Greenhouse | `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true` | GET endpoints need no authentication; `content=true` adds the description; one job: `/jobs/{id}?questions=true`; only application POSTs need a key. A board returns in one response |
| Lever | `GET https://api.lever.co/v0/postings/{site}?mode=json` | EU instance at `api.eu.lever.co`; `skip` and `limit` paging; filters `location`, `commitment`, `team`, `department`, `level`; `group` for grouped output; published postings are public |
| Ashby | `GET https://api.ashbyhq.com/posting-api/job-board/{board_name}?includeCompensation=true` | Board name is case sensitive and comes from `jobs.ashbyhq.com/{board_name}`; compensation is optional in the response |
| SmartRecruiters | `GET https://api.smartrecruiters.com/v1/companies/{companyIdentifier}/postings` | `offset` and `limit` paging; the public feed is not enabled for every customer, and an unknown identifier can return an empty list rather than an error |

Find the board token on the company's career page: links to `boards.greenhouse.io/{token}` or `job-boards.greenhouse.io/{token}`, `jobs.lever.co/{site}`, `jobs.ashbyhq.com/{name}`. Store the mapping from company to ATS and token, and re-verify it periodically because companies switch ATS vendors.

```python
import html
import httpx

UA = "ExampleJobsBot/1.0 (+https://example.org/bot; jobs@example.org)"

def greenhouse(board: str) -> list[dict]:
    url = f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs"
    data = httpx.get(url, params={"content": "true"}, headers={"User-Agent": UA}, timeout=30).json()
    return [{"source": "greenhouse", "board": board, "id": str(j["id"]), "title": j["title"],
             "location": (j.get("location") or {}).get("name"), "updated_at": j.get("updated_at"),
             "url": j.get("absolute_url"),
             "description_html": html.unescape(j.get("content") or "")}  # content may be entity-escaped
            for j in data.get("jobs", [])]

def lever(site: str, eu: bool = False) -> list[dict]:
    base = "https://api.eu.lever.co" if eu else "https://api.lever.co"
    out, skip, page_size = [], 0, 100
    with httpx.Client(headers={"User-Agent": UA}, timeout=30) as client:
        while True:
            page = client.get(f"{base}/v0/postings/{site}",
                              params={"mode": "json", "skip": skip, "limit": page_size}).json()
            for p in page:
                cats = p.get("categories") or {}
                out.append({"source": "lever", "board": site, "id": p["id"], "title": p["text"],
                            "location": cats.get("location"), "team": cats.get("team"),
                            "commitment": cats.get("commitment"), "url": p.get("hostedUrl"),
                            "created_at_ms": p.get("createdAt")})
            if len(page) < page_size:
                return out
            skip += page_size
```

## JobPosting structured data

When a career site has no public endpoint, look for `JobPosting` JSON-LD on each job page (not on listing pages; Google's guidelines say the markup belongs on the page for a single posting). Google's job posting documentation requires `title`, `description`, `datePosted`, `hiringOrganization` and `jobLocation` for most postings (remote roles use `jobLocationType: TELECOMMUTE` with `applicantLocationRequirements`) and recommends `validThrough`, `baseSalary`, `employmentType`, `identifier` and `directApply`. `baseSalary` is a `MonetaryAmount` with `currency` and a `QuantitativeValue` holding `minValue`, `maxValue` and `unitText` (HOUR, MONTH, YEAR). See [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).

## Government and public job services

USAJOBS offers a search API at `https://data.usajobs.gov/api/search`. Requests need three headers: `Host`, `User-Agent` set to the email address you registered, and `Authorization-Key` with your API key. Many national employment services publish open job data or APIs too; prefer them over scraping aggregators.

## Data model

- **Keys:** source, board token and posting id. Titles and URLs are not keys.
- **Fields:** company, title, normalized occupation (map to a taxonomy such as O*NET-SOC or ESCO), locations (a posting can list several; Lever exposes `allLocations`), remote type, employment type, salary min, max, currency and period, department or team, posted date, updated date, closing date, apply URL, description as sanitized HTML plus plain text.
- **Lifecycle:** keep `first_seen`, `last_seen` and an inferred `closed_at` when a posting disappears from the board for more than one poll cycle. Reposts often get new ids; link them by company plus normalized title plus location ([Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)).

## Pay transparency changes the salary fields

Salary ranges are increasingly present because several US jurisdictions require them in postings, and the EU Pay Transparency Directive (2023/970) had a transposition deadline of 7 June 2026; its Article 5 requires employers to give applicants the starting pay or pay range, for example in the vacancy notice or before the interview. Expect ranges in free text ("USD 120k to 150k"), hourly versus annual units, and different rules per country. Parse them into structured fields, keep the original string, and do not infer a salary that the posting does not state.

## Legal and personal-data notes

- Public ATS endpoints are published for display; polling them modestly is normal use. Aggregators and professional networks forbid scraping in their terms, and some have litigated over it ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)).
- Never submit applications automatically and never collect applicant data.
- Postings can contain recruiter names, emails and phone numbers. Drop them unless your purpose needs them ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Pitfalls

- Descriptions arrive as HTML, sometimes entity-escaped; unescape before parsing and sanitize before display.
- One company can run several boards (per region or brand) or several ATSs at once.
- Empty results can mean "no openings", "wrong token" or "feed disabled". Distinguish them with a known-good canary board and by checking the career page.
- Lever `createdAt` is epoch milliseconds; Greenhouse `updated_at` is an ISO timestamp with offset. Normalize both to UTC.
- The same role posted for ten cities is ten postings in some systems and one in others.
- Polling every board every few minutes is wasteful. Hourly or daily is enough for most research, with jitter ([Scheduling and Cron](../operations/scheduling-and-cron.md)).

## Checklist

- [ ] Company to ATS and token mapping stored and re-verified on a schedule.
- [ ] Public endpoints used; no aggregator scraping; no automated applications.
- [ ] JSON-LD fallback for career sites without an endpoint.
- [ ] Salary parsed into min, max, currency and period with the raw string kept.
- [ ] Lifecycle fields (`first_seen`, `last_seen`, `closed_at`) maintained.
- [ ] Recruiter contact details removed unless needed.

## See Also

- [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)
- [Consuming REST APIs Well](../apis/rest-api-consumption.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
