---
tags: [scraping, data-quality, etl, normalization, idempotency]
aliases: [Cleaning pipeline, ETL for scraped data, Data cleaning, Normalization pipeline]
---

# Data Cleaning Pipeline

> Sources: Hadley Wickham, "Tidy Data", Journal of Statistical Software 59(10), 2014 (https://www.jstatsoft.org/article/view/v059i10); Unicode Standard Annex #15, Normalization Forms (https://unicode.org/reports/tr15/); Python unicodedata module (https://docs.python.org/3/library/unicodedata.html); Python decimal module (https://docs.python.org/3/library/decimal.html); SQLite UPSERT (https://www.sqlite.org/lang_upsert.html); Zod documentation (https://zod.dev)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scraped data arrives as strings in whatever shape the page author chose: non-breaking spaces, "1.299,00 €", "Yesterday", "N/A", duplicated rows across pagination. A cleaning pipeline turns that into typed, validated, deduplicated records in fixed stages, each one a **pure, deterministic, idempotent** transform: the same input always gives the same output, and running a stage twice changes nothing. Keep the raw response untouched so any stage can be re-run with a newer parser, send bad records to a **quarantine** instead of dropping or coercing them, and stamp every output with the parser version that produced it.

## Stages

| Stage | Input | Output | Rules | On failure |
|---|---|---|---|---|
| 1. Capture | HTTP response | Raw bytes + metadata | Write once, content-addressed | Retry fetch, never edit |
| 2. Extract | Raw HTML/JSON | Field strings | Selectors only, no cleaning logic | Record extraction error |
| 3. Normalize | Field strings | Typed values | Text, numbers, dates, enums, URLs | Keep raw string, flag field |
| 4. Validate | Typed record | Valid or quarantined | Schema plus invariants | Quarantine with reasons |
| 5. Deduplicate | Valid records | One record per entity | Natural keys, then fuzzy matching | Review queue |
| 6. Load | Records | Rows in storage | Keyed upsert, change tracking | Transaction rollback |
| 7. Publish | Tables | Views, exports, alerts | Only from validated tables | Block publish, alert |

Keeping extraction separate from normalization matters: when a site changes, you fix selectors without touching cleaning logic, and when a cleaning rule changes, you re-run stages 3 to 6 over stored raw data without refetching anything.

## Design rules

1. **Raw is immutable.** Store responses before parsing ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)). Never "fix" raw files.
2. **Transforms are pure.** No clock reads, random numbers or network calls inside normalization. Pass `fetched_at` in from the fetcher.
3. **Loads are idempotent.** Upsert by a natural key (source plus SKU, listing id, canonical URL), never blind inserts. A rerun of the same batch must leave the table unchanged.
4. **Late data cannot overwrite newer data.** Compare observation times in the upsert.
5. **Quarantine, do not coerce.** An unparseable price becomes a quarantined row with the original string, not `0` or `NULL`.
6. **Version everything.** Each record carries `parser_version`; quarantine rows too, so reprocessing can target them.
7. **Money is not a float.** Use `Decimal` in Python and strings or integer minor units in JavaScript.

## Normalization rules

- **Text:** Unicode NFC, replace non-breaking spaces, collapse whitespace, decode entities once. Reserve NFKC and case folding for matching keys, because they change the displayed value ([Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)).
- **Numbers and currencies:** decide the decimal separator from the page locale, not by guessing per value; keep the currency code next to the amount ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)).
- **Dates:** parse with an explicit time zone, store UTC in ISO 8601, keep the original string when it was relative ("2 hours ago") together with the fetch time used to resolve it.
- **Enumerations:** map site vocabulary ("In stock", "Disponible", "Only 2 left") to a closed set through an explicit table; unknown values go to quarantine so the table grows deliberately.
- **URLs and identifiers:** canonicalize URLs and strip tracking parameters before using them as keys ([URL Normalization and Canonicalization](../crawling/url-normalization.md)).
- **Placeholders:** "N/A", "-", "Loading..." and "Call for price" mean missing; treat them as such explicitly.

## Python reference implementation

Normalization, validation, quarantine and an idempotent upsert into SQLite. Re-running a batch is a no-op; a changed value updates `last_changed`; replaying an older batch is ignored.

```python
import hashlib, json, re, sqlite3, unicodedata
from decimal import Decimal, InvalidOperation

PARSER_VERSION = "listings-parser@2.3.0"
CURRENCY_SIGNS = {"$": "USD", "€": "EUR", "£": "GBP"}

def clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    value = unicodedata.normalize("NFC", value).replace("\u00a0", " ")
    return re.sub(r"\s+", " ", value).strip() or None

def parse_money(raw: str | None, decimal_comma: bool = False) -> tuple[Decimal | None, str | None]:
    text = clean_text(raw)
    if not text:
        return None, None
    currency = next((code for sign, code in CURRENCY_SIGNS.items() if sign in text), None)
    digits = re.sub(r"[^\d.,]", "", text)
    digits = digits.replace(".", "").replace(",", ".") if decimal_comma else digits.replace(",", "")
    try:
        return Decimal(digits).quantize(Decimal("0.01")), currency
    except InvalidOperation:
        return None, currency

def normalize(raw: dict, *, fetched_at: str, source: str) -> dict:
    """Pure: no clock, no network. Same input, same output."""
    price, currency = parse_money(raw.get("price"), decimal_comma=raw.get("locale") == "de-DE")
    return {"source": source, "natural_key": clean_text(raw.get("sku")), "title": clean_text(raw.get("title")),
            "price": str(price) if price is not None else None, "currency": currency,
            "fetched_at": fetched_at, "parser_version": PARSER_VERSION}

def content_hash(rec: dict, ignore=("fetched_at", "parser_version")) -> str:
    payload = {k: v for k, v in rec.items() if k not in ignore}
    return hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"),
                                     ensure_ascii=False).encode()).hexdigest()

def problems(rec: dict) -> list[str]:
    return [msg for ok, msg in [(rec["natural_key"], "missing natural_key"), (rec["title"], "missing title"),
                                (rec["price"] is not None, "unparseable price")] if not ok]

SCHEMA = """
CREATE TABLE IF NOT EXISTS listings (source TEXT NOT NULL, natural_key TEXT NOT NULL, title TEXT,
  price TEXT, currency TEXT, content_hash TEXT NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
  last_changed TEXT NOT NULL, parser_version TEXT NOT NULL, PRIMARY KEY (source, natural_key));
CREATE TABLE IF NOT EXISTS quarantine (source TEXT, raw_json TEXT, errors TEXT, fetched_at TEXT,
  parser_version TEXT, UNIQUE (source, raw_json, parser_version));
"""
UPSERT = """
INSERT INTO listings VALUES (:source, :natural_key, :title, :price, :currency, :content_hash,
                             :fetched_at, :fetched_at, :fetched_at, :parser_version)
ON CONFLICT (source, natural_key) DO UPDATE SET
  title = excluded.title, price = excluded.price, currency = excluded.currency,
  last_changed = CASE WHEN listings.content_hash = excluded.content_hash
                      THEN listings.last_changed ELSE excluded.last_seen END,
  last_seen = excluded.last_seen, content_hash = excluded.content_hash,
  parser_version = excluded.parser_version
WHERE excluded.last_seen >= listings.last_seen  -- ignore replays of older batches
"""

def load(conn: sqlite3.Connection, raws: list[dict], *, fetched_at: str, source: str) -> None:
    with conn:  # one transaction per batch
        for raw in raws:
            rec = normalize(raw, fetched_at=fetched_at, source=source)
            if errs := problems(rec):
                conn.execute("INSERT OR IGNORE INTO quarantine VALUES (?, ?, ?, ?, ?)",
                             (source, json.dumps(raw, sort_keys=True), json.dumps(errs), fetched_at, PARSER_VERSION))
                continue
            conn.execute(UPSERT, {**rec, "content_hash": content_hash(rec)})

conn = sqlite3.connect(":memory:")
conn.executescript(SCHEMA)
batch = [{"sku": "AB-1", "title": "Blue\u00a0Kettle ", "price": "1.299,00 €", "locale": "de-DE"},
         {"sku": "", "title": "Broken row", "price": "call us"}]
load(conn, batch, fetched_at="2026-10-24T08:00:00Z", source="shop.example")
load(conn, batch, fetched_at="2026-10-24T08:00:00Z", source="shop.example")  # rerun: no change
print(conn.execute("SELECT natural_key, price, currency FROM listings").fetchall())  # [('AB-1', '1299.00', 'EUR')]
```

Validation here is a minimal `problems()` list; in production use a schema library ([Schema Validation](schema-validation.md)).

## TypeScript: normalize, then validate

With zod, chain a `transform` (normalize) into a `pipe` (validate) so each field reports its own error:

```typescript
import { z } from "zod";

const cleanText = z.string().transform((s) =>
  s.normalize("NFC").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim(),
);

// "1.299,00 €" -> "1299.00", kept as a string, never a float
const moneyText = (decimalComma: boolean) =>
  cleanText.transform((s, ctx) => {
    let digits = s.replace(/[^\d.,]/g, "");
    digits = decimalComma ? digits.replace(/\./g, "").replace(",", ".") : digits.replace(/,/g, "");
    if (!/^\d+(\.\d{1,2})?$/.test(digits)) {
      ctx.addIssue({ code: "custom", message: `unparseable price: ${s}` });
      return z.NEVER;
    }
    const [whole, frac = ""] = digits.split(".");
    return `${whole.replace(/^0+(?=\d)/, "")}.${frac.padEnd(2, "0")}`;
  });

export const ListingDE = z.object({
  sku: cleanText.pipe(z.string().min(1)),
  title: cleanText.pipe(z.string().min(1).max(300)),
  price: moneyText(true),
});

ListingDE.parse({ sku: " AB-1 ", title: "Blue\u00a0 Kettle", price: "1.299,00 €" });
// { sku: "AB-1", title: "Blue Kettle", price: "1299.00" }
```

## Reprocessing and backfills

Because raw data is kept and transforms are pure, a parser fix is a replay: select raw captures (or quarantined rows) by source and `parser_version`, run stages 2 to 6 with the new version, and compare outputs against the old ones before switching readers. Run the comparison as a diff report ([Change Detection and Diffing](change-detection-and-diffing.md)) so a "fix" that silently changes thousands of prices gets noticed.

## Pitfalls

- **Cleaning inside selectors.** Mixing `.strip().replace(...)` into extraction makes every site change a cleaning change too.
- **NFKC on display text.** It turns "ﬁ" into "fi" and full-width digits into ASCII; fine for keys, lossy for content.
- **Coercing failures to defaults.** `0`, `""` or `NULL` hides breakage; downstream averages quietly drift.
- **Floats for money.** Rounding differences break equality checks, hashes and totals.
- **`datetime.now()` in transforms.** Reprocessing then yields different results from the same raw data.
- **Deduplicating before normalizing.** "Joe's Café" and "Joes Cafe" only collide after normalization.
- **Blind inserts.** Retries and overlapping pages create duplicates; use keyed upserts.

## Checklist

- [ ] Raw responses stored before parsing, never modified.
- [ ] Extraction, normalization and validation are separate functions.
- [ ] Normalization functions are pure and unit-tested with fixtures.
- [ ] Money stored as Decimal, string or integer minor units with a currency code.
- [ ] Timestamps stored in UTC with the source time zone recorded.
- [ ] Invalid records quarantined with reasons and parser version.
- [ ] Loads are keyed upserts; reruns verified to be no-ops.
- [ ] Reprocessing path exists from raw captures for a new parser version.

## See Also

- [Schema Validation](schema-validation.md)
- [Record Deduplication and Entity Resolution](record-deduplication-entity-resolution.md)
- [Provenance and Lineage](provenance-and-lineage.md)
- [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)
- [Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
