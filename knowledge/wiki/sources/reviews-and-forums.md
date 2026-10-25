---
tags: [scraping, sources, reviews, forums, reddit]
aliases: [forum scraping, review data, Reddit API, Discourse JSON, user-generated content]
---

# Reviews and Forums

> Sources: Reddit Data API Terms (https://redditinc.com/policies/data-api-terms); Reddit Developer Terms (https://redditinc.com/policies/developer-terms); Reddit Data API Wiki (https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki); PRAW documentation, Quick Start (user agent format) (https://praw.readthedocs.io/en/stable/getting_started/quick_start.html); Stack Exchange API, Throttles (https://api.stackexchange.com/docs/throttle); Hacker News API (https://github.com/HackerNews/API); Discourse API documentation (https://docs.discourse.org/); Discourse default rate limits, discourse_defaults.conf (https://github.com/discourse/discourse/blob/main/config/discourse_defaults.conf); 16 CFR Part 465, Use of Consumer Reviews and Testimonials (https://www.ecfr.gov/current/title-16/chapter-I/subchapter-D/part-465); schema.org Review (https://schema.org/Review)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Forums and review sites hold user-generated content: every post has an author who owns the copyright (licensed to the platform), and every username is personal data even when pseudonymous. The responsible route is API first: Reddit's Data API under its terms, the Stack Exchange API and data dumps, the Hacker News API, and the JSON views that Discourse forums expose. Review platforms offer official APIs with display and caching rules and generally prohibit scraping. Collect the minimum, pseudonymize authors, propagate deletions, and never scrape behind a login you were not granted for that purpose.

## Reddit

- **Access.** The Data API requires OAuth with a registered app. Reddit's Data API wiki (2023 pricing change) set free-tier limits of 100 queries per minute per OAuth client id, and 10 per minute without OAuth; responses carry `X-Ratelimit-Used`, `X-Ratelimit-Remaining` and `X-Ratelimit-Reset`. Check the current wiki and terms before building, because Reddit has tightened access more than once and may require approval for new apps.
- **Identification.** Use a unique, descriptive User-Agent in Reddit's documented format `<platform>:<app ID>:<version string> (by u/<Reddit username>)`. Generic agents are throttled or blocked.
- **Terms.** The Data API Terms and Developer Terms restrict commercial use and the use of Reddit content for training models without an agreement with Reddit, and require respecting user deletions. Third-party archives such as Pushshift have been restricted to approved moderators since 2023, so they are not a substitute.

```python
import os
import httpx

UA = "script:org.example.forumresearch:v1.0 (by u/your_username)"
token = httpx.post("https://www.reddit.com/api/v1/access_token",
                   data={"grant_type": "client_credentials"},
                   auth=(os.environ["REDDIT_CLIENT_ID"], os.environ["REDDIT_CLIENT_SECRET"]),
                   headers={"User-Agent": UA}, timeout=30).json()["access_token"]
r = httpx.get("https://oauth.reddit.com/r/datasets/new", params={"limit": 100},
              headers={"Authorization": f"Bearer {token}", "User-Agent": UA}, timeout=30)
print(r.headers.get("x-ratelimit-remaining"))
posts = [child["data"] for child in r.json()["data"]["children"]]
```

## Stack Exchange, Hacker News and Discourse

- **Stack Exchange API** (`https://api.stackexchange.com/2.3/...?site=stackoverflow`): a small daily quota per IP without a key and a much larger one with a free app key; responses report `quota_remaining`, and a `backoff` field means "wait this many seconds before calling that method again", which you must honor. Content is licensed CC BY-SA, so reuse requires attribution. The periodic data dumps are the right source for bulk analysis; their distribution terms changed in 2024, so read the current download terms.
- **Hacker News** publishes all items through Firebase at `https://hacker-news.firebaseio.com/v0/` (`item/{id}.json`, `maxitem.json`, `topstories.json`, `updates.json`); the README states there is currently no rate limit, which is a reason to be gentle, not a license to hammer. Full-text search is available through the Algolia-hosted HN Search API at `https://hn.algolia.com/api/v1/search`.
- **Discourse** forums expose JSON for most pages: append `.json` (`/latest.json`, `/t/{topic_id}.json`, `/c/{slug}/{id}.json`). Default limits in Discourse's configuration are 200 requests per minute and 50 per 10 seconds per IP, and administrators can change them. Respect each community's guidelines and robots.txt.

```python
import httpx

UA = "ExampleForumResearch/1.0 (+https://example.org/bot; research@example.org)"

def discourse_latest(base: str, pages: int = 2):
    with httpx.Client(base_url=base, headers={"User-Agent": UA}, timeout=30) as client:
        for page in range(pages):
            data = client.get("/latest.json", params={"page": page}).json()
            for t in data["topic_list"]["topics"]:
                yield {"id": t["id"], "title": t["title"], "posts_count": t["posts_count"],
                       "last_posted_at": t.get("last_posted_at")}

def hn_item(item_id: int) -> dict:
    return httpx.get(f"https://hacker-news.firebaseio.com/v0/item/{item_id}.json",
                     headers={"User-Agent": UA}, timeout=30).json()
```

Classic forum software (phpBB, vBulletin, XenForo, MyBB) usually offers RSS feeds per forum or thread and predictable pagination (`page-2`, `?start=20`). Use feeds where they exist and crawl slowly otherwise ([Pagination Patterns](../crawling/pagination-patterns.md)).

## Reviews

- **Official APIs.** Map platforms return a handful of reviews per place through their APIs (Google's Places API returns up to five) with attribution and storage rules; review platforms such as Yelp and Trustpilot run their own APIs and business programs. Marketplaces generally forbid scraping review pages in their terms.
- **On-site markup.** Merchants and publishers mark reviews with schema.org `Review` and `AggregateRating` (`ratingValue`, `reviewCount`, `bestRating`). Treat on-site aggregate ratings as the site's own claim.
- **Authenticity.** In the US, the FTC's rule on consumer reviews and testimonials (16 CFR Part 465, effective October 2024) prohibits fake reviews, certain incentivized and insider reviews, and review suppression. If your project studies review authenticity, keep raw evidence and timestamps; never generate or post reviews.

## Data model

Thread, post and review records keyed by platform plus native id; parent id for reply trees; `created_at`, `edited_at` and `observed_at`; score or rating as observed time series; author as a keyed-hash pseudonym in analysis tables, with the mapping table access-controlled; a deletion tombstone table checked before every re-ingest. Store text and the platform's license for it.

## Personal data and ethics

Usernames, avatars and writing style identify people, and forums on health, sexuality, religion or politics carry special category data under GDPR. Minimize fields, aggregate when publishing, paraphrase rather than quote verbatim when quotes would be searchable back to an author, and follow research ethics guidance (for example the Association of Internet Researchers guidelines). Delete content that authors delete. See [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md).

## Pitfalls

- Building on unofficial endpoints or archives that the platform has shut down.
- Ignoring `backoff` or rate-limit headers and getting the app key revoked.
- Pagination that shifts while you crawl active threads; sort by creation time and checkpoint.
- Deleted and edited posts: the version you stored may no longer be what the author published.
- Bots, spam and moderator removals distort counts; record removal status.
- Review stars on different scales (1 to 5, 1 to 10, thumbs) mixed without normalization.

## Checklist

- [ ] Official API or dump chosen; terms read, including training and commercial-use clauses.
- [ ] OAuth app and compliant User-Agent configured; rate-limit and backoff signals honored.
- [ ] Authors pseudonymized; sensitive communities handled with extra care.
- [ ] Deletions propagated; licenses and attribution stored with text.
- [ ] No scraping of logged-in areas or review platforms that forbid it.

## See Also

- [Social Media](social-media.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
- [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)
- [Authentication Patterns](../http/authentication-patterns.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Pagination Patterns](../crawling/pagination-patterns.md)
