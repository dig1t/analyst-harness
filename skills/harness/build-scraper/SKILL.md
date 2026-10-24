---
name: build-scraper
description: Build a new scheduled scraper for this harness as a declarative YAML spec, test it with a dry run and hand it over for approval. Use when asked to collect data from a website, API, feed or sitemap on a schedule.
---

# Build a scraper

## Steps

1. **Choose the route.** Run `search_knowledge("acquisition strategy decision")` and read the
   decision framework. Prefer, in order: an official API, a bulk download or open-data portal, an
   RSS/Atom feed, a sitemap, server-rendered HTML. A headless browser is out of scope for specs.
2. **Check permission.** Fetch `<origin>/robots.txt` with `web_fetch` and read the terms of use.
   Stop and report if automated access is forbidden, the data sits behind a login, or it is
   personal data you do not need (see `knowledge/wiki/legal-ethics/ethical-scraping-checklist.md`).
3. **Inspect the source.** `web_fetch` the URL. For JSON, find the array of items and the fields.
   For HTML, pick one repeating item element and stable selectors (ids, data attributes,
   semantic tags) instead of positional ones (`nth-child`).
4. **Write the spec** to `proposals/scrapers/<name>.yaml`, starting from an existing spec under
   `scrapers/` of the same `source.type`. Required: `name`, `description`, `schedule`
   (cron, UTC, pick an odd minute), `source`, `fields` with `type` and `required`, and `key`
   (a stable id field for change detection). Set `fetch.minIntervalMs` to respect the site
   (1000 or more for HTML; follow any published API limit).
5. **Dry run** with `run_scraper(spec_path="proposals/scrapers/<name>.yaml")`. Fix every
   invalid record and every issue. Expect `0 invalid`.
6. **Report**: the spec, the dry-run summary, one sample record and the schedule rationale. A
   human applies it with `/scrape apply name:<name>`.

## Verification

- The dry run returns at least `validation.minItems` valid records and no invalid ones.
- `key` is unique across the sample (no two records share it).
- The schedule matches how often the source changes (do not poll a daily feed every minute).

## Pitfalls

- Relative links in HTML: add `transform: [absoluteUrl]` with `type: url`.
- Prices and counts with separators: add `transform: [number]` before `type: number`.
- A selector that matches nothing makes the field null; mark important fields `required: true`
  so the health check notices breakage.
