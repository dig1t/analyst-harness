---
tags: [scraping, operations, maintenance, breakage, runbook]
aliases: [scraper breakage, broken scraper, scraper repair, layout change, incident response for scrapers]
---

# Maintenance and Breakage Response

> Sources: Scrapy docs, Spiders Contracts (https://docs.scrapy.org/en/latest/topics/contracts.html); Scrapy release notes (https://docs.scrapy.org/en/latest/news.html); Spidermon documentation (https://spidermon.readthedocs.io/); Google SRE book, Postmortem Culture (https://sre.google/sre-book/postmortem-culture/); Playwright, Trace viewer (https://playwright.dev/docs/trace-viewer)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Every scraper breaks eventually: the markup changes, an endpoint moves, the site starts rendering client-side, a rate limit tightens, the data changes meaning, or our own dependencies and credentials change. Breakage cannot be prevented, so the goal is a short time to detect and a short time to repair. Detect within one run, sort the failure into a known class, stop writing bad data, reproduce from archived raw responses, fix with a test, backfill by re-parsing, and record what was learned. One class of failure is never "fixed" in code: when a site blocks you, changes its terms, or asks you to stop, the right repair is to slow down, ask, or retire the scraper.

## Why scrapers break

| Cause | Typical symptom | Where to look |
|---|---|---|
| Markup or layout change | 200 responses, 0 items or a field suddenly null | Selector match counts, diff old and new HTML |
| Move to client-side rendering | HTML has no data; it arrives via XHR | View source vs rendered DOM, Network panel |
| Endpoint or API version change | 404 or 410, new redirects, JSON keys renamed | Status mix, schema validation |
| Rate limit or bot rule change | 403, 429, challenge pages served with 200 | Status mix, block markers in content |
| Consent, geo or locale walls | Different language, currency or a consent page | Content checks on known fields |
| Data semantics change | Plausible but wrong values (VAT now included, new units) | Validation ranges, distribution drift |
| Data removed or site retired | 404s across the board, DNS failures | Volume, error classes |
| Our side | Dependency upgrade, expired token, full disk, clock or time zone change | Deploy history, run logs |
| Policy change | robots.txt now disallows, new terms, a request to stop | robots.txt diff, contact inbox |

Dependency upgrades are a real source: Scrapy 2.16 removed the long-deprecated `start_requests()` method (spiders now define `async def start()`), and selectolax 1.0 dropped its older Modest backend in favor of `selectolax.lexbor`. Read release notes before bumping pins.

## Detect early

Detection is mostly the job of [Monitoring and Alerting](monitoring-and-alerting.md) and [Data Quality Monitoring](../data-quality/data-quality-monitoring.md): item counts against a baseline, null rates per field, schema validation, and canary pages with known expected values. A cheap addition is selector health: count matches for every selector the parser depends on, per page type, and alert when a selector that normally matches returns zero, even before the item count moves.

```python
from selectolax.lexbor import LexborHTMLParser

CRITICAL = {  # selectors the parser depends on, per page type
    "listing": {"card": "article.product_pod", "title": "article.product_pod h3 a",
                "price": "p.price_color", "next": "li.next a"},
}


def selector_health(html: str, page_type: str) -> dict[str, int]:
    tree = LexborHTMLParser(html)
    return {name: len(tree.css(sel)) for name, sel in CRITICAL[page_type].items()}


def broken_selectors(counts: dict[str, int], optional: frozenset[str] = frozenset({"next"})) -> list[str]:
    return [name for name, n in counts.items() if n == 0 and name not in optional]

# selector_health(html, "listing") -> {'card': 2, 'title': 2, 'price': 0, 'next': 1}
# broken_selectors(...)            -> ['price']
```

Also diff `robots.txt` on every run (see [robots.txt (RFC 9309)](../crawling/robots-txt.md)) and treat a new `Disallow` covering your paths as a stop signal.

## Triage in five questions

1. **Is it us?** Check what changed on our side first: deploys, dependency versions, credentials, disk, DNS, proxy provider. Re-run the last known good version against archived raw responses; if it fails too, the bug is in the environment.
2. **Are we blocked?** Many 403 or 429 responses, challenge pages, or sudden redirects to a login or consent page. Stop the schedule, back off, and follow [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md). Do not try to defeat the control.
3. **Did the page change?** Diff the archived HTML from the last good run against today's; compare view-source with the rendered DOM (see [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)).
4. **Did the data change meaning?** Values parse but fail range or consistency checks. Fix the transform, not the selector (see [Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)).
5. **Is the data gone, or no longer allowed?** Retire the scraper or seek another source, such as an official API or licensed data.

## Repair workflow

1. **Contain.** Pause the schedule or switch the pipeline to quarantine mode, so bad or empty records do not overwrite good ones downstream.
2. **Capture.** Save failing responses as fixtures with URL, fetch time, status and headers. If they were archived, you already have them (see [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).
3. **Reproduce.** Write a failing test against the new fixture first.
4. **Fix robustly.** Prefer stable anchors: embedded JSON, JSON-LD, `data-*` attributes and semantic structure over generated class names, with fallbacks for critical fields (see [Writing Robust Selectors](../parsing/robust-selectors.md), [JSON and Embedded Data](../parsing/json-and-embedded-data.md) and [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)).
5. **Verify.** Run the full fixture suite (old layouts too, since sites often A/B test), schema validation and a live canary.
6. **Release and backfill.** Bump `parser_version`, deploy, then re-parse archived raw responses for the broken window instead of refetching (see [Provenance and Lineage](../data-quality/provenance-and-lineage.md)).
7. **Learn.** Write a short, blameless note: what broke, how it was detected, time to detect and repair, and which monitor or test now covers it. In this harness that note becomes a lesson (see [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)).

Fixture tests can be plain pytest, or Scrapy contracts in a callback docstring, checked with `scrapy check`:

```python
def parse(self, response):
    """Listing page.

    @url https://books.toscrape.com/catalogue/page-1.html
    @returns items 0 0
    @returns requests 20 21
    """
```

For browser scrapers, record a Playwright trace on failure (`trace: "retain-on-failure"` in the test config, or `context.tracing` in scripts) so the repair starts from a timeline of requests, DOM snapshots and console errors instead of a guess.

## LLM-assisted repair

Agents are good at proposing a new selector from a diff of old and new HTML, or at mapping a renamed JSON key. Keep the guardrails: the agent works from captured fixtures, its fix must pass the fixture suite and validation, a human (or a strict review gate) approves production changes, and a block is never "repaired" by adding evasion. See [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md).

## Preventive maintenance

- Pin dependencies and upgrade on purpose, one component at a time, with the fixture suite as the gate.
- Archive raw responses so any fix can be backfilled without refetching.
- Give every scraper an owner, a runbook, a "last verified" date and explicit retirement criteria (see [Scraping Project Lifecycle](../fundamentals/scraping-project-lifecycle.md)).
- Review robots.txt, terms and the need for the data periodically (see [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)).
- For Scrapy fleets, Spidermon turns crawl stats and item validation into monitors with notifications.

## Pitfalls

- Fixing the selector without a regression test, so the next redesign breaks it again silently.
- Letting a broken run overwrite good data (empty snapshots replacing yesterday's prices).
- Refetching the whole site to backfill when the raw responses were never archived.
- Treating a block as a parsing bug and "fixing" it with evasion.
- Over-fitting to one A/B variant of a page; collect fixtures from several sessions.
- Upgrading several libraries at once and not knowing which change broke parsing.

## Checklist

- [ ] Selector health, volume and validation monitors per page type
- [ ] robots.txt diffed on every run
- [ ] Quarantine mode that stops bad data from propagating
- [ ] Raw responses archived and fixtures captured for every incident
- [ ] Failing test written before the fix
- [ ] Backfill by re-parsing, with `parser_version` recorded
- [ ] Incident note or lesson written; runbook updated

## See Also

- [Monitoring and Alerting](monitoring-and-alerting.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
- [Writing Robust Selectors](../parsing/robust-selectors.md)
- [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md)
- [Runbook: From Request to Scheduled Scraper](../harness/scraping-runbook.md)
- [Common Scraping Pitfalls](../fundamentals/common-pitfalls.md)
