# Data Scraping Knowledge Base

An Obsidian vault and LLM Wiki covering data scraping end to end: protocols, parsing,
crawling, APIs, browsers, anti-bot systems, law and ethics, data quality, storage, operations,
tools, LLM-based extraction, a catalog of public sources, and how this harness uses all of it.

## Start here

- [Learning Path: Zero to Production](wiki/fundamentals/learning-path.md): every article in a
  sensible reading order.
- [Index](wiki/index.md): one row per article, grouped by topic, with a summary.
- [Glossary](wiki/fundamentals/glossary.md): short definitions, each linked to its article.
- [Choosing an Acquisition Strategy](wiki/fundamentals/scraping-decision-framework.md): the
  first question for any new data source.
- [Ethical Scraping Checklist](wiki/legal-ethics/ethical-scraping-checklist.md): read it before
  you scrape anything new.
- [Runbook: From Request to Scheduled Scraper](wiki/harness/scraping-runbook.md): how a request
  becomes a monitored scraper in this harness.

## Topics

| Folder | Covers |
|---|---|
| [fundamentals](wiki/fundamentals/) | What scraping is, strategy, architecture, lifecycle, pitfalls |
| [http](wiki/http/) | Requests, headers, cookies, status codes, TLS, caching, authentication |
| [parsing](wiki/parsing/) | HTML, selectors, XPath, embedded JSON, tables, PDFs, OCR, text cleanup |
| [browser-automation](wiki/browser-automation/) | When a browser is needed, Playwright, Puppeteer, Selenium |
| [crawling](wiki/crawling/) | Frontiers, robots.txt, sitemaps, politeness, deduplication, archives |
| [apis](wiki/apis/) | Hidden and official APIs, GraphQL, streaming, rate limits, webhooks |
| [anti-bot](wiki/anti-bot/) | How detection works, identifying your bot, responding to blocks |
| [legal-ethics](wiki/legal-ethics/) | Case law, contracts, copyright, personal data, checklists |
| [data-quality](wiki/data-quality/) | Validation, cleaning, deduplication, change detection, testing |
| [storage](wiki/storage/) | File formats, SQLite and DuckDB, Postgres, raw archives, modeling |
| [operations](wiki/operations/) | Scheduling, queues, retries, monitoring, hosting, cost |
| [tools](wiki/tools/) | Python, Node, Scrapy, other ecosystems, CLI tools, services |
| [llm-scraping](wiki/llm-scraping/) | LLM extraction, generated scrapers, agentic browsing, AI crawlers |
| [sources](wiki/sources/) | Playbooks for common data sources |
| [harness](wiki/harness/) | How this harness's specs, agents and vault work |
| [lessons](wiki/lessons/) | Lessons the harness learned from its own runs |

## How this vault works

- `raw/` holds immutable source captures; `wiki/` holds compiled articles; `wiki/log.md`
  records every change. The rules are in [AGENTS.md](AGENTS.md).
- Links are relative Markdown links, so the vault reads the same in Obsidian, on GitHub and
  in the harness's search tool.
- Articles marked `Raw: none yet (seed article)` were written at bootstrap from expert
  knowledge with cited references but no captured source; facts that could not be checked
  then are listed in the bootstrap entry of [the log](wiki/log.md). Prefer a primary source
  when a decision depends on a detail.
- Nothing here is legal advice.

## Using it with Obsidian

Open this `knowledge` folder as a vault. The shared settings in `.obsidian/` use Markdown
links with relative paths; your workspace layout stays local (it is git-ignored).
