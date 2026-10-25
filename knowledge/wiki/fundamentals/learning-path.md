---
tags: [scraping, fundamentals, learning-path, curriculum]
aliases: [Learning path, Reading order, Curriculum, Where to start, Zero to production]
---

# Learning Path: Zero to Production

> Sources: This vault's article manifest; Ryan Mitchell, Web Scraping with Python, O'Reilly, companion code (https://github.com/REMitchell/python-scraping); Scrapy tutorial (https://docs.scrapy.org/en/latest/intro/tutorial.html); Playwright documentation (https://playwright.dev/docs/intro); MDN, HTTP (https://developer.mozilla.org/en-US/docs/Web/HTTP); Toscrape sandboxes for practice (https://toscrape.com/); Google, Site Reliability Engineering (https://sre.google/sre-book/table-of-contents/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

This is a reading order through every article in the vault, in four stages. **Beginner** gets you to a first polite, correct scraper and the habit of checking for an API first. **Intermediate** covers real sites: messy markup, sessions, hidden APIs, browsers, crawling and the legal basics. **Production** is about running unattended: retries, caching, testing, data quality, storage, scheduling, monitoring and maintenance. **Advanced** covers scale, special formats, bot-defense concepts, push-based sources and LLM-assisted scraping. Each entry says why it comes next. Read a stage, then do its practice project before moving on; skip entries that do not apply to your project, but do not skip the ethics and legal entries.

## How to use this path

- **Numbers are global**, so a person or an agent can say "continue from step 49".
- **Practice on sandboxes first**: `quotes.toscrape.com` and `books.toscrape.com` exist for scraping practice, and official APIs such as Hacker News's are open to everyone.
- **Keep the [Glossary](glossary.md) open**; every term links to its article.
- **Agents in this harness** can fast-track with steps 4, 5, 7, 16, 23, 73, 74 and 75, then pull other articles by search as tasks require ([How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)).

## Stage 1: Beginner (your first polite scraper)

1. [What Is Web Scraping](what-is-web-scraping.md): the vocabulary and value chain everything else builds on.
2. [Glossary](glossary.md): a companion for the whole path; skim it now, return often.
3. [Scraping vs Crawling vs APIs](scraping-vs-crawling-vs-apis.md): know which activity you are doing before picking tools.
4. [Choosing an Acquisition Strategy](scraping-decision-framework.md): the ladder that keeps you from scraping what an API already provides.
5. [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md): the questions to answer before the first request.
6. [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md): the main legal theories and risk factors, in plain terms.
7. [robots.txt (RFC 9309)](../crawling/robots-txt.md): how sites state their wishes to bots, and how to honor them.
8. [Identifying Your Bot](../anti-bot/identifying-your-bot.md): an honest User-Agent and contact page from day one.
9. [HTTP Fundamentals](../http/http-fundamentals.md): URLs, methods, messages and client defaults behind every fetch.
10. [Request Headers That Matter](../http/http-headers-for-scrapers.md): what to send, and what never to forge.
11. [HTTP Status Codes and How to React](../http/http-status-codes.md): turn each response into the right action.
12. [curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md): inspect any endpoint from the terminal before writing code.
13. [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md): see what a page really loads.
14. [HTML and the DOM](../parsing/html-and-the-dom.md): how parsers turn markup, even broken markup, into a tree.
15. [CSS Selectors for Extraction](../parsing/css-selectors.md): the everyday tool for picking fields.
16. [Static vs Dynamic Sites](static-vs-dynamic-sites.md): find where the data first appears before choosing a method.
17. [JSON and Embedded Data](../parsing/json-and-embedded-data.md): data shipped as JSON beats selectors.
18. [Python Scraping Stack](../tools/python-scraping-stack.md): the libraries most examples here use.
19. [Node.js Scraping Stack](../tools/node-scraping-stack.md): the same toolkit in JavaScript and TypeScript.
20. [Command-Line Tools](../tools/cli-tools.md): jq, htmlq and friends for quick inspection.
21. [Pagination Patterns](../crawling/pagination-patterns.md): reach every item and know when to stop.
22. [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md): how fast is too fast, per host.
23. [Anatomy of a Scraper](anatomy-of-a-scraper.md): the seven stages your first script will grow into.
24. [Common Scraping Pitfalls](common-pitfalls.md): the mistakes to avoid on the first project.
25. [Consuming REST APIs Well](../apis/rest-api-consumption.md): when a provider offers an API, use it properly.
26. [Catalog of Useful Open APIs](../apis/official-apis-catalog.md): real APIs to practice on.
27. [Government and Open Data Portals](../sources/government-open-data.md): bulk data that rarely needs scraping.
28. [Wikipedia and Wikidata](../sources/wikipedia-and-wikidata.md): APIs, dumps and etiquette of a scraper-friendly source.
29. [File Formats for Scraped Data](../storage/file-formats.md): CSV, JSONL or Parquet for your first dataset.
30. [No-Code and Low-Code Scrapers](../tools/no-code-scrapers.md): when a point-and-click tool is enough.

Practice: scrape every quote, author and tag from `quotes.toscrape.com` into JSONL with an honest User-Agent, a one-second delay and the source URL on every record; then fetch the same kind of data from an official API and compare the effort.

## Stage 2: Intermediate (real sites, real constraints)

31. [XPath for Extraction](../parsing/xpath.md): for selections CSS cannot express.
32. [Writing Robust Selectors](../parsing/robust-selectors.md): selectors that survive redesigns.
33. [Regular Expressions: When and When Not](../parsing/regex-in-scraping.md): cleanup yes, HTML parsing no.
34. [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md): schema.org data many pages already publish.
35. [Extracting HTML Tables](../parsing/html-tables.md): rowspan, colspan and header detection.
36. [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md): cheap discovery and change signals.
37. [XML Sitemaps](../crawling/sitemaps.md): the site's own list of URLs and modification dates.
38. [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md): make text clean and comparable.
39. [Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md): locale traps that silently corrupt values.
40. [Compression, Encodings and Character Sets](../http/compression-and-encodings.md): no mojibake, no decompression bombs.
41. [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md): follow safely and deduplicate with care.
42. [Cookies, Sessions and State](../http/cookies-and-sessions.md): sessions, CSRF tokens and persisted jars.
43. [Authentication Patterns](../http/authentication-patterns.md): API keys, OAuth flows and credential hygiene.
44. [TLS and HTTPS for Scrapers](../http/tls-and-https.md): fix certificate errors without disabling verification.
45. [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md): the JSON endpoints behind modern pages.
46. [GraphQL Endpoints](../apis/graphql.md): queries, persisted queries and connection pagination.
47. [API Rate Limits and Quotas](../apis/api-rate-limits.md): 429s, `Retry-After` and request budgets.
48. [When You Need a Browser](../browser-automation/when-to-use-a-browser.md): the cost-benefit test before launching Chromium.
49. [Playwright](../browser-automation/playwright.md): the default browser automation tool in this vault.
50. [Waiting Strategies](../browser-automation/waiting-strategies.md): wait for what you need, not for "network idle".
51. [Network Interception and Response Capture](../browser-automation/network-interception.md): let the browser reveal the API.
52. [Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md): usually a paginated API in disguise.
53. [Crawler Architecture](../crawling/crawler-architecture.md): the components once you need discovery.
54. [URL Normalization and Canonicalization](../crawling/url-normalization.md): one URL per resource.
55. [Spider Traps and Crawl Hygiene](../crawling/spider-traps.md): calendars, session IDs and endless parameters.
56. [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md): when an existing corpus beats crawling.
57. [How Bot Detection Works](../anti-bot/how-bot-detection-works.md): why scrapers get blocked.
58. [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md): the right reaction to a block.
59. [CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md): a stop sign, and the alternatives.
60. [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md): browsewrap, clickwrap and contract risk.
61. [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md): facts versus expression, the EU database right, text and data mining.
62. [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md): public data is still personal data.
63. [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md): what the landmark US cases decided.
64. [Scrapy](../tools/scrapy.md): the full framework once scripts outgrow themselves.
65. [SQLite and DuckDB](../storage/sqlite-and-duckdb.md): embedded storage and fast analysis.
66. [Schema Validation](../data-quality/schema-validation.md): contracts at the boundary.
67. [Concurrency and Async IO](../operations/concurrency-and-async.md): speed without overload.
68. [News Sites and RSS](../sources/news-and-rss.md): feeds, article extraction and paywalls respected.
69. [E-commerce and Price Monitoring](../sources/ecommerce-and-prices.md): variants, structured data and price history.
70. [Job Postings](../sources/job-postings.md): public applicant-tracking APIs before HTML.
71. [Academic and Research Data](../sources/academic-and-research-data.md): arXiv, Crossref, OpenAlex and PubMed.
72. [GitHub and Developer Data](../sources/github-and-developer-data.md): APIs, GH Archive and package registries.

Practice: build a product-price scraper for `books.toscrape.com` that discovers pages by pagination, prefers structured data where present, validates records with a schema, stores them in SQLite, and handles one simulated login or JSON endpoint of your own test server.

## Stage 3: Production (running unattended)

73. [Scraping Project Lifecycle](scraping-project-lifecycle.md): phases and gates from recon to retirement.
74. [Runbook: From Request to Scheduled Scraper](../harness/scraping-runbook.md): the end-to-end procedure in this harness.
75. [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md): the spec format agents produce and review.
76. [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md): safe retries and idempotent writes.
77. [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md): revisit without re-downloading.
78. [Incremental Crawling](../crawling/incremental-crawling.md): revisit policies matched to change rates.
79. [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md): cheaper fetching per request.
80. [Testing Scrapers](../data-quality/testing-scrapers.md): fixtures, snapshots, contract tests and canaries.
81. [Data Cleaning Pipeline](../data-quality/data-cleaning-pipeline.md): idempotent stages from raw to clean.
82. [Deduplication (URLs and Content)](../crawling/deduplication.md): hashes and near-duplicate detection.
83. [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md): know what changed and alert on it.
84. [Provenance and Lineage](../data-quality/provenance-and-lineage.md): every value traceable to a fetch.
85. [Data Quality Monitoring](../data-quality/data-quality-monitoring.md): freshness, volume, null rates and drift.
86. [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md): keep raw responses for re-parsing.
87. [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md): snapshots and append-only observations.
88. [PostgreSQL for Scraped Data](../storage/postgres-for-scraped-data.md): upserts, JSONB, partitions and indexes.
89. [Scheduling and Cron](../operations/scheduling-and-cron.md): time zones, jitter and overlap protection.
90. [Secrets and Configuration](../operations/secrets-and-config.md): credentials out of code and out of git.
91. [Logging and Observability](../operations/logging-and-observability.md): structured logs, metrics and correlation IDs.
92. [Monitoring and Alerting](../operations/monitoring-and-alerting.md): alerts that reach an owner.
93. [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md): triage and repair when sites change.
94. [Cost Control](../operations/cost-control.md): bandwidth, browsers, proxies and tokens.
95. [Cheap Hosting for Scrapers](../operations/cheap-hosting.md): VPS, serverless and scheduled CI runners.
96. [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md): block resources, reuse contexts, cap memory.
97. [Scraping Services and Platforms](../tools/scraping-services-and-platforms.md): when to buy instead of build.
98. [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md): lessons, search and the librarian.
99. [Financial Data and SEC EDGAR](../sources/financial-data-sec-edgar.md): a published fair-access policy to follow exactly.

Practice: put the stage 2 scraper on a schedule with raw archiving, conditional requests, schema validation, a failing exit code on empty output, an alert to a channel, and a written project record with an owner and a review date.

## Stage 4: Advanced (scale, special cases, LLMs)

100. [URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md): priorities, per-host queues and revisit policy.
101. [Distributed Crawling](../crawling/distributed-crawling.md): sharding by host, coordination and failure handling.
102. [Queues and Workers](../operations/queues-and-workers.md): backpressure and worker pools.
103. [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md): matching the same entity across sources.
104. [PDF Data Extraction](../parsing/pdf-extraction.md): tables and text from layout-heavy documents.
105. [OCR and Image-Based Data](../parsing/ocr-and-images.md): when the text is pixels.
106. [Shadow DOM, iframes and Web Components](../browser-automation/shadow-dom-and-iframes.md): crossing DOM boundaries.
107. [Puppeteer](../browser-automation/puppeteer.md): CDP-level browser control in Node.
108. [Selenium and WebDriver](../browser-automation/selenium.md): when the standard protocol is the requirement.
109. [How Headless Browsers Are Detected](../browser-automation/headless-detection-explained.md): the signals, and the responsible response.
110. [Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md): what JA3, JA4 and browser fingerprints are.
111. [WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md): how products classify bots, and verified-bot programs.
112. [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md): legitimate uses and consent problems.
113. [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md): real-time feeds.
114. [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md): stop polling when the source can push.
115. [Mobile App APIs](../apis/mobile-app-apis.md): why documented APIs come first.
116. [International Considerations](../legal-ethics/international-considerations.md): legal context beyond the US and EU.
117. [Go, Rust and Other Ecosystems](../tools/go-rust-and-others.md): other languages' scraping stacks.
118. [LLM-Assisted Extraction](../llm-scraping/llm-assisted-extraction.md): when a model beats selectors, and when it does not.
119. [Schema-Guided Extraction](../llm-scraping/schema-guided-extraction.md): structured outputs and field descriptions.
120. [Preparing HTML for LLMs](../llm-scraping/preparing-html-for-llms.md): cleaning, chunking and token budgets.
121. [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md): main-content extraction tools.
122. [Validating LLM Extractions](../llm-scraping/validating-llm-output.md): hallucination guards and sampling audits.
123. [Costs and Caching for LLM Scraping](../llm-scraping/llm-scraping-costs.md): token math, caching and model choice.
124. [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md): self-healing scrapers with review gates.
125. [Agentic Browsing](../llm-scraping/agentic-browsing.md): browser agents, reliability and safety.
126. [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md): AI user agents, robots.txt tokens and reservations.
127. [Social Media](../sources/social-media.md): API-first, platform terms and research access.
128. [Reviews and Forums](../sources/reviews-and-forums.md): forum patterns and personal-data cautions.
129. [Real Estate Listings](../sources/real-estate.md): listing data, MLS licensing and legal cautions.
130. [Maps and Local Business Data](../sources/maps-and-local-business.md): OpenStreetMap, Overpass and the Nominatim policy.

Practice: design (on paper first) a multi-site crawl with per-host queues and revisit priorities, or an LLM extraction step with a schema, grounding checks and a cost budget, and review it against the ethics checklist from step 5.

## Pitfalls

- **Jumping to stage 4** (browsers, fingerprints, LLMs) before stage 1 habits are automatic.
- **Skipping the ethics and legal entries** because they are not code.
- **Reading without practicing.** Each stage's project is where the lessons stick.
- **Treating the order as mandatory.** Use the decision framework to skip what your project does not need, and come back when it does.

## Checklist

- [ ] Stage 1 project: polite JSONL scraper with provenance
- [ ] Stage 2 project: validated, stored, multi-page scraper
- [ ] Stage 3 project: scheduled, monitored, archived, with an owner
- [ ] Stage 4 design reviewed against the ethics checklist
- [ ] Lessons from each project written down

## See Also

- [What Is Web Scraping](what-is-web-scraping.md)
- [Glossary](glossary.md)
- [Choosing an Acquisition Strategy](scraping-decision-framework.md)
- [Runbook: From Request to Scheduled Scraper](../harness/scraping-runbook.md)
- [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)
