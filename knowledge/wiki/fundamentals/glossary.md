---
tags: [scraping, fundamentals, glossary, reference]
aliases: [Glossary, Scraping terms, Terminology, Definitions]
---

# Glossary

> Sources: RFC 9110, HTTP Semantics (https://www.rfc-editor.org/rfc/rfc9110); RFC 9111, HTTP Caching (https://www.rfc-editor.org/rfc/rfc9111); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); MDN Web Docs glossary (https://developer.mozilla.org/en-US/docs/Glossary); WHATWG HTML Standard (https://html.spec.whatwg.org/); W3C JSON-LD 1.1 (https://www.w3.org/TR/json-ld11/); schema.org (https://schema.org/); ISO 28500, WARC file format, as published by the IIPC (https://iipc.github.io/warc-specifications/); Directive (EU) 2019/790 on copyright in the Digital Single Market (https://eur-lex.europa.eu/eli/dir/2019/790/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Short definitions of the terms used across this vault, in alphabetical order. Each entry links to the article that explains the concept in depth, so the glossary doubles as an index for agents and readers who know the word but not where it lives. Definitions are deliberately brief and practical; where a term has a formal definition (an RFC, a W3C or WHATWG specification, a statute), the linked article cites it.

## A

- **Accept-Encoding**: request header listing the content codings (gzip, br, zstd) a client can decode. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).
- **Acquisition strategy**: the choice of source and method (official API, bulk data, feed, JSON endpoint, HTML, browser, license, or not at all). See [Choosing an Acquisition Strategy](scraping-decision-framework.md).
- **Agentic browsing**: an LLM-driven agent operating a browser step by step to complete a task. See [Agentic Browsing](../llm-scraping/agentic-browsing.md).
- **AI crawler**: a bot collecting content for AI training or AI search, identified by tokens such as GPTBot, ClaudeBot, CCBot or Google-Extended. See [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md).
- **ALPN** (Application-Layer Protocol Negotiation): TLS extension in which client and server agree on `h2` or `http/1.1` during the handshake. See [TLS and HTTPS for Scrapers](../http/tls-and-https.md).
- **Alt-Svc**: response header advertising an alternative endpoint or protocol, notably HTTP/3. See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).
- **API key**: a static secret identifying a client application, sent in a header or, less safely, in the query string. See [Authentication Patterns](../http/authentication-patterns.md).
- **ATS** (applicant tracking system): hosted hiring software such as Greenhouse or Lever, often with public job-board JSON. See [Job Postings](../sources/job-postings.md).
- **AutoThrottle**: Scrapy extension that adapts download delays to observed latency. See [Scrapy](../tools/scrapy.md).

## B

- **Backoff**: waiting progressively longer between retries, usually exponentially and with random jitter. See [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md).
- **Bearer token**: an access token sent as `Authorization: Bearer <token>`; whoever holds it can use it. See [Authentication Patterns](../http/authentication-patterns.md).
- **Block page**: a response (often 403, 429, 503, or a 200) that replaces content with a denial or challenge. See [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md).
- **Bloom filter**: a compact probabilistic set with no false negatives and a tunable false-positive rate, used for "already seen" URL checks. See [Deduplication (URLs and Content)](../crawling/deduplication.md).
- **Bot detection**: the layered techniques sites use to classify automated traffic (IP reputation, rates, headers, JavaScript challenges, behavior). See [How Bot Detection Works](../anti-bot/how-bot-detection-works.md).
- **Brotli** (`br`): a compression format (RFC 7932) widely used as an HTTP content coding. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).
- **Browser context**: an isolated browser profile within one browser process (own cookies and storage). See [Playwright](../browser-automation/playwright.md).
- **Browsewrap and clickwrap**: terms presented as a link (assent by use) versus terms accepted by an explicit click; clickwrap is generally easier to enforce. See [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md).

## C

- **CA bundle, trust store**: the set of root certificates a client trusts when verifying TLS. See [TLS and HTTPS for Scrapers](../http/tls-and-https.md).
- **Cache-Control**: header carrying caching directives such as `max-age`, `no-cache` and `no-store`. See [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).
- **Canary**: a small, known page or query checked on every run to detect breakage early. See [Testing Scrapers](../data-quality/testing-scrapers.md).
- **Canonical URL**: the URL a site declares as primary for duplicate content, via `<link rel="canonical">` or a `Link` header. See [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md).
- **CAPTCHA**: a challenge meant to tell humans from bots; for a scraper it is a signal to stop, not a puzzle to solve. See [CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md).
- **CDP** (Chrome DevTools Protocol): the protocol for instrumenting and controlling Chromium. See [Puppeteer](../browser-automation/puppeteer.md).
- **CDX**: the index format and query API of web archives, listing captures of a URL over time. See [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md).
- **CFAA**: the US Computer Fraud and Abuse Act, central to US scraping litigation. See [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md).
- **Change detection**: comparing successive captures (hashes or field diffs) to find what changed. See [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md).
- **Character encoding, charset**: the mapping from bytes to characters (UTF-8, windows-1252, Shift_JIS). See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).
- **CKAN, Socrata**: software behind many government open data portals, each with its own API. See [Government and Open Data Portals](../sources/government-open-data.md).
- **Client credentials grant**: the OAuth 2.0 flow in which an application obtains a token as itself, with no user. See [Authentication Patterns](../http/authentication-patterns.md).
- **Common Crawl**: a nonprofit publishing large open web crawls in WARC, WAT and WET formats. See [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md).
- **Conditional request**: a request with `If-None-Match` or `If-Modified-Since` that returns 304 when nothing changed. See [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).
- **Connection reuse, pooling**: keeping connections open across requests (keep-alive, HTTP/2 multiplexing) to avoid repeated handshakes. See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).
- **Content negotiation**: the server choosing a representation based on `Accept`, `Accept-Language` and `Accept-Encoding`. See [Request Headers That Matter](../http/http-headers-for-scrapers.md).
- **Cookie jar**: client-side storage that applies cookie domain, path, secure and expiry rules. See [Cookies, Sessions and State](../http/cookies-and-sessions.md).
- **Copy as cURL**: the DevTools action that turns a captured request into a curl command. See [curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md).
- **Crawl-delay**: a non-standard robots.txt directive asking for seconds between requests; not part of RFC 9309 and not honored by every crawler. See [robots.txt (RFC 9309)](../crawling/robots-txt.md).
- **Crawler, spider**: a program that discovers URLs by following links or sitemaps and fetches them. See [Crawler Architecture](../crawling/crawler-architecture.md).
- **CSR** (client-side rendering): pages assembled in the browser by JavaScript from data fetched after load. See [Static vs Dynamic Sites](static-vs-dynamic-sites.md).
- **CSRF token**: a per-session or per-form secret a site requires on state-changing requests. See [Cookies, Sessions and State](../http/cookies-and-sessions.md).
- **CSS selector**: a pattern such as `div.quote > span.text` that selects elements in a DOM. See [CSS Selectors for Extraction](../parsing/css-selectors.md).
- **Cursor pagination**: paging with an opaque token pointing at the next page, stable under inserts. See [Pagination Patterns](../crawling/pagination-patterns.md).

## D

- **Data minimization**: collecting only the personal data a purpose needs, a GDPR principle. See [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md).
- **Database right**: the EU sui generis right protecting substantial investment in a database, separate from copyright. See [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).
- **Decompression bomb**: a small compressed body that expands to an enormous size. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).
- **Deduplication**: removing repeated URLs or near-identical content, by normalization and hashing. See [Deduplication (URLs and Content)](../crawling/deduplication.md).
- **DevTools**: the browser's developer tools; the Network panel is the scraper's main reconnaissance instrument. See [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md).
- **DOM** (Document Object Model): the tree of nodes a parser or browser builds from HTML. See [HTML and the DOM](../parsing/html-and-the-dom.md).
- **DuckDB**: an embedded analytical database that queries CSV, JSON and Parquet directly. See [SQLite and DuckDB](../storage/sqlite-and-duckdb.md).

## E

- **EDGAR**: the SEC's filing system, with a published fair-access policy for automated clients. See [Financial Data and SEC EDGAR](../sources/financial-data-sec-edgar.md).
- **Embedded JSON, state blob**: data serialized into the page, such as `__NEXT_DATA__` or JSON in script tags. See [JSON and Embedded Data](../parsing/json-and-embedded-data.md).
- **Entity resolution**: deciding which records from different sources describe the same real-world thing. See [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md).
- **ETag**: an opaque validator a server attaches to a representation, used with `If-None-Match`. See [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).

## F

- **Fetch metadata, client hints**: browser-generated `Sec-Fetch-*` and `Sec-CH-UA-*` headers that a non-browser client should not forge. See [Request Headers That Matter](../http/http-headers-for-scrapers.md).
- **Fingerprinting**: identifying a client from characteristics of its TLS handshake, HTTP behavior or browser environment. See [Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md).
- **Fixture**: a saved response used to test a parser without contacting the site. See [Testing Scrapers](../data-quality/testing-scrapers.md).
- **Frontier**: the queue of URLs a crawler has discovered but not yet fetched. See [URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md).

## G

- **GDPR**: the EU General Data Protection Regulation, which applies to personal data even when it is publicly visible. See [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md).
- **GH Archive**: a public record of GitHub's event stream, published as hourly files. See [GitHub and Developer Data](../sources/github-and-developer-data.md).
- **GraphQL**: a query language and single-endpoint API style in which the client selects fields. See [GraphQL Endpoints](../apis/graphql.md).
- **Grounding check**: verifying that a value an LLM extracted actually appears in, or follows from, the source text. See [Validating LLM Extractions](../llm-scraping/validating-llm-output.md).

## H

- **HAR** (HTTP Archive): a JSON log of a browser's network activity, useful for discovery and replay. See [Network Interception and Response Capture](../browser-automation/network-interception.md).
- **Headless browser**: a real browser engine running without a visible window, driven by code. See [When You Need a Browser](../browser-automation/when-to-use-a-browser.md).
- **Headless detection**: signals sites use to tell automated browsers from human-operated ones. See [How Headless Browsers Are Detected](../browser-automation/headless-detection-explained.md).
- **Hidden API**: an undocumented JSON endpoint a site's own frontend calls. See [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md).
- **HTTP/2**: binary, multiplexed HTTP over one TCP connection (RFC 9113). See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).
- **HTTP/3**: HTTP over QUIC on UDP (RFC 9114). See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).
- **Hydration**: client-side scripts attaching behavior to server-rendered HTML, often from serialized state in the page. See [Static vs Dynamic Sites](static-vs-dynamic-sites.md).

## I

- **Idempotent**: producing the same effect whether performed once or several times; GET, HEAD, PUT and DELETE are idempotent methods. See [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md).
- **Incremental crawling**: revisiting only what probably changed, using conditional requests, `lastmod` and change rates. See [Incremental Crawling](../crawling/incremental-crawling.md).
- **Infinite scroll**: a page that loads more items as you scroll, usually from a paginated API. See [Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md).

## J

- **JA3, JA4**: hashes that summarize a client's TLS handshake (JA4 is a broader family of fingerprints). See [Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md).
- **Jitter**: random variation added to delays and schedules so clients do not act in lockstep. See [Scheduling and Cron](../operations/scheduling-and-cron.md).
- **jq**: a command-line JSON processor. See [Command-Line Tools](../tools/cli-tools.md).
- **JSONL**: one JSON object per line, a robust format for appending records. See [File Formats for Scraped Data](../storage/file-formats.md).
- **JSON-LD**: JSON for Linked Data, embedded in `<script type="application/ld+json">`, usually with schema.org types. See [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).

## K

- **Keep-alive**: reusing an HTTP/1.1 connection for sequential requests. See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).
- **Keyset pagination**: paging by the last seen key (`WHERE id > ? ORDER BY id`), efficient and stable. See [Pagination Patterns](../crawling/pagination-patterns.md).

## L

- **Last-Modified**: a date validator used with `If-Modified-Since`. See [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).
- **Lazy loading**: deferring images or sections until they are needed, often until scrolled into view. See [Infinite Scroll and Lazy Loading](../browser-automation/infinite-scroll-and-lazy-loading.md).
- **Lesson**: a short note the harness writes after a run so later runs avoid the same mistake. See [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md).
- **Lineage**: the record of how a value was derived, from fetch through every transform. See [Provenance and Lineage](../data-quality/provenance-and-lineage.md).
- **llms.txt**: a proposed convention for a Markdown file summarizing a site for language models. See [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md).
- **Locator**: Playwright's auto-waiting handle for finding elements. See [Playwright](../browser-automation/playwright.md).

## M

- **Main content extraction**: separating an article's body from navigation and boilerplate. See [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md).
- **Meta refresh**: `<meta http-equiv="refresh">`, a redirect or reload triggered by the HTML rather than HTTP. See [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md).
- **MFA** (multi-factor authentication): a second proof of identity; scrapers must not automate around it. See [Authentication Patterns](../http/authentication-patterns.md).
- **Microdata, OpenGraph**: other ways pages embed structured metadata (`itemprop` attributes, `og:` meta tags). See [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).
- **MinHash, SimHash**: techniques for detecting near-duplicate documents without comparing every pair in full. See [Deduplication (URLs and Content)](../crawling/deduplication.md).
- **MLS** (multiple listing service): licensed real estate listing databases. See [Real Estate Listings](../sources/real-estate.md).
- **Mobile app API**: the backend an app talks to; undocumented and usually covered by strict terms. See [Mobile App APIs](../apis/mobile-app-apis.md).
- **Mojibake**: garbled text from decoding bytes with the wrong charset, such as `cafÃ©`. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).

## N

- **Network idle**: a browser wait condition that fires when no requests are in flight; unreliable on busy pages. See [Waiting Strategies](../browser-automation/waiting-strategies.md).
- **`__NEXT_DATA__`**: the JSON blob Next.js pages-router sites embed with page props. See [Static vs Dynamic Sites](static-vs-dynamic-sites.md).
- **No-code scraper**: a point-and-click extraction tool. See [No-Code and Low-Code Scrapers](../tools/no-code-scrapers.md).
- **Nominatim, Overpass**: OpenStreetMap's geocoder (with a strict usage policy) and its query API. See [Maps and Local Business Data](../sources/maps-and-local-business.md).
- **Normalization (Unicode)**: converting text to a canonical form such as NFC or NFKC so equal strings compare equal. See [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md).

## O

- **OAuth 2.0**: the delegated authorization framework (RFC 6749) behind most modern API tokens. See [Authentication Patterns](../http/authentication-patterns.md).
- **Observability**: the logs, metrics and traces that let you explain what a scraper did. See [Logging and Observability](../operations/logging-and-observability.md).
- **OCR**: optical character recognition, turning images of text into text. See [OCR and Image-Based Data](../parsing/ocr-and-images.md).
- **Official API**: an interface a provider documents and supports for programmatic access. See [Consuming REST APIs Well](../apis/rest-api-consumption.md).
- **OpenAlex**: an open catalog of scholarly works, authors and institutions with a free API. See [Academic and Research Data](../sources/academic-and-research-data.md).

## P

- **Pagination**: splitting a result set across pages, by page number, offset, cursor or key. See [Pagination Patterns](../crawling/pagination-patterns.md).
- **Parquet**: a columnar file format, compact and fast for analysis. See [File Formats for Scraped Data](../storage/file-formats.md).
- **Paywall**: an access control on content; respect it rather than bypassing it. See [News Sites and RSS](../sources/news-and-rss.md).
- **PDF extraction**: getting text and tables out of PDF layouts. See [PDF Data Extraction](../parsing/pdf-extraction.md).
- **Persisted query**: a GraphQL query stored on the server and referenced by an ID or hash. See [GraphQL Endpoints](../apis/graphql.md).
- **PKCE** (Proof Key for Code Exchange): an extension (RFC 7636) that protects the OAuth authorization code flow. See [Authentication Patterns](../http/authentication-patterns.md).
- **Politeness**: limiting a crawler's load on each host through concurrency caps, delays and backoff. See [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md).
- **Provenance**: where and when a record came from: source URL, fetch time, raw reference, parser version. See [Provenance and Lineage](../data-quality/provenance-and-lineage.md).
- **Proxy**: an intermediary that forwards requests; datacenter, residential and mobile proxies differ sharply in ethics and consent. See [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md).

## Q

- **Quarantine**: where records that fail validation are kept for inspection instead of being stored or dropped. See [Schema Validation](../data-quality/schema-validation.md).
- **Queue, worker**: a task list and the processes consuming it, with backpressure to protect downstream systems. See [Queues and Workers](../operations/queues-and-workers.md).
- **QUIC**: the encrypted, UDP-based transport (RFC 9000) under HTTP/3. See [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md).

## R

- **Rate limit, quota**: the maximum requests a client may make per period, often signaled with 429. See [API Rate Limits and Quotas](../apis/api-rate-limits.md).
- **Raw archive**: the stored original responses, kept so data can be re-parsed later. See [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md).
- **Redirect chain**: the sequence of 3xx hops from a requested URL to its final URL. See [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md).
- **Regular expression**: a text pattern language, fine for cleanup and IDs, wrong for parsing HTML structure. See [Regular Expressions: When and When Not](../parsing/regex-in-scraping.md).
- **Retry-After**: a header with delay-seconds or an HTTP-date telling a client when to try again. See [HTTP Status Codes and How to React](../http/http-status-codes.md).
- **Reverse DNS verification**: confirming a crawler's identity by resolving its IP to a host name and back. See [Identifying Your Bot](../anti-bot/identifying-your-bot.md).
- **robots.txt**: the file at a site's root that tells crawlers which paths they may fetch (RFC 9309). See [robots.txt (RFC 9309)](../crawling/robots-txt.md).
- **RSS, Atom**: XML feed formats listing recent items of a site. See [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md).
- **Runbook**: a step-by-step operating procedure; in this harness, the path from request to scheduled scraper. See [Runbook: From Request to Scheduled Scraper](../harness/scraping-runbook.md).

## S

- **SCD** (slowly changing dimension): modeling attributes that change over time, for example a new row with a validity range per change. See [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md).
- **Schema validation**: checking each record's types, required fields and constraints at the pipeline boundary. See [Schema Validation](../data-quality/schema-validation.md).
- **Schema-guided extraction**: asking an LLM to fill a declared JSON schema, ideally with structured outputs. See [Schema-Guided Extraction](../llm-scraping/schema-guided-extraction.md).
- **schema.org**: the shared vocabulary (Product, Offer, JobPosting, Article) used by structured data. See [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).
- **Scraper spec**: the declarative description of a scraper used by this harness. See [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md).
- **Self-healing scraper**: a scraper whose selectors are regenerated, ideally with review, when the page changes. See [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md).
- **Semaphore**: a concurrency primitive capping how many tasks run at once. See [Concurrency and Async IO](../operations/concurrency-and-async.md).
- **Session**: server-side state tied to a cookie, such as a login. See [Cookies, Sessions and State](../http/cookies-and-sessions.md).
- **Shadow DOM**: an encapsulated DOM subtree inside a web component. See [Shadow DOM, iframes and Web Components](../browser-automation/shadow-dom-and-iframes.md).
- **Sitemap**: an XML list of a site's URLs with optional `lastmod` dates, often referenced from robots.txt. See [XML Sitemaps](../crawling/sitemaps.md).
- **SNI** (Server Name Indication): the TLS extension carrying the requested host name. See [TLS and HTTPS for Scrapers](../http/tls-and-https.md).
- **Soft 404**: a "not found" page served with a 200 status. See [HTTP Status Codes and How to React](../http/http-status-codes.md).
- **SPARQL**: the query language for RDF data, used by Wikidata's query service. See [Wikipedia and Wikidata](../sources/wikipedia-and-wikidata.md).
- **Spider trap**: URL spaces that never end, such as calendars, session IDs and parameter combinations. See [Spider Traps and Crawl Hygiene](../crawling/spider-traps.md).
- **SSE** (Server-Sent Events): a one-way stream of events over HTTP (`text/event-stream`). See [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md).
- **SSR** (server-side rendering): HTML rendered on the server per request. See [Static vs Dynamic Sites](static-vs-dynamic-sites.md).
- **Static site**: pages whose HTML already contains the content, rendered at build or request time. See [Static vs Dynamic Sites](static-vs-dynamic-sites.md).

## T

- **TDM exception, TDM reservation**: EU rules permitting text and data mining, and the machine-readable opt-out rightholders can use against it. See [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).
- **Terms of service**: the contract a site offers its users, which may restrict automated access. See [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md).
- **TLS**: the protocol that authenticates the server and encrypts HTTPS traffic. See [TLS and HTTPS for Scrapers](../http/tls-and-https.md).
- **Token bucket**: a rate-limiting algorithm that allows short bursts while enforcing an average rate. See [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md).
- **Token budget**: the number of LLM input and output tokens a task may spend. See [Costs and Caching for LLM Scraping](../llm-scraping/llm-scraping-costs.md).
- **Too Many Requests (429)**: the status code for rate limiting, often with `Retry-After`. See [HTTP Status Codes and How to React](../http/http-status-codes.md).

## U

- **Upsert**: insert-or-update on a key, the basis of idempotent storage. See [PostgreSQL for Scraped Data](../storage/postgres-for-scraped-data.md).
- **URL normalization**: rewriting equivalent URLs into one form (case, ports, parameter order, tracking parameters). See [URL Normalization and Canonicalization](../crawling/url-normalization.md).
- **User-Agent**: the request header naming the client software; a scraper's should include a contact. See [Identifying Your Bot](../anti-bot/identifying-your-bot.md).

## V

- **Vary**: a response header listing request headers that affect the response, and therefore cache keys. See [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md).
- **Verified bot**: a crawler a site or CDN has confirmed (by reverse DNS, published IPs or registration) and may treat differently. See [WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md).

## W

- **WAF** (web application firewall): a filter in front of a site that blocks malicious or unwanted requests. See [WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md).
- **WARC**: the standard web archive container format (ISO 28500) for requests, responses and metadata. See [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md).
- **WebDriver, WebDriver BiDi**: the W3C browser automation protocols used by Selenium. See [Selenium and WebDriver](../browser-automation/selenium.md).
- **Webhook**: an HTTP callback a provider sends when something changes, replacing polling. See [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md).
- **WebSocket**: a full-duplex connection upgraded from HTTP, common for live data. See [WebSockets and Server-Sent Events](../apis/websockets-and-sse.md).
- **WebSub**: a W3C protocol for push notifications when a feed changes. See [Webhooks and Push-Based Acquisition](../apis/webhooks-and-push.md).

## X

- **XHR, fetch request**: requests made by page JavaScript, visible in the Network panel and often returning JSON. See [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md).
- **XPath**: a W3C language for selecting nodes by path, axis and predicate. See [XPath for Extraction](../parsing/xpath.md).

## Z

- **zstd** (Zstandard): a fast compression format (RFC 8878) increasingly used as an HTTP content coding. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).

## Pitfalls

- **Same word, different meanings.** "Session" can mean a server-side login session, a client object (`requests.Session`) or a browser session; "canonical" can mean a declared URL or your own normalized form. Check which one an article means.
- **"API" is not one thing.** An official API comes with documentation and terms; a hidden API is an implementation detail of a website.
- **Definitions summarize.** Before relying on a precise rule (an RFC requirement, a legal threshold), read the linked article and its sources.

## See Also

- [Learning Path: Zero to Production](learning-path.md)
- [What Is Web Scraping](what-is-web-scraping.md)
- [HTTP Fundamentals](../http/http-fundamentals.md)
- [Choosing an Acquisition Strategy](scraping-decision-framework.md)
- [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)
