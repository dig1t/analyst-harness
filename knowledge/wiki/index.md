# Knowledge Base Index

## fundamentals

What scraping is, how to choose an acquisition strategy, and the vocabulary.

| Article | Summary | Updated |
|---------|---------|---------|
| [Anatomy of a Scraper](fundamentals/anatomy-of-a-scraper.md) | A seven-stage reference architecture, design principles, a skeleton that archives raw responses and validates records, and the run metrics to alert on. | 2026-10-24 |
| [Choosing an Acquisition Strategy](fundamentals/scraping-decision-framework.md) | Requirements first, then a decision tree from official API down to "do not scrape", with stop signs, a recon script and a load estimate. | 2026-10-24 |
| [Common Scraping Pitfalls](fundamentals/common-pitfalls.md) | About 45 mistakes grouped by area, each with symptom, fix and link, plus a code block showing several fixes. | 2026-10-24 |
| [Glossary](fundamentals/glossary.md) | 159 terms in alphabetical order, each defined briefly and linked to its article. | 2026-10-24 |
| [Learning Path: Zero to Production](fundamentals/learning-path.md) | Every other article in the vault, in four numbered stages with a one-line reason each and a practice project per stage. | 2026-10-24 |
| [Scraping Project Lifecycle](fundamentals/scraping-project-lifecycle.md) | Recon, prototype, harden, operate, maintain and retire, each with a gate, plus a project-record template. | 2026-10-24 |
| [Scraping vs Crawling vs APIs](fundamentals/scraping-vs-crawling-vs-apis.md) | Side-by-side comparison, when to use each, six hybrid patterns, an official-API example and a minimal crawler that respects robots.txt. | 2026-10-24 |
| [Static vs Dynamic Sites](fundamentals/static-vs-dynamic-sites.md) | Server-rendered vs browser-rendered pages, a five-minute diagnosis using framework markers, a raw vs rendered comparison, and pulling data out of embedded JSON. | 2026-10-24 |
| [What Is Web Scraping](fundamentals/what-is-web-scraping.md) | Definition, a dated history, use cases and the value chain, plus a small polite scraper for the quotes.toscrape.com sandbox. | 2026-10-24 |

## http

The protocol layer: requests, headers, cookies, status codes, TLS, caching and auth.

| Article | Summary | Updated |
|---------|---------|---------|
| [Authentication Patterns](http/authentication-patterns.md) | Basic auth, API keys, bearer tokens and OAuth grants, a tested OAuth client-credentials helper, MFA and CAPTCHA limits, and credential hygiene. | 2026-10-24 |
| [Compression, Encodings and Character Sets](http/compression-and-encodings.md) | Compression formats, a size cap against decompression bombs, charset detection in the HTML standard's order, a Node decoding caveat, and fixing mojibake. | 2026-10-24 |
| [Cookies, Sessions and State](http/cookies-and-sessions.md) | Cookie attributes and limits, saved cookie jars in Python and Node, a tested login flow with a CSRF token, framework token conventions and session expiry rules. | 2026-10-24 |
| [curl and HTTPie Cheatsheet](http/curl-cheatsheet.md) | Tested recipes for inspecting, posting forms and JSON, cookies, passing secrets safely, retries and rate limits, TLS, exit codes, Copy as cURL, and HTTPie equivalents. | 2026-10-24 |
| [HTTP Caching and Conditional Requests](http/caching-and-conditional-requests.md) | Freshness vs revalidation headers, a SQLite helper for conditional GETs, hishel, requests-cache, Scrapy and HAR caching, and how to read CDN cache headers. | 2026-10-24 |
| [HTTP Fundamentals](http/http-fundamentals.md) | Wire format, URL anatomy, safe and idempotent methods, and a defaults table for requests, httpx, Node fetch and curl read from their source code. | 2026-10-24 |
| [HTTP Status Codes and How to React](http/http-status-codes.md) | What to do for each status code, a retry policy that honors Retry-After in both forms, soft-404 and block-page detection, and guidance for 401/403/429/503. | 2026-10-24 |
| [HTTP/2, HTTP/3 and Connection Reuse](http/http2-http3-and-connection-reuse.md) | What a new connection costs, keep-alive pools, HTTP/2 and QUIC, a client support table, and tested HTTP/2 code for httpx and undici. | 2026-10-24 |
| [Redirects and Canonical URLs](http/redirects-and-canonical-urls.md) | 3xx meanings, what happens when a POST is redirected, keeping credentials from leaking to other hosts, meta-refresh handling, a manual redirect follower and canonical-URL validation. | 2026-10-24 |
| [Request Headers That Matter](http/http-headers-for-scrapers.md) | Identity, content and context headers, how to write an honest User-Agent, how to mirror a page's own request, and which headers never to forge. | 2026-10-24 |
| [TLS and HTTPS for Scrapers](http/tls-and-https.md) | Where each client gets its trusted certificates, corporate TLS interception, error messages mapped to causes, a certificate-inspection helper, and why verification stays on. | 2026-10-24 |

## parsing

Turning responses into data: HTML, selectors, embedded JSON, tables, PDFs, text cleanup.

| Article | Summary | Updated |
|---------|---------|---------|
| [Converting HTML to Markdown and Text](parsing/html-to-markdown.md) | Main-content extraction (trafilatura, Readability) versus conversion (markdownify, turndown), with absolute links, quality gates and license notes. | 2026-10-24 |
| [CSS Selectors for Extraction](parsing/css-selectors.md) | A selector cheat sheet, a tested support matrix for Soup Sieve, cssselect/parsel, selectolax and cheerio, and the card pattern in Python and TypeScript. | 2026-10-24 |
| [Extracting HTML Tables](parsing/html-tables.md) | How pandas read_html behaves (StringIO input, spans, multi-row headers, extract_links), plus a rowspan/colspan grid expander in Python and TypeScript. | 2026-10-24 |
| [HTML and the DOM](parsing/html-and-the-dom.md) | How the WHATWG algorithm turns bytes into a DOM, how html5lib, lxml, html.parser, Lexbor and parse5 repair broken markup differently, and how to choose a parser. | 2026-10-24 |
| [JSON and Embedded Data](parsing/json-and-embedded-data.md) | Finding and decoding hydration blobs (Next.js, Nuxt payloads, JS literals, Apollo refs) and querying them with JMESPath, JSONPath and jq. | 2026-10-24 |
| [OCR and Image-Based Data](parsing/ocr-and-images.md) | When OCR is justified (never for CAPTCHAs), a Tesseract pipeline with preprocessing and confidence scores, an engine comparison, and character error rate measurement. | 2026-10-24 |
| [Parsing Dates, Numbers and Currencies](parsing/dates-numbers-currencies.md) | Formats fixed per source, time zones and DST traps, strict locale-aware number parsing, ambiguous currency symbols, and Decimal storage. | 2026-10-24 |
| [PDF Data Extraction](parsing/pdf-extraction.md) | Classifying pages, extracting text and tables with pypdf, pdfplumber, Camelot and tabula, handling multi-page tables, and running OCRmyPDF on scans. | 2026-10-24 |
| [Regular Expressions: When and When Not](parsing/regex-in-scraping.md) | Where regex fits (cleanup, ids, validation) and where it fails (HTML), how Python and JavaScript engines differ, and catastrophic backtracking with fixes. | 2026-10-24 |
| [Structured Data (JSON-LD, Microdata, OpenGraph)](parsing/structured-data-schema-org.md) | Pulling JSON-LD, Microdata and OpenGraph with extruct, normalizing graphs, types and ids, mapping schema.org Product offers and cross-checking them against the page. | 2026-10-24 |
| [Text Cleaning and Unicode Normalization](parsing/text-cleaning-and-unicode.md) | A cleaning order, NFC versus NFKC, invisible characters, entities, ftfy mojibake repair, and an idempotent clean_text kept separate from match keys. | 2026-10-24 |
| [Writing Robust Selectors](parsing/robust-selectors.md) | A ranked list of stable anchors, brittle and robust examples side by side, fallback chains that report which selector matched, and fixtures plus canaries to catch breakage. | 2026-10-24 |
| [XML, RSS and Atom Feeds](parsing/xml-rss-atom-feeds.md) | RSS, Atom and JSON Feed compared, feed discovery, conditional-GET polling, feedparser and namespace-aware lxml parsing, and XML security. | 2026-10-24 |
| [XPath for Extraction](parsing/xpath.md) | Axes, predicates, a cheat sheet of 25 tested XPath 1.0 expressions, XPath versus CSS, and pitfalls such as NBSP and positional predicates. | 2026-10-24 |

## browser-automation

Headless browsers for JavaScript-heavy sites, and how to keep them cheap.

| Article | Summary | Updated |
|---------|---------|---------|
| [How Headless Browsers Are Detected](browser-automation/headless-detection-explained.md) | Conceptual overview of headless detection signals and why sites check them, plus the responsible response. | 2026-10-24 |
| [Infinite Scroll and Lazy Loading](browser-automation/infinite-scroll-and-lazy-loading.md) | Paginating the underlying API first, then bounded load-more and scroll-and-collect loops for virtualized lists and lazy media. | 2026-10-24 |
| [Making Browsers Cheap](browser-automation/browser-resource-optimization.md) | Cost levers: resource blocking, one browser per worker with a fresh context per job, recycling pools, the headless shell and container settings. | 2026-10-24 |
| [Network Interception and Response Capture](browser-automation/network-interception.md) | Capturing XHR and fetch JSON, routing caveats, recording and replaying HAR files, and moving to a polite direct API client. | 2026-10-24 |
| [Playwright](browser-automation/playwright.md) | Playwright essentials in TypeScript and Python: object model, locators, contexts and storage state, network basics, tracing and Docker guidance. | 2026-10-24 |
| [Puppeteer](browser-automation/puppeteer.md) | Puppeteer essentials: locators, waitUntil options, request interception, the Chrome DevTools Protocol, Firefox over WebDriver BiDi and a comparison with Playwright. | 2026-10-24 |
| [Selenium and WebDriver](browser-automation/selenium.md) | W3C WebDriver and BiDi, explicit waits, BiDi network handlers, Grid with docker-selenium, and when Selenium is still the right choice. | 2026-10-24 |
| [Shadow DOM, iframes and Web Components](browser-automation/shadow-dom-and-iframes.md) | Reading open and declarative shadow DOM in each tool, saving shadow content with the page HTML, and handling iframes. | 2026-10-24 |
| [Waiting Strategies](browser-automation/waiting-strategies.md) | How to wait for data instead of time in all three tools, with a cross-tool table of load events and why network idle is a trap. | 2026-10-24 |
| [When You Need a Browser](browser-automation/when-to-use-a-browser.md) | What a browser costs compared with an HTTP client, signs you do or don't need one, a quick test, hybrid patterns and how to pick a tool. | 2026-10-24 |

## crawling

Crawling at scale: frontiers, normalization, deduplication, robots.txt, sitemaps, pagination.

| Article | Summary | Updated |
|---------|---------|---------|
| [Common Crawl and Web Archives](crawling/common-crawl-and-archives.md) | Common Crawl's indexes and byte-range fetching of single WARC records, the Wayback CDX API and its raw mode, Memento, and when to use an archive instead of crawling. | 2026-10-24 |
| [Crawler Architecture](crawling/crawler-architecture.md) | The crawl loop and its parts (based on the Mercator design), with a tested 120-line async crawler and when to use an existing framework instead. | 2026-10-24 |
| [Deduplication (URLs and Content)](crawling/deduplication.md) | Seen-sets, Bloom filter sizing, content hashing, MinHash/LSH and SimHash, with a tested SimHash index and Bloom filter. | 2026-10-24 |
| [Distributed Crawling](crawling/distributed-crawling.md) | Sharding by host with rendezvous hashing, and a Redis frontier with leases that recovers from a crashed worker. | 2026-10-24 |
| [Incremental Crawling](crawling/incremental-crawling.md) | Change signals, conditional GETs, revisit-policy research and change-rate estimation, with tested code. | 2026-10-24 |
| [Pagination Patterns](crawling/pagination-patterns.md) | Page, offset, cursor, keyset, RFC 8288 Link headers, when to stop and result caps, with tested Python and TypeScript paginators. | 2026-10-24 |
| [Politeness and Rate Limiting](crawling/politeness-and-rate-limiting.md) | Per-host budgets, adaptive slow-down (AIMD), Retry-After, with a tested token-bucket client. | 2026-10-24 |
| [robots.txt (RFC 9309)](crawling/robots-txt.md) | The RFC 9309 rules checked against the RFC text (group selection, longest match, allow wins ties, wildcards, 4xx vs 5xx, redirects, caching, size limit), plus crawl-delay, parser differences and tested code. | 2026-10-24 |
| [Spider Traps and Crawl Hygiene](crawling/spider-traps.md) | A catalog of traps, tarpits and labyrinths, a tested URL trap guard, soft-404 detection, and an overall response deadline that stops slow-drip servers. | 2026-10-24 |
| [URL Frontier and Scheduling](crawling/url-frontier-and-scheduling.md) | Ordering strategies, Mercator-style per-host queues, revisit policy and per-host budgets, with a tested async frontier. | 2026-10-24 |
| [URL Normalization and Canonicalization](crawling/url-normalization.md) | Which normalizations are always safe under RFC 3986 and which need evidence, how to strip tracking and session parameters, with tested Python and WHATWG-based TypeScript normalizers. | 2026-10-24 |
| [XML Sitemaps](crawling/sitemaps.md) | Protocol limits, discovery, how far lastmod can be trusted, and a streaming, gzip-bomb-safe sitemap reader. | 2026-10-24 |

## apis

Official, open and undocumented APIs, GraphQL, real-time feeds and rate limits.

| Article | Summary | Updated |
|---------|---------|---------|
| [API Rate Limits and Quotas](apis/api-rate-limits.md) | 429 and Retry-After, X-RateLimit headers and the IETF RateLimit draft fields, GitHub's limits as an example, with a tested budget-aware client. | 2026-10-24 |
| [Catalog of Useful Open APIs](apis/official-apis-catalog.md) | GitHub, Hacker News, Wikimedia, OpenAlex, SEC EDGAR, FRED, World Bank, Census, OpenStreetMap and arXiv: base URL, auth, limits, an example request and the bulk alternative for each. | 2026-10-24 |
| [Consuming REST APIs Well](apis/rest-api-consumption.md) | Filtering, field selection, RFC 9457 errors, safe retries, versioning and Deprecation/Sunset headers, with tested Python and TypeScript clients. | 2026-10-24 |
| [Finding Hidden APIs with DevTools](apis/finding-hidden-apis.md) | The DevTools workflow, replaying requests with a tested header minimizer, what is fine and what is off limits, and legal cautions. | 2026-10-24 |
| [GraphQL Endpoints](apis/graphql.md) | Errors returned with HTTP 200, connection pagination, persisted queries and cost limits, with tested code. | 2026-10-24 |
| [Mobile App APIs](apis/mobile-app-apis.md) | Why app APIs are off limits by default (pinning, attestation, license terms, anti-circumvention law), better routes to the data, and an open GTFS feed example. | 2026-10-24 |
| [Webhooks and Push-Based Acquisition](apis/webhooks-and-push.md) | Receiving webhooks safely, WebSub, and change feeds versus polling, with a tested Node receiver and a Standard Webhooks verifier. | 2026-10-24 |
| [WebSockets and Server-Sent Events](apis/websockets-and-sse.md) | Protocol essentials, a tested WebSocket recorder that reconnects, and an SSE reader that follows the spec and resumes with Last-Event-ID. | 2026-10-24 |

## anti-bot

How bot defenses work and how a responsible scraper responds to them.

| Article | Summary | Updated |
|---------|---------|---------|
| [Browser and TLS Fingerprinting](anti-bot/fingerprinting.md) | Conceptual explanation of browser, JA3, JA4 and HTTP/2 fingerprints, how bot management uses them, and why an honest identity wins. | 2026-10-24 |
| [CAPTCHAs and What They Mean for Your Project](anti-bot/captchas.md) | What CAPTCHAs are for, how to detect one, why solving or outsourcing them is out of bounds, and the legitimate alternatives. | 2026-10-24 |
| [How Bot Detection Works](anti-bot/how-bot-detection-works.md) | The detection layers from IP reputation to ML scoring, the actions sites take, and what each layer means for a polite scraper. | 2026-10-24 |
| [Identifying Your Bot](anti-bot/identifying-your-bot.md) | Honest User-Agent and From header conventions, what a bot page should say, robots.txt tokens and bot verification methods. | 2026-10-24 |
| [Proxies: Types, Uses and Ethics](anti-bot/proxies-overview.md) | Proxy protocols and exit-network types, legitimate egress uses, the consent problems of residential networks, and why proxies don't fix blocks. | 2026-10-24 |
| [Recognizing Blocks and Responding Responsibly](anti-bot/blocks-and-responsible-response.md) | Hard and soft block signals, a block classifier and per-host circuit breaker that stop and escalate, a response ladder and a contact template. | 2026-10-24 |
| [WAFs and CDN Bot Management](anti-bot/waf-and-cdn-bot-management.md) | What WAFs and CDN bot management do, how to tell which vendor fronts a site, verified-bot programs and AI-crawler controls. | 2026-10-24 |

## legal-ethics

Laws, cases, contracts, personal data and the ethics of scraping (not legal advice).

| Article | Summary | Updated |
|---------|---------|---------|
| [CFAA and Key US Cases](legal-ethics/cfaa-and-key-us-cases.md) | Case-by-case coverage of Van Buren, hiQ v. LinkedIn, Meta and X v. Bright Data, Power Ventures, Craigslist v. 3Taps, Sandvig, the DOJ 2022 policy and more. | 2026-10-24 |
| [Copyright and Database Rights](legal-ethics/copyright-and-database-rights.md) | Facts versus expression, fair use and AI training cases, the EU database right, TDM exceptions and the AI Act. | 2026-10-24 |
| [Ethical Scraping Checklist](legal-ethics/ethical-scraping-checklist.md) | Ten principles, red lines, a situation-and-response table, an example review record and a full pre-flight checklist. | 2026-10-24 |
| [International Considerations](legal-ethics/international-considerations.md) | How jurisdiction attaches, then a high-level tour of the EU, UK, Canada, Australia, India, Japan, Singapore, China, South Korea and Brazil. | 2026-10-24 |
| [Legal Landscape Overview](legal-ethics/legal-landscape-overview.md) | The main legal theories behind scraping disputes, the risk factors that matter most, lower- and higher-risk patterns, practical risk reduction and recent trends (not legal advice). | 2026-10-24 |
| [Personal Data: GDPR, CCPA and More](legal-ethics/personal-data-gdpr-ccpa.md) | Why public data is still personal data, legitimate-interest assessments, the enforcement record, US state privacy laws and a data-minimization snippet. | 2026-10-24 |
| [Terms of Service and Contracts](legal-ethics/terms-of-service-and-contracts.md) | How online contracts form (clickwrap, sign-in wrap, browsewrap), the logged-in versus logged-off line, preemption splits and EU rules such as Ryanair v. PR Aviation. | 2026-10-24 |

## data-quality

Cleaning, validation, deduplication, change detection, monitoring and testing.

| Article | Summary | Updated |
|---------|---------|---------|
| [Change Detection and Diffing](data-quality/change-detection-and-diffing.md) | Change detection at the HTTP, page and record level: fingerprinting, canonical JSON hashing, field-level diffs and alerting rules. | 2026-10-24 |
| [Data Cleaning Pipeline](data-quality/data-cleaning-pipeline.md) | A staged pipeline from raw response to published table with pure, idempotent transforms, quarantine and parser versioning. | 2026-10-24 |
| [Data Quality Monitoring](data-quality/data-quality-monitoring.md) | Freshness, volume, null-rate, validity, uniqueness and drift metrics with SQL, a median-based monitor and holding back publication when checks fail. | 2026-10-24 |
| [Provenance and Lineage](data-quality/provenance-and-lineage.md) | Minimum provenance fields per record, content-addressed raw archiving, WARC mapping, PROV and OpenLineage, and GDPR source duties. | 2026-10-24 |
| [Record Deduplication and Entity Resolution](data-quality/record-deduplication-entity-resolution.md) | Normalized matching keys, exact-duplicate SQL, blocking, fuzzy scoring, union-find clustering, golden records and the Fellegi-Sunter model. | 2026-10-24 |
| [Schema Validation](data-quality/schema-validation.md) | Validation at the boundary with zod 4 and Pydantic v2, failing a run when too many records are invalid, JSON Schema export and coercion pitfalls. | 2026-10-24 |
| [Testing Scrapers](data-quality/testing-scrapers.md) | Testing from saved fixtures up to live canaries: golden files, contract and snapshot tests, recorded HTTP replay and canary runners. | 2026-10-24 |

## storage

File formats and databases for scraped data, raw archives and data modeling.

| Article | Summary | Updated |
|---------|---------|---------|
| [Data Modeling for Scraped Data](storage/data-modeling-for-scraped-data.md) | Append-only observations with hashes of the business fields, SCD Type 2 versions, two time axes and delisting rules. | 2026-10-24 |
| [File Formats for Scraped Data](storage/file-formats.md) | JSONL for raw output, Parquet for curated data, CSV only for people and Avro for streams, with tested writers and pitfalls such as pandas type coercion. | 2026-10-24 |
| [Object Storage and Raw Archives](storage/object-storage-and-raw-archives.md) | Why to keep raw responses, content-addressed S3/R2 objects with conditional writes and a manifest versus WARC files, re-parsing, cost and retention. | 2026-10-24 |
| [PostgreSQL for Scraped Data](storage/postgres-for-scraped-data.md) | Natural-key upserts with hash-based change tracking, COPY into staging plus MERGE, JSONB and GIN operator classes, BRIN and partition retention. | 2026-10-24 |
| [SQLite and DuckDB](storage/sqlite-and-duckdb.md) | SQLite as the scraper's working store (WAL, STRICT tables, upserts), DuckDB for in-place analysis and Parquet export, and how each handles concurrent access. | 2026-10-24 |

## operations

Running scrapers in production: scheduling, retries, monitoring, hosting, cost.

| Article | Summary | Updated |
|---------|---------|---------|
| [Cheap Hosting for Scrapers](operations/cheap-hosting.md) | Hosting options compared with dated prices where checked, a Dockerfile and compose setup, scheduled GitHub Actions and its terms, Cloud Run jobs, Workers cron, and IP-reputation and browser-memory trade-offs. | 2026-10-24 |
| [Concurrency and Async IO](operations/concurrency-and-async.md) | Global cap, per-host cap, pacing and parallelism as separate knobs, an asyncio worker pool with semaphores and a bounded queue, and Node p-limit with per-host queues. | 2026-10-24 |
| [Cost Control](operations/cost-control.md) | Unit cost per record and six levers (conditional GET, lighter fetches, avoiding browsers, proxies, LLM batching and caching, egress and storage), plus a per-run budget guard. | 2026-10-24 |
| [Logging and Observability](operations/logging-and-observability.md) | Structured JSON logs (stdlib, structlog, pino), run id correlation, low-cardinality Prometheus metrics, and OpenTelemetry spans that do not leak trace headers to target sites. | 2026-10-24 |
| [Maintenance and Breakage Response](operations/scraper-maintenance-and-breakage.md) | Why scrapers break, a selector-health check, five triage questions, a repair workflow (fixtures, backfill, lessons), and guardrails for LLM-assisted repair. | 2026-10-24 |
| [Monitoring and Alerting](operations/monitoring-and-alerting.md) | Outcome metrics checked against a baseline, dead man's switches, a Discord webhook sender that handles 429, Slack, and alert design rules. | 2026-10-24 |
| [Queues and Workers](operations/queues-and-workers.md) | Delivery semantics, BullMQ, Celery, RQ, SQS and Postgres SKIP LOCKED, plus backpressure and rate limits that hold across workers. | 2026-10-24 |
| [Retries, Backoff and Idempotency](operations/retries-backoff-idempotency.md) | Which outcomes to retry, exponential backoff with full jitter, TypeScript and Python retry code with Retry-After and a retry budget, library defaults, and idempotent upserts. | 2026-10-24 |
| [Scheduling and Cron](operations/scheduling-and-cron.md) | Cron syntax with a checked expression table, how cronie, systemd, GitHub Actions, Kubernetes, croner, BullMQ, Workers and Railway differ, and the rules for DST, jitter, overlap guards, timeouts and missed runs. | 2026-10-24 |
| [Secrets and Configuration](operations/secrets-and-config.md) | Config vs secrets, where secrets live in each environment, SOPS with age, startup validation, secret scanning and push protection, scraper-specific secrets, and rotation. | 2026-10-24 |

## tools

The tooling landscape across languages, CLIs, services and DevTools.

| Article | Summary | Updated |
|---------|---------|---------|
| [Browser DevTools for Scrapers](tools/devtools-for-scrapers.md) | A recon workflow, static vs dynamic checks, testing selectors in the console, copy as cURL, what sanitized HAR exports actually remove, and Playwright HAR record and replay. | 2026-10-24 |
| [Command-Line Tools](tools/cli-tools.md) | curl options that matter for scraping, a cursor-pagination loop in bash, wget mirroring to WARC, and htmlq, pup, Xidel, jq and yq recipes with maintenance status. | 2026-10-24 |
| [Go, Rust and Other Ecosystems](tools/go-rust-and-others.md) | A polite Colly crawler (it ignores robots.txt by default), reqwest with the scraper crate, and a table for Java, Ruby, R, PHP, .NET and Elixir. | 2026-10-24 |
| [No-Code and Low-Code Scrapers](tools/no-code-scrapers.md) | Spreadsheet functions, extensions, visual apps, workflow tools, marketplaces, when these fit, their limits, and when to move to code. | 2026-10-24 |
| [Node.js Scraping Stack](tools/node-scraping-stack.md) | fetch, undici, got, cheerio, jsdom and Crawlee with versions and Node requirements, a cheerio example, and a polite Crawlee crawler with notes on its browser-like defaults. | 2026-10-24 |
| [Python Scraping Stack](tools/python-scraping-stack.md) | Current versions and defaults of requests, httpx and aiohttp, four parsers compared on one page, requests with retries, and the robots.txt parser difference between Python versions. | 2026-10-24 |
| [Scraping Services and Platforms](tools/scraping-services-and-platforms.md) | Neutral categories and product descriptions (scraping APIs, hosted browsers, search APIs, Common Crawl), build vs buy, and a vendor checklist that does not promote bypass features. | 2026-10-24 |
| [Scrapy](tools/scrapy.md) | Scrapy architecture, a polite AutoThrottle spider, settings with template vs fallback defaults, pipelines, middlewares, running and debugging, and recent breaking changes. | 2026-10-24 |

## llm-scraping

Using LLMs to extract, validate and maintain scraped data, and AI crawler opt-outs.

| Article | Summary | Updated |
|---------|---------|---------|
| [Agentic Browsing](llm-scraping/agentic-browsing.md) | How browser agents work, their reliability limits, the prompt-injection threat model and a guarded Playwright loop. | 2026-10-24 |
| [AI Crawlers and Content Opt-Outs](llm-scraping/ai-crawlers-and-opt-outs.md) | Current AI crawler user-agent tokens, RFC 9309 rules, TDMRep, IETF AIPREF drafts, llms.txt, EU AI Act context and a tested signal checker. | 2026-10-24 |
| [Costs and Caching for LLM Scraping](llm-scraping/llm-scraping-costs.md) | Cost formula, dated Anthropic prices and caching/batch numbers, a worked 100,000-page example, three caching levels and model choice. | 2026-10-24 |
| [LLM-Assisted Extraction](llm-scraping/llm-assisted-extraction.md) | When an LLM beats selectors and when it does not, four usage patterns, a hybrid extractor (JSON-LD first, LLM fallback) and notes on reproducibility and privacy. | 2026-10-24 |
| [Preparing HTML for LLMs](llm-scraping/preparing-html-for-llms.md) | Take embedded structured data first, then prune, pick a representation, count tokens and chunk along page structure, with tested cleaning code. | 2026-10-24 |
| [Schema-Guided Extraction](llm-scraping/schema-guided-extraction.md) | Structured outputs and strict tool use, the JSON Schema subsets providers support, and extraction schema design (nullable fields, evidence fields). | 2026-10-24 |
| [Using LLMs to Write and Repair Scrapers](llm-scraping/llm-generated-scrapers.md) | Generating declarative selector specs, held-out evaluation, a self-healing loop that tells layout changes apart from blocks, review gates and sandboxing. | 2026-10-24 |
| [Validating LLM Extractions](llm-scraping/validating-llm-output.md) | Layered checks: schema, grounding of quotes and numbers against the page, rules, cross-checks, monitoring, and human audits with sample-size math. | 2026-10-24 |

## sources

Playbooks for common source types: news, e-commerce, jobs, open data, finance, research.

| Article | Summary | Updated |
|---------|---------|---------|
| [Academic and Research Data](sources/academic-and-research-data.md) | Current rules for OpenAlex, Crossref, arXiv (1 request per 3 s, single connection), Semantic Scholar, NCBI and Unpaywall. | 2026-10-24 |
| [E-commerce and Price Monitoring](sources/ecommerce-and-prices.md) | Feeds and marketplace APIs first, Product/Offer/ProductGroup JSON-LD, append-only price history, and the EU 30-day prior-price rule. | 2026-10-24 |
| [Financial Data and SEC EDGAR](sources/financial-data-sec-edgar.md) | SEC fair access rules (10 req/s, declared User-Agent), data.sec.gov submissions, companyfacts and frames, bulk ZIPs and XBRL fact traps. | 2026-10-24 |
| [GitHub and Developer Data](sources/github-and-developer-data.md) | GitHub REST, GraphQL, search and secondary limits, plus GH Archive, npm, PyPI, crates.io, deps.dev and the Acceptable Use Policies. | 2026-10-24 |
| [Government and Open Data Portals](sources/government-open-data.md) | CKAN, Socrata SODA3 app tokens, ArcGIS and statistics agency APIs, the new data.gov catalog API, licensing and data vintages. | 2026-10-24 |
| [Job Postings](sources/job-postings.md) | Public Greenhouse, Lever, Ashby and SmartRecruiters endpoints with tested code, plus JobPosting markup, USAJOBS, posting lifecycle and pay-transparency salary fields. | 2026-10-24 |
| [Maps and Local Business Data](sources/maps-and-local-business.md) | OSM extracts, Overpass and Nominatim fair-use limits, Overture per-record licenses, Google Maps terms, and ODbL attribution. | 2026-10-24 |
| [News Sites and RSS](sources/news-and-rss.md) | Finding feeds and news sitemaps, polling them with conditional GET, extracting with JSON-LD plus Trafilatura, respecting paywalls, and the EU press publishers' right. | 2026-10-24 |
| [Real Estate Listings](sources/real-estate.md) | Listing data is licensed (MLS through IDX/VOW and the RESO Web API); covers open aggregate data, UK Price Paid address limits, and the 3Taps and VHT v. Zillow cautions. | 2026-10-24 |
| [Reviews and Forums](sources/reviews-and-forums.md) | Reddit Data API (OAuth, User-Agent format, terms), Stack Exchange, HN and Discourse JSON, review APIs, the FTC fake-review rule, and pseudonymizing users. | 2026-10-24 |
| [Social Media](sources/social-media.md) | API-first table for X, Meta, TikTok, YouTube, Bluesky and Mastodon, plus DSA Article 40 and research programs, handling deletions, and personal data. | 2026-10-24 |
| [Wikipedia and Wikidata](sources/wikipedia-and-wikidata.md) | User-Agent policy, rate limits, maxlag, Action/REST/SPARQL endpoints after the WDQS graph split, dumps, and CC BY-SA vs CC0. | 2026-10-24 |

## harness

How this harness defines, schedules and learns from scrapers.

| Article | Summary | Updated |
|---------|---------|---------|
| [Declarative Scraper Specs in This Harness](harness/harness-scraper-spec.md) | The YAML spec format the harness runs: sources, field rules, keys, validation, change detection, politeness and alerts, with testing advice and pitfalls. | 2026-10-24 |
| [How the Agents Use and Grow This Vault](harness/harness-knowledge-workflow.md) | How agents search this vault, how the librarian grows it with the LLM Wiki workflow, how run lessons are written and retrieved, and how lint keeps it healthy. | 2026-10-24 |
| [Runbook: From Request to Scheduled Scraper](harness/scraping-runbook.md) | The procedure from a request to a scheduled, monitored scraper: recon, strategy, ethics check, spec draft, dry run, review, apply and operate. | 2026-10-24 |
