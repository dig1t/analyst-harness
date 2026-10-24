---
name: repair-scraper
description: Diagnose a failing or degraded scraper (errors, zero items, many invalid records) and propose a corrected spec. Use when a scraper alert fires or someone runs /scrape repair.
---

# Repair a scraper

## Steps

1. **Read the evidence.** The task text carries the last error and the failure count. Read the
   live spec under `scrapers/<name>.yaml` and the recent records in `datasets/<dataset>/`.
2. **Reproduce.** Copy the spec to `proposals/scrapers/<name>.yaml` unchanged and run
   `run_scraper(spec_path=...)`. Note the exact error or issue.
3. **Classify the failure** (search the vault for "maintenance and breakage"):
   - HTTP 404 or redirect to a new URL: the endpoint moved.
   - 200 with zero items: the layout or API shape changed; compare the selectors with the page.
   - Many invalid records: a field changed format (dates, prices) or moved.
   - 403, 429 or a challenge page: the site is limiting or blocking automated access.
   - robots.txt now disallows the path: stop.
4. **Fix only what changed** in the proposal file. Keep `key` stable unless the old key no
   longer exists (say so, because it resets change detection).
5. **Dry run again** until it passes.
6. **Report** the root cause, a diff of old and new spec, and the dry-run result.

## Hard rules

- Never work around blocking, CAPTCHAs, paywalls or a robots.txt disallow. Report it and suggest
  an official API, a lower frequency or asking the site owner.
- Never edit the live spec directly; a human applies the proposal with `/scrape apply`.
