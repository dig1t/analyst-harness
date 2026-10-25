---
tags: [scraping, sources, social-media, research-access, platform-terms]
aliases: [social media scraping, social data, platform APIs, researcher data access]
---

# Social Media

> Sources: X Developer Platform (https://developer.x.com/); ICPSR SOMAR, Meta Content Library (https://www.icpsr.umich.edu/sites/somar/meta-content-library); TikTok for Developers, Research API (https://developers.tiktok.com/products/research-api/); YouTube Data API, Quota costs (https://developers.google.com/youtube/v3/determine_quota_cost); Bluesky developer docs, Rate limits (https://docs.bsky.app/docs/advanced-guides/rate-limits); Mastodon documentation, Rate limits (https://docs.joinmastodon.org/api/rate-limits/); Regulation (EU) 2022/2065, Digital Services Act, Article 40 (https://eur-lex.europa.eu/eli/reg/2022/2065/oj); European Commission, DSA data access portal and FAQ (https://data-access.dsa.ec.europa.eu/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Social platforms are the hardest mainstream source to acquire responsibly. Content sits behind logins, platform terms forbid scraping, APIs are priced or restricted, and nearly every record is personal data. Work API first: use the official API under its terms, apply to a research access program when your purpose qualifies, or use open protocols (Bluesky's AT Protocol, Mastodon) that publish data intentionally. Logged-in scraping of closed platforms creates contract, privacy and sometimes computer-misuse risk, and evading platform defenses is out of bounds for this harness.

## Platform landscape (as of 2026-10)

| Platform | Official route | Notes |
|---|---|---|
| X | X API | Moved to usage-based (pay-per-use) pricing for new developers in 2026, replacing fixed subscription tiers; check developer.x.com for current rates and read caps |
| Facebook, Instagram | Graph APIs for assets you manage; Meta Content Library and API for research | CrowdTangle was shut down in August 2024. Since December 2025 Content Library applications go through Meta's own portal, with access through ICPSR's SOMAR enclave or Meta's secure research environment |
| TikTok | Research API for eligible researchers; other APIs for apps | Eligibility and regions are defined by TikTok's program terms |
| YouTube | YouTube Data API v3 | Default quota is 10,000 units per day per project; search is far more expensive than reads (or capped separately), so budget roughly 100 searches per day by default; quota extensions by request |
| Reddit | Data API with OAuth | See [Reviews and Forums](reviews-and-forums.md) |
| LinkedIn | Partner APIs only | Terms prohibit scraping; long litigation history |
| Bluesky | Open AT Protocol | Public AppView at `public.api.bsky.app` (unauthenticated, cached, generous limits); PDS limits 3,000 requests per 5 minutes per IP; firehose and Jetstream streams for real-time |
| Mastodon and the fediverse | Per-server REST API | Default limits 300 requests per 5 minutes per account and per IP; each server sets its own rules |

## Research access programs

- **EU Digital Services Act, Article 40.** Vetted researchers can request non-public data from very large online platforms and search engines through the national Digital Services Coordinator; the Commission's delegated act on data access (2025) set up the procedures and a DSA data access portal. Article 40(12) separately requires those platforms to give researchers who meet its conditions access to publicly accessible data, which is the lawful alternative to scraping for many EU research projects.
- **Platform programs.** Meta Content Library, the TikTok Research API and YouTube's researcher program each have eligibility rules (usually non-profit or academic affiliation), review periods of weeks, and data handling terms such as deletion schedules.

Apply early; approval takes longer than writing the scraper you are not allowed to run.

## Open protocols: a worked example

Bluesky publishes posts as signed public records, and the public AppView serves them without authentication:

```python
import httpx

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; research@example.org)"
URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed"

def author_feed(actor: str, max_pages: int = 3) -> list[dict]:
    posts, cursor = [], None
    with httpx.Client(headers={"User-Agent": UA}, timeout=30) as client:
        for _ in range(max_pages):
            params = {"actor": actor, "limit": 50, **({"cursor": cursor} if cursor else {})}
            r = client.get(URL, params=params)
            r.raise_for_status()
            data = r.json()
            for item in data.get("feed", []):
                post = item["post"]
                posts.append({"uri": post["uri"], "author_did": post["author"]["did"],
                              "created_at": post["record"].get("createdAt"),
                              "text": post["record"].get("text"),
                              "like_count": post.get("likeCount")})
            cursor = data.get("cursor")
            if not cursor:
                break
    return posts

print(len(author_feed("bsky.app")))
```

For network-wide collection, consume the firehose or Jetstream instead of polling thousands of accounts ([WebSockets and Server-Sent Events](../apis/websockets-and-sse.md)). On Mastodon, respect each server's terms and the account-level discoverability and indexing preferences that users set; the fediverse community reacts strongly to unannounced bulk collection.

## Data model

- **Keys:** platform plus native id (Bluesky `at://` URI, Mastodon status id with server domain, X post id).
- **Author:** store a stable id, not the handle; handles change. Pseudonymize author ids in analysis tables with a keyed hash.
- **Engagement:** counts are time series. Store observations with `observed_at`, never overwrite.
- **Graph:** replies, quotes and reposts as edges.
- **Deletions:** propagate them. Many platform terms require deleting content that users deleted, and open protocols emit delete events. Keep a tombstone table so deleted items are not re-ingested.

## Legal and ethical notes

- **Terms and logins.** Accepting terms to log in makes them binding; scraping while logged in is the highest-risk pattern. US cases have gone both ways on public, logged-out data (hiQ v. LinkedIn; Meta v. Bright Data, where the court found Meta's terms did not bar logged-out scraping of public data on the facts presented). See [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md) and [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md).
- **Public is still personal.** Data protection authorities from several countries issued a joint statement in 2023 stating that publicly accessible personal data remains subject to privacy law and that mass scraping can be a reportable breach. GDPR requires a lawful basis, minimization and transparency; posts can reveal special category data (health, politics, religion) that needs extra care ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- **Research ethics.** Get ethics review where required, avoid re-identification, quote sparingly (quotes are searchable), and never use collected data to target or harass individuals.

## Pitfalls

- Building on an unofficial or reverse-engineered API that breaks or gets you banned; see [Mobile App APIs](../apis/mobile-app-apis.md).
- Quota math errors: one expensive search call can cost as much as a hundred reads.
- Sampling bias: APIs return what they choose (ranking, rate limits, deleted content missing). Document the collection method.
- Handles, display names and URLs change; join on ids.
- Ignoring deletions and privacy settings changes after collection.
- Treating engagement counts from different crawl times as comparable without timestamps.

## Checklist

- [ ] Official API or research program identified; terms read and recorded.
- [ ] No logged-in scraping of closed platforms; no evasion of defenses.
- [ ] Lawful basis and minimization plan for personal data; ethics review if research.
- [ ] Quotas budgeted; rate-limit headers honored ([API Rate Limits and Quotas](../apis/api-rate-limits.md)).
- [ ] Author ids pseudonymized; deletions propagated with tombstones.
- [ ] Collection method and sampling limits documented with the dataset.

## See Also

- [Reviews and Forums](reviews-and-forums.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
- [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md)
