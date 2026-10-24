---
tags: [scraping, harness, scraper-spec, yaml]
aliases: [scraper spec, harness spec, declarative scraper, scraper YAML]
---

# Declarative Scraper Specs in This Harness

> Sources: analyst-harness source code: src/scrapers/spec.ts, src/scrapers/runner.ts, src/scrapers/http-client.ts, src/scrapers/robots.ts (https://github.com/firebit-dev/analyst-harness); repository documentation docs/scrapers.md
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

The harness runs scrapers from YAML specs instead of code. A spec names a source (a JSON API, an HTML page with pagination, an RSS or Atom feed, or a sitemap), maps fields out of each item, says which field identifies a record, and sets validation thresholds, output mode, politeness and alert rules. The scheduler runs every enabled spec on its cron schedule; the runner fetches politely, extracts, validates, detects new and changed records and appends them to a JSONL dataset. Specs are validated strictly, so a typo is an error at load time rather than a silent no-op. Code is only needed when a site cannot be described this way (see the section "When a spec is not enough" below).

## Anatomy of a spec

```yaml
name: hn-top-stories                 # lowercase letters, digits, hyphens; also the job name
description: Hacker News top stories (official API)
enabled: true
schedule: '7 * * * *'                # cron; timezone defaults to UTC
source:
  type: json
  url: https://hacker-news.firebaseio.com/v0/topstories.json
  items: ''                          # dot path to the item array; empty = root
  expand:                            # one extra request per item
    url: https://hacker-news.firebaseio.com/v0/item/{item}.json
    limit: 30
fields:
  id: { path: id, type: integer, required: true }
  title: { path: title, type: string, required: true, transform: [collapseWhitespace] }
  url: { path: url, type: url }
  comments: { path: descendants, type: integer, default: 0 }
key: id                              # same key across runs = same record
output: { dataset: hn-top-stories, mode: changed }
validation: { minItems: 10, maxInvalidRatio: 0.2 }
fetch: { minIntervalMs: 250, retries: 3, respectRobots: true }
notify: { onNew: false, onFailure: true, alertAfterFailures: 2 }
```

The spec reads top to bottom like the pipeline in [Anatomy of a Scraper](../fundamentals/anatomy-of-a-scraper.md): where to fetch, what to extract, how to recognize a record, what counts as a healthy run, and who to tell.

## Source types

| Type | Use it for | Key options |
|---|---|---|
| `json` | Official and hidden JSON APIs | `items` (dot path), `entries` (object map to records), `expand` (per-item URL template with `{item}` or `{item.field}`), `limit` |
| `html` | Server-rendered pages | `itemSelector` (one element per record), `next` (selector, attribute and `maxPages` for pagination), `limit` |
| `rss` | RSS 2.0 and Atom feeds | `limit` |
| `sitemap` | Discovering URLs from XML sitemaps | `include` (regex filter), `followIndex`, `limit` |

Pick the highest option on the ladder in [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md): an official API or feed beats HTML, which beats a browser.

## Field rules

Each field reads either a `path` (JSON dot path such as `data.items.0.price`, or the feed item key) or a `selector` (CSS, relative to the item element; an empty string is the item itself) with an optional `attr` and `all: true` for lists. Then:

- `type`: `string`, `number`, `integer`, `boolean`, `url`, `date` or `json`. Values are coerced; a value that cannot be coerced makes the record invalid when the field is `required`.
- `transform`: `trim`, `collapseWhitespace`, `lowercase`, `uppercase`, `number`, `absoluteUrl`, `stripTags`, applied in order.
- `regex`: keeps the first capture group, for example `"star-rating (\\w+)"`.
- `default`: used when the value is missing.

Selector advice from [Writing Robust Selectors](../parsing/robust-selectors.md) applies: anchor on stable attributes, not on positions.

## What a run does

1. **robots.txt.** With `respectRobots: true` (the default), the runner checks the URL against the host's robots.txt under the rules in [robots.txt (RFC 9309)](../crawling/robots-txt.md), cached for 24 hours. A disallowed URL fails the run with a clear reason.
2. **Polite fetch.** Requests to one host are spaced by `minIntervalMs`. Network errors, 429 and 5xx are retried `retries` times with exponential backoff that honors `Retry-After`. Every request and redirect hop passes the harness SSRF guard. The User-Agent comes from the harness config and should name the project and a contact URL.
3. **Conditional request.** With `conditional: true`, the runner sends `If-None-Match` and `If-Modified-Since` from the last response. A 304 ends the run early as "not modified", which costs the site almost nothing ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)).
4. **Extract and validate.** Fields are extracted and coerced; invalid records are counted and sampled for the report.
5. **Change detection.** Each valid record gets a key (the `key` field, or a content hash) and a content hash. Compared with the stored state, it is `new`, `changed` or `same`.
6. **Write.** `output.mode` decides what is appended to `data/datasets/<dataset>/<YYYY-MM-DD>.jsonl`: `new`, `changed` (new and changed, the default) or `all`. Each line carries `_key`, `_hash`, `_change`, `_scraper` and `_scraped_at`.
7. **Judge the run.** Fewer than `validation.minItems` valid records, or more than `maxInvalidRatio` invalid ones, marks the run failed (valid records are still written). A drop to zero after a healthy run is reported as a likely layout change.
8. **Report.** The failure streak and history are saved in `data/state/scrapers/<name>.json`. Alerts follow `notify`: the first alert at `alertAfterFailures`, then every 10 failures; `onNew` posts a summary of new records.

## Testing a spec

```bash
npm run cli -- scrape books-toscrape --dry-run     # fetch, extract, validate; write nothing
npm run cli -- scrapers                            # list specs and schedules
```

In Discord, `/scrape run name dry_run:true` does the same. Agents test drafts with the `run_scraper` tool and `spec_path` pointing at a YAML file in their workspace; that is always a dry run, so an agent can iterate without touching datasets or state.

## When a spec is not enough

Sites that need a real browser, a login, multi-step forms or per-record logic beyond field rules get a TypeScript `CustomScraper` (see `src/scrapers/runner.ts`): it supplies its own fetch function and reuses the same validation, change detection, datasets and alerts. Before writing one, read [When You Need a Browser](../browser-automation/when-to-use-a-browser.md); often a hidden JSON endpoint makes the browser unnecessary ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).

## Pitfalls

- **Keyless specs on volatile pages.** Without `key`, the content hash is the key, so any edit to a record looks like a new record. Set `key` to a stable id or URL.
- **`minItems: 1` on a list that normally has 50 items.** A broken selector that still matches one element passes. Set `minItems` near the normal count.
- **`mode: all` on a frequent schedule.** It rewrites the whole list every run and inflates datasets. Use `changed` unless you need snapshots.
- **Aggressive schedules.** Every 5 minutes is rarely justified; match the schedule to how often the source changes ([Incremental Crawling](../crawling/incremental-crawling.md)).
- **Turning off `respectRobots` to make a run pass.** That is a policy decision for a human, not a fix.

## Checklist

- [ ] The source is the highest rung available (API, feed, sitemap, then HTML).
- [ ] `key` is a stable identifier.
- [ ] `validation.minItems` reflects a normal run; `maxInvalidRatio` is tight.
- [ ] The schedule matches the source's update rate, with a jittered minute.
- [ ] A dry run returns the expected records and sample.
- [ ] `notify.onFailure` is on, and someone reads the alerts channel.

## See Also

- [Runbook: From Request to Scheduled Scraper](scraping-runbook.md)
- [How the Agents Use and Grow This Vault](harness-knowledge-workflow.md)
- [Anatomy of a Scraper](../fundamentals/anatomy-of-a-scraper.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Schema Validation](../data-quality/schema-validation.md)
- [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)
