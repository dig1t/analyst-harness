---
tags: [scraping, harness, runbook, operations]
aliases: [scraping runbook, new scraper procedure, scraper onboarding]
---

# Runbook: From Request to Scheduled Scraper

> Sources: analyst-harness source code and skills: skills/harness/build-scraper, skills/harness/responsible-scraping, skills/harness/repair-scraper, skills/harness/sql-analysis, src/app/runtime.ts (https://github.com/firebit-dev/analyst-harness); repository documentation docs/scrapers.md and docs/discord.md
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

This is the end-to-end procedure for turning "I want to track X" into a scheduled, monitored scraper whose data the analyst agent can query. It has eight stages: request, recon, acquisition decision, ethics and legal check, spec draft, dry run, review and apply, then operate. Agents do most of the work through skills (`build-scraper`, `responsible-scraping`, `repair-scraper`, `sql-analysis`); humans make the two decisions that matter: whether to collect the data at all, and whether to apply the spec.

## 1. Request

In Discord: `/ask task:"Track new posts on <site> daily and alert me about new ones"`, or in a terminal: `npm run cli -- run "..."`. Say what you need (fields, freshness, history), not how to scrape it. The analyst agent may delegate the technical part to the `scraper-engineer`.

## 2. Recon

The agent searches this vault first (`search_knowledge`), then inspects the target:

- Is there an official API, a bulk download or a feed? Check [Catalog of Useful Open APIs](../apis/official-apis-catalog.md) and the source playbooks such as [Government and Open Data Portals](../sources/government-open-data.md).
- What does robots.txt say for the paths involved ([robots.txt (RFC 9309)](../crawling/robots-txt.md))?
- Is the content server-rendered, or does the page load JSON from an endpoint ([Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md))?
- How often does it change, and how many requests would a run need?

## 3. Choose the acquisition strategy

Walk the ladder in [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md): official API, bulk or open data, feed, sitemap, hidden JSON endpoint, static HTML, and a browser only as a last resort. In spec terms that is `json`, `rss`, `sitemap` or `html`, in that order of preference ([Declarative Scraper Specs in This Harness](harness-scraper-spec.md)).

## 4. Ethics and legal check

The `responsible-scraping` skill turns [the ethical scraping checklist](../legal-ethics/ethical-scraping-checklist.md) into questions the agent must answer in its report: Is the data behind a login or paywall? Does it include personal data ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md))? Do the terms forbid automated access? Would the load be noticeable? Any "yes" goes to a human before anything is scheduled. The agent never works around blocks, CAPTCHAs or robots.txt.

## 5. Draft the spec

The agent writes `proposals/scrapers/<name>.yaml` in its workspace, starting from the closest existing spec, with a stable `key`, a realistic `validation.minItems`, `output.mode: changed`, a schedule that matches the source's update rate on a jittered minute, and `notify.onFailure: true`.

## 6. Dry run and iterate

```text
run_scraper(spec_path="proposals/scrapers/<name>.yaml")
```

A spec-path run is always a dry run: it fetches, extracts and validates, and returns counts, invalid samples and three sample records without writing a dataset. The agent iterates until the sample is right and the invalid ratio is near zero, then finishes with the spec, the dry-run result and its ethics answers.

## 7. Review and apply

A human reads the report and the spec. An admin applies it:

- Discord: `/scrape apply name:<name>` validates the spec against the schema, writes it to the live specs folder and registers the `scrape:<name>` cron job immediately.
- Git: copy the spec into `config/scrapers/` and commit it so the next image carries it (the container's live specs live on the data volume).

Check it: `/scrape run name:<name> dry_run:true`, then `/jobs` to see the next run.

## 8. Operate

- **Data** accumulates in `data/datasets/<dataset>/<YYYY-MM-DD>.jsonl`. Ask questions with `/ask`; the `sql-analysis` skill queries it with DuckDB, for example `SELECT count(*) FROM read_json_auto('datasets/<dataset>/*.jsonl')`.
- **Health**: failures alert after `alertAfterFailures` runs in a row, the daily digest summarizes every scraper, and `/scrape status name:<name>` shows the history ([Monitoring and Alerting](../operations/monitoring-and-alerting.md)).
- **Breakage**: `/scrape repair name:<name>` (or `scrapers.autoRepair`) starts the `scraper-engineer`, which diagnoses the change, drafts a fixed spec and dry-runs it. Review and apply as in stage 7. A site that now blocks automated access is reported, not worked around ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).
- **Retire**: set `enabled: false` (do not delete the spec in the container; seed files are restored on restart) and note why in the spec's comments.

## Pitfalls

- **Skipping recon.** Most broken scrapers were HTML scrapers for data that had an API or a feed.
- **Applying without reading the ethics answers.** The dry run proves it works, not that it is acceptable.
- **Forgetting git.** A spec applied only on the server is lost if the volume is lost; commit it.
- **Schedules on the hour.** Everyone schedules at minute 0; pick an odd minute.

## Checklist

- [ ] Recon covered APIs, feeds, robots.txt, rendering and change rate.
- [ ] The ethics and legal questions are answered, with a human sign-off where needed.
- [ ] The dry run shows correct samples and almost no invalid records.
- [ ] An admin applied the spec and `/jobs` lists it.
- [ ] The spec is committed to `config/scrapers/`.
- [ ] Someone watches the alerts channel.

## See Also

- [Declarative Scraper Specs in This Harness](harness-scraper-spec.md)
- [How the Agents Use and Grow This Vault](harness-knowledge-workflow.md)
- [Scraping Project Lifecycle](../fundamentals/scraping-project-lifecycle.md)
- [Scheduling and Cron](../operations/scheduling-and-cron.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
