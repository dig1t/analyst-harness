---
tags: [scraping, parsing, selectors, maintenance]
aliases: [robust selectors, stable selectors, selector fallbacks, brittle selectors, selector health]
---

# Writing Robust Selectors

> Sources: Playwright documentation, Locators (https://playwright.dev/docs/locators) and Best Practices (https://playwright.dev/docs/best-practices); Testing Library, About Queries: Priority (https://testing-library.com/docs/queries/about/#priority); MDN Web Docs, data-* attributes (https://developer.mozilla.org/en-US/docs/Web/HTML/Global_attributes/data-*); MDN Web Docs, ARIA roles (https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles); W3C, WAI-ARIA 1.2 (https://www.w3.org/TR/wai-aria-1.2/); W3C, Selectors Level 4 (https://www.w3.org/TR/selectors-4/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Selectors break when a site redeploys, restyles, runs an A/B test, localizes or adds a banner. Robust selectors anchor on what the site itself depends on and therefore changes rarely: structured data and embedded JSON first, then stable ids and domain attributes (`data-sku`, `itemprop`), test hooks (`data-testid`), accessibility roles and labels, and label-to-value relationships. They avoid generated class names, long descendant chains, positional indexes and absolute paths. Scope every query to the record container, keep an ordered list of fallbacks per field and record which one matched, validate every value, and run fixture tests plus live canaries so a break is noticed the day it happens rather than when a dashboard goes flat.

## The stability ladder

| Rank | Anchor | Example | Why it lasts |
|---|---|---|---|
| 1 | Structured data, embedded JSON | JSON-LD `offers.price`, `__NEXT_DATA__` props | Serves search engines or the app itself, independent of markup |
| 2 | Semantic ids and domain attributes | `#product-title`, `[data-sku]`, `[itemprop="price"]` | Used by the site's own scripts and SEO |
| 3 | Test hooks | `[data-testid="price"]`, `[data-qa="add-to-cart"]` | Exist so the site's tests survive redesigns (some builds strip them) |
| 4 | Accessibility | `[role="dialog"]`, `[aria-label="Price"]`, `label[for]`, button names | Kept meaningful by accessibility requirements |
| 5 | Label-relative | `//dt[normalize-space()='SKU']/following-sibling::dd[1]` | Follows visible text; breaks under translation |
| 6 | Semantic tags plus short structure | `main article h1`, `table.specs td` | Moderate |
| 7 | Hand-written class names | `.product-price` | Change with redesigns |
| Avoid | Generated classes, positions, absolute paths | `.css-1q2w3e`, `div:nth-child(3) > span`, `/html/body/div[3]/div[2]` | Change on every deploy or content edit |

This mirrors the guidance browser-testing tools give for their own locators: Playwright recommends user-facing attributes (role, label, text, test id) over CSS or XPath tied to the DOM structure, and Testing Library ranks queries by how users perceive the page.

## Brittle and robust, side by side

| Brittle | Robust | Why |
|---|---|---|
| `div.sc-AxjAm.kLmNop > span` | `[data-testid="product-price"]` | Hash classes from CSS-in-JS change per build |
| `/html/body/div[2]/div[1]/div/h1` | `//main//h1` or `[itemprop="name"]` | Any wrapper added upstream breaks the path |
| `table tr:nth-child(4) td:nth-child(2)` | `//th[normalize-space()='Weight']/following-sibling::td[1]` | Row order changes with content |
| `.price` (old price, new price and unit price all match) | `[itemprop="price"]::attr(content)` or a scoped `.price--current` | Ambiguous matches pick the wrong value |
| `ul li a` | `#results > li.result a.result-title` | Over-broad selectors pick up navigation |
| `#react-select-3-input` | `input[name="country"]`, `label` text | Framework-generated ids change between renders |

## Fallbacks with telemetry

```python
from collections import Counter
from parsel import Selector

FIELDS = {
    "title": ["[itemprop='name']::text", "[data-testid='product-title']::text", "h1::text"],
    "price": ["[itemprop='price']::attr(content)", "[data-price]::attr(data-price)", ".price--current::text"],
    "sku":   ["[itemprop='sku']::text", "xpath://dt[normalize-space()='SKU']/following-sibling::dd[1]/text()"],
}
health = Counter()          # export as metrics: (field, rank) counts per run

def first_match(scope: Selector, candidates: list[str]):
    """Return (value, rank) for the first candidate that yields a non-empty value."""
    for rank, query in enumerate(candidates):
        result = scope.xpath(query[6:]) if query.startswith("xpath:") else scope.css(query)
        value = result.get()
        if value and value.strip():
            return " ".join(value.split()), rank
    return None, None

def extract_product(html: str) -> dict:
    cards = Selector(text=html).css("[data-testid='product'], main")
    if not cards:
        raise ValueError("record container not found")      # fail loudly: layout changed
    record = {}
    for field, candidates in FIELDS.items():
        record[field], rank = first_match(cards[0], candidates)
        health[(field, rank)] += 1
    return record

old = "<main data-testid='product'><h1 itemprop='name'>Kettle</h1><span itemprop='price' content='19.99'>19,99 €</span><dl><dt>SKU</dt><dd> K-17 </dd></dl></main>"
new = "<main><div data-testid='product'><h1 class='css-9x8y7'>Kettle</h1><span data-price='18.49'>18,49 €</span><dl><dt>SKU</dt><dd>K-17</dd></dl></div></main>"
print(extract_product(old))   # {'title': 'Kettle', 'price': '19.99', 'sku': 'K-17'}
print(extract_product(new))   # same fields, found through fallbacks
print(health)                 # ('title', 2) and ('price', 1) reveal that the primary selectors broke
```

The redesigned page still extracts, and the health counter shows that it did so through fallbacks. Alert when the share of fallback matches rises, before the last fallback fails too. The TypeScript equivalent with cheerio:

```ts
import * as cheerio from 'cheerio';

type Candidate = { css: string; attr?: string };

function firstMatch($: cheerio.CheerioAPI, scope: string, candidates: Candidate[]) {
  for (const [rank, c] of candidates.entries()) {
    const el = $(scope).find(c.css).first();
    if (el.length === 0) continue;
    const value = (c.attr ? el.attr(c.attr) : el.text())?.replace(/\s+/g, ' ').trim();
    if (value) return { value, selector: c.css, rank };
  }
  return { value: null, selector: null, rank: -1 };
}

const $ = cheerio.load('<div data-testid="product"><span itemprop="price" content="19.99">19,99 €</span></div>');
console.log(firstMatch($, '[data-testid="product"]', [
  { css: '[itemprop="price"]', attr: 'content' },
  { css: '[data-price]', attr: 'data-price' },
  { css: '.price' },
]));   // { value: '19.99', selector: '[itemprop="price"]', rank: 0 }
```

In a browser, Playwright's locators express the same priorities:

```ts
import type { Page } from 'playwright-core';

export async function readProduct(page: Page) {
  const card = page.getByTestId('product');                 // matches data-testid by default
  return {
    title: await card.getByRole('heading', { level: 1 }).textContent(),
    price: await card.locator('[itemprop="price"]').getAttribute('content'),
    inStock: await card.getByRole('button', { name: 'Add to cart' }).isEnabled(),
  };
}
```

## Validate every field

A selector that matches the wrong element is worse than one that matches nothing. Check each value: prices parse as `Decimal` and fall in a plausible range, SKUs match their pattern, URLs are absolute, required fields are present, and identifiers are unique within a page. Cross-check HTML values against JSON-LD where both exist. Put these rules in a schema at the boundary ([Schema Validation](../data-quality/schema-validation.md)).

## Detecting breakage early

- **Fixtures.** Save real pages for every template and state (in stock, sold out, on sale, multi-variant, another locale, an empty search) and assert exact values in tests ([Testing Scrapers](../data-quality/testing-scrapers.md)).
- **Canaries.** Re-scrape a few known URLs every run and alert when a field goes missing or falls back.
- **Health metrics.** Track match rate and fallback rank per field, and null rates per field over time ([Data Quality Monitoring](../data-quality/data-quality-monitoring.md)).
- **Raw archive.** Keep the HTML so a fixed parser can re-run over past fetches ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

Variants to test against: A/B experiments, logged-in versus anonymous pages, mobile markup, other locales (label text changes), cookie or consent overlays, and error pages that return status 200.

## Repairing with help

When a selector breaks, an LLM can propose replacements from the failing page, the old selector and the expected values from a fixture. Treat its output as a draft: run it against all fixtures and a live sample, and keep a human or automated review gate before deploying ([Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md)).

## Pitfalls

- **Test ids that vanish.** Some production builds strip `data-testid`; confirm it exists in the HTML your scraper receives.
- **Generated ids.** Ids from component libraries and hooks (`react-select-3-input`) look stable and are not.
- **Text anchors and translation.** `Weight` becomes `Peso` on the Spanish site; keep per-locale labels or prefer attributes.
- **Fallbacks that lie.** A generic last resort such as `h1` can match a logo or a promo banner; validate values, not just matches.
- **Silent partial breakage.** One field going null on 30% of pages rarely raises an exception; monitor null rates per field.
- **Cleverness.** A selector nobody understands will be "fixed" wrongly. Comment the intent next to non-obvious selectors.

## Checklist

- [ ] Checked for structured data or embedded JSON before writing selectors.
- [ ] Every query is scoped to a record container that is asserted to exist.
- [ ] Anchors come from the top of the stability ladder; no hash classes, positions or absolute paths.
- [ ] Each field has ordered fallbacks and reports which one matched.
- [ ] Values are validated; fixtures cover templates and states; canaries run every cycle.

## See Also

- [CSS Selectors for Extraction](css-selectors.md)
- [XPath for Extraction](xpath.md)
- [Structured Data (JSON-LD, Microdata, OpenGraph)](structured-data-schema-org.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
- [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md)
- [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)
