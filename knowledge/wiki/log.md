# Wiki Log

Append-only record of vault operations, newest last. Heading formats are defined in
`knowledge/AGENTS.md`.

## [2026-10-24] bootstrap | 131 seed articles across 15 topics

- Created the layout (`raw/`, `wiki/<topic>/`, `wiki/index.md`, this log) and the schema in
  `knowledge/AGENTS.md`.
- Wrote 131 seed articles from expert knowledge with cited references. None has a raw capture
  yet; each carries `> Raw: none yet (seed article)`.
- Code samples were run by their authors against local test servers, mock servers or local
  databases before publishing.
- Live web access was not available while writing, so the claims below came from memory,
  secondary sources or copies of primary sources hosted on GitHub. Check them first when
  ingesting sources.

### Verification queue

- **fundamentals, http**: CA/Browser Forum ballot SC-081 certificate-lifetime dates; browser
  versions that support zstd; the exact RFC 9309 wording on access authorization; OAuth RFC
  numbers; Django, Rails and Laravel CSRF token names; the years given for Selenium, the
  Internet Archive and eBay v. Bidder's Edge; the meanings of Laravel 419, nginx 499 and
  Cloudflare 52x codes; whether Node 24 and later still mis-decode windows-1252 with
  `TextDecoder`.
- **parsing, storage**: Nuxt `__NUXT_DATA__`, Next.js `self.__next_f` and `/_next/data/`, and
  Apollo `__APOLLO_STATE__` naming; S3 per-prefix request rates, Standard-IA minimums, the
  2 KB metadata limit and R2 egress pricing; DuckDB `ATTACH (TYPE sqlite)`; psycopg
  `cursor.copy()` end to end; the pandas version that deprecated literal HTML input; the
  300 DPI Tesseract guidance.
- **crawling, apis**: FRED's request limit; Wikimedia's 2026 API limits (an experimental
  table); Google treating a 429 on robots.txt like a 5xx; Stripe's retry window in live mode;
  the URL of Google's faceted-navigation guide; the "three back queues per fetcher thread" rule
  of thumb; Chrome's `_webSocketMessages` field in HAR exports. OpenAlex prices and Algolia HN
  limits were left out.
- **browser-automation, anti-bot**: Googlebot reverse-DNS domains and example IP; reCAPTCHA v3
  score range and test keys; Wikimedia and SEC EDGAR User-Agent rules; Google's 429 and 503
  crawl-rate guidance; 911 S5 botnet figures; the Craigslist v. 3Taps holding; findings cited
  from fingerprinting and bot-detection research papers; CloudFront, Akamai and Fastly header
  indicators; AWS WAF Bot Control inspection levels; several documentation URLs.
- **legal-ethics, data-quality**: the outcome of Ryanair's Third Circuit appeal (described as
  pending); whether the X v. Bright Data settlement was finalized; Google's amended complaint
  against SerpApi; the OAIC's 2024 Clearview follow-up; the conclusions of the UK's March 2026
  copyright and AI report; the exact September 2026 date of the Reddit v. Anthropic ruling;
  quotations from Van Buren; statutory section and article numbers (GDPR, the DSM and Database
  Directives, India's IT Act, Directive 2013/40/EU, PIPL).
- **sources, llm-scraping**: Reddit's free API tier, model-training and deletion terms, and the
  Pushshift restriction; Google Places returning up to five reviews; the FTC review rule's
  effective date; Meta v. Bright Data and the 2023 joint statement by data protection
  authorities; the CrowdTangle shutdown and X pay-per-use details; the NAR settlement date;
  the Wikidata Query Service timeout and dump cadence; Google's required and recommended
  JobPosting properties; the Ashby and SmartRecruiters endpoints; Cloudflare's default AI
  blocking, Content-Signal and RSL; the GPAI Code of Practice robots.txt commitment; OpenAI's
  robots.txt handling for ChatGPT-User; OpenAI and Gemini structured-output parameters; cited
  arXiv identifiers.
- **operations, tools**: VPS prices (Hetzner, DigitalOcean, Vultr, Linode, OVH); Oracle Always
  Free details; the AWS 2025 free-tier change and Lambda's 15-minute limit; GCP e2-micro
  region limits; Slack webhook details; Uptime Kuma push monitors; Google Sheets IMPORT refresh
  behavior and help-page URLs; Power Query features; the SRE book's alerting advice; the AWS
  backoff-with-jitter formulas; commercial scraping APIs described from package metadata only.
- **Findings while testing code** (worth confirming): httpx had no release after 0.28.1
  (December 2024) and a successor project was reported; selectolax 1.0 removed
  `selectolax.parser`; Node 20.20 and 22.22 decoded windows-1252 text incorrectly with
  `TextDecoder`; Scrapy 2.16 removed `start_requests()`; BullMQ 6 needs ioredis installed
  separately; Colly ignores robots.txt by default; a Cloud Run job needs `--command` with
  `--args`.
