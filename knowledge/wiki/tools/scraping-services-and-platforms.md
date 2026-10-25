---
tags: [scraping, tools, services, platforms, build-vs-buy]
aliases: [scraping APIs, scraping platforms, web scraping services, Apify, Zyte, Firecrawl, Jina Reader, build vs buy]
---

# Scraping Services and Platforms

> Sources: Apify documentation (https://docs.apify.com/); Apify SDK for JavaScript (https://github.com/apify/apify-sdk-js); Zyte documentation (https://docs.zyte.com/); scrapy-zyte-api (https://github.com/scrapy-plugins/scrapy-zyte-api); Firecrawl repository (https://github.com/firecrawl/firecrawl) and documentation (https://docs.firecrawl.dev/); Jina Reader repository (https://github.com/jina-ai/reader); Crawl4AI repository (https://github.com/unclecode/crawl4ai); ScrapeGraphAI repository (https://github.com/ScrapeGraphAI/Scrapegraph-ai); Browserless repository (https://github.com/browserless/browserless); Stagehand by Browserbase (https://github.com/browserbase/stagehand); Cloudflare Browser Run pricing (https://developers.cloudflare.com/browser-run/pricing/); Common Crawl (https://commoncrawl.org/); package metadata on PyPI for vendor SDKs (https://pypi.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Instead of running everything yourself, you can rent pieces of the pipeline: a platform to host and schedule scrapers, an API that fetches (and optionally renders) a URL for you, a service that turns pages into LLM-ready markdown or JSON, hosted browsers, search APIs, or ready-made datasets. Buying saves engineering time on infrastructure and browsers; it costs money per request, adds a dependency, and moves some control (and visibility into raw responses) to a vendor. It never transfers your legal and ethical responsibility: you remain responsible for respecting site terms, robots.txt, copyright and personal-data law (see [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md)). Many vendors in this market also advertise "unblocking" or anti-bot bypass features; this vault does not recommend using them to get around a site's access controls (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

Descriptions below are based on each project's own repository, documentation or SDK package metadata as of 2026-10. Product lines change quickly; check current terms and pricing before committing.

## Categories

| Category | What you get | Examples |
|---|---|---|
| Scraping platforms | Run your code in their cloud with scheduling, storage, logs and a marketplace of ready-made scrapers | Apify, Zyte Scrapy Cloud |
| Fetch and scraping APIs | Send a URL, receive HTML, a rendered page, screenshots or extracted fields; billed per request or per successful result | Zyte API, ScrapingBee, ScraperAPI, Bright Data, Oxylabs |
| LLM-oriented web-to-text APIs | Markdown, cleaned text or schema-guided JSON for RAG and agents; crawl and map endpoints | Firecrawl, Jina Reader, Crawl4AI (hosted option), ScrapeGraphAI, Spider |
| Hosted browsers | Remote Chrome over CDP or Playwright, with session management | Browserless, Browserbase, Cloudflare Browser Run |
| Search APIs for agents | Web search results plus page content for LLM pipelines | Exa, Tavily, the search endpoints of Firecrawl and Jina |
| Datasets and archives | Pre-collected data, open corpora, licensed feeds | Common Crawl, vendor datasets, licensed data providers |

## Notable products

- **Apify.** A cloud platform for "Actors" (serverless scraping and automation programs), with an Actor store, storage for datasets, key-value stores and request queues, scheduling, and proxy services. Apify maintains the open-source Crawlee library (see [Node.js Scraping Stack](node-scraping-stack.md)) and official SDKs (`apify` for JavaScript, `apify-client` for Python).
- **Zyte** (formerly Scrapinghub). Offers Zyte API (an HTTP API that fetches pages, with browser rendering and automatic extraction options) and Scrapy Cloud for hosting Scrapy spiders; the company maintains Scrapy and related libraries such as `scrapy-zyte-api` and Spidermon (see [Scrapy](scrapy.md)).
- **Firecrawl.** Describes itself as "the context API for AI agents": search, scrape, crawl, map and extraction endpoints that return markdown, HTML or schema-guided JSON. The core is open source under AGPL-3.0 and can be self-hosted; a hosted service is the main product. Python SDK example (firecrawl-py 4.x):

```python
from firecrawl import Firecrawl

fc = Firecrawl(api_key="fc-...")  # read the key from the environment in real code
doc = fc.scrape("https://books.toscrape.com/", formats=["markdown"], only_main_content=True)
print(doc.metadata, doc.markdown[:500])
```

- **Jina Reader.** Prefix a URL with `https://r.jina.ai/` to get LLM-friendly text (`curl https://r.jina.ai/https://example.com/`), and use `https://s.jina.ai/<query>` for search. The source is on GitHub under Apache-2.0.
- **Crawl4AI.** An open-source (Apache-2.0) crawler that turns sites into clean markdown or JSON for LLM pipelines, run yourself or, more recently, through a hosted API.
- **ScrapeGraphAI.** An MIT-licensed library that builds LLM-driven scraping pipelines, with a commercial hosted API.
- **Browserless** (self-hostable Docker image; dual-licensed under SSPL or a commercial license) and **Browserbase** (hosted headless browsers; maintains the MIT-licensed Stagehand framework for AI-driven browser automation).
- **Cloudflare Browser Run** (formerly Browser Rendering): browsers on Cloudflare's network, billed by browser hours (see [Cheap Hosting for Scrapers](../operations/cheap-hosting.md) for current limits).
- **Bright Data, Oxylabs, ScrapingBee, ScraperAPI.** Commercial scraping APIs and proxy networks with official SDKs (for example `brightdata-sdk`, `oxylabs`, `scrapingbee` and `scraperapi-sdk` on PyPI); several also sell datasets. Proxy questions are covered in [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md).
- **Exa and Tavily.** Search APIs aimed at LLM applications, with official Python SDKs (`exa-py`, `tavily-python`).
- **Common Crawl.** A free, open corpus of web crawl data in WARC format; often the cheapest "service" for broad historical coverage (see [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)).

## Build or buy

| Factor | Build favors | Buy favors |
|---|---|---|
| Volume and sources | A few sources at steady volume | Many heterogeneous sources, bursty volume |
| Rendering needs | Mostly static HTML or JSON APIs | Heavy JavaScript everywhere |
| Team | Engineers who can operate crawlers | Analysts who need data, not infrastructure |
| Cost | High volume of simple pages (cheap to self-serve) | Low volume, high complexity per page |
| Control and debugging | Need raw responses, exact headers, custom politeness | Fine with extracted output |
| Compliance | Data must stay in your infrastructure | Vendor offers the needed contract terms and data location |
| Time to first data | Weeks are acceptable | Needed today |

A frequent good answer is hybrid: an official API or dataset where one exists (see [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)), self-built HTTP scrapers for stable sources, and a service only for the hard long tail, behind your own interface so it can be swapped.

## Evaluating a vendor

- **Raw access.** Can you get status codes, headers and raw HTML, not only extracted text? Without them, debugging and provenance suffer (see [Provenance and Lineage](../data-quality/provenance-and-lineage.md)).
- **Politeness controls.** Does the service honor robots.txt, let you set rate limits, and let you identify your bot? Is it clear whose identity the target site sees?
- **Network origin.** Where do requests come from (datacenter, residential, mobile)? If residential, how is consent from the device owners obtained?
- **Pricing unit.** Per request, per successful request, per GB, credits or compute units, and what counts as a success; whether JavaScript rendering or retries multiply the cost (see [Cost Control](../operations/cost-control.md)).
- **Data handling.** Retention of fetched pages and outputs, data processing terms, region, and subprocessors; never send credentials or personal data you are not allowed to share.
- **Acceptable-use terms.** What the vendor forbids, and whether it can suspend you mid-project.
- **Exit plan.** Export formats, an open-source or self-host fallback (Firecrawl, Crawl4AI and Browserless can be self-hosted), and your own record format so a switch does not break downstream code.
- **Quality monitoring.** Vendor extraction can silently degrade; keep validation and sampling audits on your side (see [Validating LLM Extractions](../llm-scraping/validating-llm-output.md)).

## Pitfalls

- Treating a vendor's "compliant" marketing as legal clearance for your use case.
- Paying per request for pages a plain HTTP client could fetch, or for data an official API provides free.
- Locking downstream code to one vendor's output schema; normalize into your own records.
- Credit burn from defaults such as JavaScript rendering on every request or automatic retries.
- Sending session cookies, logins or personal data through a third party without a legal basis or contract.
- No raw archive, so a vendor outage or extraction bug cannot be backfilled.

## Checklist

- [ ] Official API, dataset or bulk export ruled out first
- [ ] Vendor terms, data handling and network origin reviewed
- [ ] Politeness and identification options understood
- [ ] Cost per 1,000 successful records estimated, including retries and rendering
- [ ] Raw responses or at least status and URL logged for provenance
- [ ] Output normalized into your own schema and validated
- [ ] Exit plan or self-hosted fallback documented

## See Also

- [No-Code and Low-Code Scrapers](no-code-scrapers.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
- [Cost Control](../operations/cost-control.md)
- [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md)
- [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md)
- [Costs and Caching for LLM Scraping](../llm-scraping/llm-scraping-costs.md)
