---
tags: [scraping, data-quality, testing, pytest, jest]
aliases: [Scraper tests, Fixture tests, Snapshot tests, Golden files, Canary tests]
---

# Testing Scrapers

> Sources: pytest documentation, fixtures and parametrize (https://docs.pytest.org/en/stable/how-to/fixtures.html); Jest documentation, snapshot testing (https://jestjs.io/docs/snapshot-testing); syrupy snapshot plugin (https://github.com/syrupy-project/syrupy); VCR.py (https://github.com/kevin1024/vcrpy); pytest-recording (https://github.com/kiwicom/pytest-recording); Playwright documentation, mocking with HAR files (https://playwright.dev/docs/mock#mocking-with-har-files); Mock Service Worker (https://mswjs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scrapers break for reasons outside your code: redesigns, A/B tests, block pages, new locales. Good tests separate two questions. **Is my code correct?** is answered offline and deterministically with **saved fixtures**: real pages captured once, parsed in unit, golden-file and snapshot tests on every commit. **Is the site still what my code expects?** is answered online with **contract checks and canaries**: a few scheduled, rate-limited live requests checked against invariants, plus data quality monitors in production. Never let CI hammer a live site, and never treat a block page as an empty result.

## Test layers

| Layer | Runs | Network | Catches |
|---|---|---|---|
| Unit tests of normalizers | Every commit | None | Parsing of prices, dates, units |
| Fixture tests (golden files) | Every commit | None | Selector and extraction regressions |
| Snapshot tests | Every commit | None | Any change in full output, reviewed as a diff |
| Contract tests | Every commit and on live samples | Optional | Output no longer matches the schema consumers rely on |
| Recorded HTTP (VCR, HAR) | Every commit | Replayed | Request flow, pagination, headers, API shapes |
| Canaries | Scheduled (hourly or daily) | Live, minimal | Site changes, blocks, auth changes |
| Production monitors | Every run | Live | Volume, null-rate and drift anomalies |

## Fixtures

Capture real responses once, store them with the tests, and keep a note of the source URL and capture date. Organize by site and page type:

```text
tests/fixtures/shop/
  product_in_stock.html            product_in_stock.expected.json
  product_out_of_stock.html        product_out_of_stock.expected.json
  product_on_sale.html             product_on_sale.expected.json
  category_last_page.html          blocked.html
  README.md   # source URL, capture date, how to refresh
```

Include the edge cases that break scrapers: out of stock, sale price, missing image, last page of pagination, empty search results, soft 404, a different locale, and **block or challenge pages** so the scraper's detection is tested. Strip personal data and session tokens from fixtures before committing them.

## pytest: golden files, contracts and snapshots

The parser under test detects block pages and reads schema.org JSON-LD:

```python
import json
import re

from bs4 import BeautifulSoup

BLOCK_MARKERS = re.compile(r"access denied|unusual traffic|verify you are human|just a moment", re.I)


class BlockedPage(Exception):
    """The response is a block or challenge page, not content. Never parse it as empty data."""


def parse_product(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    title_tag = soup.title.get_text() if soup.title else ""
    if BLOCK_MARKERS.search(title_tag) or soup.select_one("form#challenge-form"):
        raise BlockedPage(title_tag.strip())
    ld = next((json.loads(s.get_text()) for s in soup.select('script[type="application/ld+json"]')
               if '"Product"' in s.get_text()), {})
    offer = ld.get("offers", {})
    h1 = soup.select_one("h1")
    return {"sku": ld.get("sku"), "title": h1.get_text(strip=True) if h1 else None,
            "price": offer.get("price"), "currency": offer.get("priceCurrency"),
            "in_stock": offer.get("availability", "").endswith("/InStock")}
```

The tests run every fixture through the parser, compare with golden JSON, validate the output contract, and keep one syrupy snapshot (`pytest --snapshot-update` accepts intended changes):

```python
import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ConfigDict, Field

from shop_parser import BlockedPage, parse_product

FIXTURES = Path(__file__).parent / "fixtures" / "shop"
PRODUCT_CASES = sorted(p.stem for p in FIXTURES.glob("product_*.html"))


@pytest.fixture
def page():
    def _load(name: str) -> str:
        return (FIXTURES / f"{name}.html").read_text(encoding="utf-8")
    return _load


@pytest.mark.parametrize("case", PRODUCT_CASES)
def test_matches_golden_file(case, page):
    expected = json.loads((FIXTURES / f"{case}.expected.json").read_text(encoding="utf-8"))
    assert parse_product(page(case)) == expected


def test_block_page_raises_instead_of_returning_empty_record(page):
    with pytest.raises(BlockedPage):
        parse_product(page("blocked"))


class ProductContract(BaseModel):  # what downstream consumers rely on
    model_config = ConfigDict(extra="forbid")
    sku: str = Field(min_length=1)
    title: str = Field(min_length=1)
    price: str = Field(pattern=r"^\d+\.\d{2}$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    in_stock: bool


@pytest.mark.parametrize("case", PRODUCT_CASES)
def test_output_satisfies_contract(case, page):
    ProductContract.model_validate(parse_product(page(case)))


def test_snapshot(page, snapshot):  # syrupy
    assert parse_product(page("product_in_stock")) == snapshot
```

Golden files are explicit and reviewable; snapshots are cheap to create but easy to rubber-stamp, so review snapshot diffs as carefully as code.

## Jest: the same tests in TypeScript

With `cheerio` for parsing and `ts-jest` (`jest.config.js`: `module.exports = { preset: "ts-jest", testEnvironment: "node" };`):

```typescript
import * as cheerio from "cheerio";

export class BlockedPageError extends Error {}

const BLOCK_MARKERS = /access denied|unusual traffic|verify you are human|just a moment/i;

export function parseProduct(html: string) {
  const $ = cheerio.load(html);
  const title = $("title").text();
  if (BLOCK_MARKERS.test(title) || $("form#challenge-form").length > 0) {
    throw new BlockedPageError(title.trim());
  }
  const ld = $('script[type="application/ld+json"]')
    .toArray()
    .map((el) => JSON.parse($(el).text()))
    .find((obj) => obj["@type"] === "Product") ?? {};
  const offer = ld.offers ?? {};
  return {
    sku: ld.sku ?? null,
    title: $("h1").first().text().trim() || null,
    price: offer.price ?? null,
    currency: offer.priceCurrency ?? null,
    inStock: String(offer.availability ?? "").endsWith("/InStock"),
  };
}
```

```typescript
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BlockedPageError, parseProduct } from "../src/shopParser";

const dir = join(__dirname, "fixtures", "shop");
const read = (file: string) => readFileSync(join(dir, file), "utf8");
const productPages = readdirSync(dir).filter((f) => /^product_.*\.html$/.test(f));

const ProductContract = z.strictObject({
  sku: z.string().min(1),
  title: z.string().min(1),
  price: z.string().regex(/^\d+\.\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  inStock: z.boolean(),
});

describe("parseProduct", () => {
  test.each(productPages)("%s matches its snapshot", (file) => {
    expect(parseProduct(read(file))).toMatchSnapshot();
  });

  test.each(productPages)("%s satisfies the output contract", (file) => {
    expect(ProductContract.safeParse(parseProduct(read(file))).success).toBe(true);
  });

  test("block pages throw instead of yielding an empty record", () => {
    expect(() => parseProduct(read("blocked.html"))).toThrow(BlockedPageError);
  });
});
```

Jest writes snapshots to `__snapshots__/` on the first run; `jest -u` updates them after an intended change, and `--ci` makes missing snapshots fail instead of being written.

## Recorded HTTP: test the request flow offline

- **Python:** pytest-recording wraps VCR.py. Mark a test with `@pytest.mark.vcr`, record once with `pytest --record-mode=once`, commit the cassette from `tests/cassettes/`, and run CI with `--record-mode=none` so any unrecorded request fails. Filter cookies and authorization headers out of cassettes.
- **Node:** intercept `fetch` with Mock Service Worker or nock and serve fixture bodies.
- **Browser scrapers:** Playwright can replay a HAR file captured from a real session ([Network Interception and Response Capture](../browser-automation/network-interception.md)):

```typescript
import { chromium } from "playwright";

// Record once with update: true (politely, against the live site), commit the HAR,
// then replay offline in CI with update: false; unmatched requests are aborted.
export async function scrapeCategory(update = false): Promise<string[]> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.routeFromHAR("tests/fixtures/shop/category.har", {
      url: "**/api/**",
      update,
      notFound: update ? "fallback" : "abort",
    });
    await page.goto("https://shop.example/category/kettles");
    return await page.locator("[data-testid=product-title]").allTextContents();
  } finally {
    await browser.close();
  }
}
```

## Canaries: is the site still the same?

A canary fetches a handful of stable, known pages on a schedule with the production fetcher (same rate limits and User-Agent) and checks invariants. A block is reported as a block, never retried around:

```python
from shop_parser import BlockedPage, parse_product

CANARIES = {"https://shop.example/p/ab-2": {"sku": "AB-2", "currency": "EUR"}}


def run_canaries(fetch) -> list[str]:
    """fetch(url) -> (status, html)."""
    failures = []
    for url, invariants in CANARIES.items():
        status, html = fetch(url)
        if status != 200:
            failures.append(f"{url}: HTTP {status}")
            continue
        try:
            record = parse_product(html)
        except BlockedPage as exc:
            failures.append(f"{url}: blocked ({exc}); stop the scraper and review")
            continue
        wrong = [k for k, v in invariants.items() if record.get(k) != v]
        empty = [k for k, v in record.items() if v in (None, "")]
        if wrong or empty:
            failures.append(f"{url}: wrong {wrong}, empty {empty}")
    return failures
```

Tested against fixtures, it returns `[]` for the normal page, a "blocked" failure for the block page and a list of empty fields for a redesigned page. Route canary failures to the repair workflow ([Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)).

## The repair loop

When a canary or monitor fails: capture the new page as a fixture, write the failing test first, fix the selectors (by hand or with an LLM, see [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md)), make the whole fixture suite pass, then review the snapshot diff before merging. Old fixtures stay, so the fix cannot silently break pages that still use the previous layout.

Also test the polite parts: that the rate limiter spaces requests, that robots.txt disallows are honoured, and that a 429 triggers backoff rather than a retry storm.

## Pitfalls

- **Testing against the live site in CI.** Slow, flaky, impolite, and it fails for reasons unrelated to your change.
- **Synthetic HTML fixtures only.** Hand-written markup misses the mess real pages contain.
- **Rubber-stamping snapshot updates,** which turns snapshots into a record of whatever the code does.
- **Fixture rot.** Fixtures captured years ago pass while the live site has moved on; canaries catch this, and fixture READMEs should record capture dates.
- **Secrets and personal data in cassettes or HAR files.** Scrub them before committing.
- **Block pages parsed as empty results.** Always assert that detection raises.

## Checklist

- [ ] Real fixtures for each page type and edge case, including block pages, with capture metadata.
- [ ] Golden-file or snapshot tests run on every commit, offline.
- [ ] Output validated against the shared schema in tests.
- [ ] Request flow covered by recorded HTTP (VCR, MSW or HAR) with recording disabled in CI.
- [ ] Canaries scheduled with production politeness settings and invariant checks.
- [ ] Repair workflow starts with a new fixture and a failing test.
- [ ] Cassettes, HARs and fixtures scrubbed of credentials and personal data.

## See Also

- [Schema Validation](schema-validation.md)
- [Data Quality Monitoring](data-quality-monitoring.md)
- [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)
- [Using LLMs to Write and Repair Scrapers](../llm-scraping/llm-generated-scrapers.md)
- [Writing Robust Selectors](../parsing/robust-selectors.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
