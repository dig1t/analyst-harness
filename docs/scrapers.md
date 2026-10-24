# Scrapers

Scrapers are YAML specs in `config/scrapers/` (in the container: `/app/data/scrapers`). The
scheduler registers a `scrape:<name>` job for every enabled spec with a schedule. Specs are
validated strictly: unknown keys are errors.

## A complete example

```yaml
name: hn-top-stories # lowercase letters, digits and hyphens
description: Hacker News top stories (official API)
enabled: true
schedule: '7 * * * *' # cron, evaluated in `timezone` (default UTC)
source:
  type: json
  url: https://hacker-news.firebaseio.com/v0/topstories.json
  items: '' # dot path to the array; empty means the root
  expand: # fetch each item from a URL template
    url: https://hacker-news.firebaseio.com/v0/item/{item}.json
    limit: 30
fields:
  id: { path: id, type: integer, required: true }
  title: { path: title, type: string, required: true, transform: [collapseWhitespace] }
  url: { path: url, type: url }
  comments: { path: descendants, type: integer, default: 0 }
  time: { path: time, type: date }
key: id # identifies a record across runs (default: content hash)
output: { dataset: hn-top-stories, mode: changed }
validation: { minItems: 10, maxInvalidRatio: 0.2 }
fetch: { minIntervalMs: 250, retries: 3, respectRobots: true }
notify: { onNew: false, onFailure: true, alertAfterFailures: 2 }
```

## Sources

| `type`    | Keys                                                                | Notes                                                                                                       |
| --------- | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `json`    | `url`, `items`, `entries`, `expand { url, limit }`, `limit`         | `entries: true` turns an object map into `{key, value}` records; `{item}` or `{item.field}` in `expand.url` |
| `html`    | `url`, `itemSelector`, `next { selector, attr, maxPages }`, `limit` | CSS selectors via cheerio; `next` follows pagination links                                                  |
| `rss`     | `url`, `limit`                                                      | RSS 2.0 and Atom                                                                                            |
| `sitemap` | `url`, `include` (regex), `followIndex`, `limit`                    | Follows sitemap indexes                                                                                     |

## Fields

Each field rule takes `path` (JSON dot path such as `a.b.0.c`, or the feed item key) or
`selector` (HTML, relative to the item; an empty string is the item itself) with `attr` and
`all`, plus:

| Key         | Values                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------- |
| `type`      | `string`, `number`, `integer`, `boolean`, `url`, `date`, `json`                              |
| `required`  | Records missing a required field are invalid                                                 |
| `transform` | `trim`, `collapseWhitespace`, `lowercase`, `uppercase`, `number`, `absoluteUrl`, `stripTags` |
| `regex`     | Keeps the first capture group                                                                |
| `default`   | Used when the value is missing                                                               |

## Output and change detection

Records go to `data/datasets/<dataset>/<YYYY-MM-DD>.jsonl`, each with `_key`, `_hash`,
`_change` (`new`, `changed` or `same`), `_scraper` and `_scraped_at`. `mode` decides what is written: `new` (keys never seen), `changed` (new keys and
records whose content hash changed) or `all`. The state file
`data/state/scrapers/<name>.json` keeps seen keys and hashes, HTTP validators for conditional
requests, the failure streak and recent history.

## Validation and alerts

A run is marked failed when it extracts fewer than `validation.minItems` valid records, when
the share of invalid records exceeds `validation.maxInvalidRatio`, or on an error. Records
that passed validation are still written, and invalid samples appear in the report. With
`notify.onFailure`, the alert channel hears about it once the streak reaches
`alertAfterFailures` and again every 10 failures. `notify.onNew` posts a summary when a run
finds new or changed records. A daily digest summarizes all scrapers.

## Politeness

`fetch.respectRobots` (default true) applies robots.txt per RFC 9309, cached for 24 hours.
`minIntervalMs` spaces requests per host; `retries` retries network errors, 429 and 5xx with
exponential backoff and `Retry-After`; `conditional` sends `If-None-Match` and
`If-Modified-Since` when the last response had validators. Every request and redirect passes
the SSRF guard. The User-Agent comes from `scrapers.userAgent` in `config/harness.yaml`:
name the project and give a contact URL.

## Working with specs

```bash
npm run cli -- scrapers                         # list
npm run cli -- scrape books-toscrape --dry-run  # run without writing
npm run cli -- scrape --all --notify            # run every enabled spec and send alerts
```

Agents test specs with `run_scraper` (`spec_path` points at a draft in the workspace, always a
dry run). The `build-scraper`, `repair-scraper` and `responsible-scraping` skills describe the
workflow, and the vault's `wiki/harness/` articles document it for humans. When a page needs a
real browser, logins or anything the spec cannot express, write a custom scraper in TypeScript
(`CustomScraper` in `src/scrapers/runner.ts`) and register it in the runtime.
