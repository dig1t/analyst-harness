---
tags: [scraping, data-quality, zod, pydantic, json-schema]
aliases: [Data contracts, Zod, Pydantic, JSON Schema, Record validation]
---

# Schema Validation

> Sources: Zod documentation (https://zod.dev); Pydantic documentation (https://pydantic.dev/docs/validation/latest/get-started/); JSON Schema Draft 2020-12 (https://json-schema.org/draft/2020-12); python-jsonschema documentation (https://python-jsonschema.readthedocs.io/); Ajv JSON schema validator (https://ajv.js.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A scraper fails silently far more often than it crashes: a selector starts matching the "Loading..." placeholder, a price loses its decimals, a field disappears after a redesign. Schema validation turns those silent failures into loud, countable ones. Validate **at the boundary**, right after extraction and before anything is stored or published, using a schema that acts as a **contract** between the scraper and its consumers. Each record either passes or goes to quarantine with machine-readable reasons, and the **invalid rate per run** becomes a health metric. Zod (TypeScript) and Pydantic (Python) give typed, composable schemas; JSON Schema is the language-neutral format to share contracts between components.

## What to validate

| Check | Example | Catches |
|---|---|---|
| Types and required fields | `price` is a number, `sku` present | Selector returning nothing |
| Formats | URL, ISO 8601 with offset, currency code | Relative links, naive timestamps |
| Ranges and lengths | `0 < price < 1e6`, `title` up to 300 chars | Grabbing a whole page into one field |
| Enumerations | `currency in {USD, EUR, GBP}` | New locale or region rendering |
| Placeholders | not "N/A", "-", "Loading..." | Content that had not rendered yet |
| Cross-field rules | `sale_price <= price` | Swapped selectors |
| Unknown fields | reject or log extra keys | Upstream JSON schema changes |
| Batch rules | invalid rate under 2 percent, unique keys | Systemic breakage versus one bad page |

## TypeScript with zod (v4)

```typescript
import { z } from "zod";

const PLACEHOLDERS = new Set(["", "n/a", "-", "loading...", "null", "undefined"]);

const NonPlaceholder = z
  .string()
  .trim()
  .min(1)
  .refine((s) => !PLACEHOLDERS.has(s.toLowerCase()), { message: "placeholder value" });

export const Product = z
  .strictObject({
    sku: z.string().regex(/^[A-Z0-9-]{4,32}$/),
    title: NonPlaceholder.pipe(z.string().max(300)),
    url: z.url({ protocol: /^https?$/ }),
    price: z.number().positive().max(1_000_000),
    currency: z.enum(["USD", "EUR", "GBP"]),
    salePrice: z.number().positive().optional(),
    inStock: z.boolean(),
    fetchedAt: z.iso.datetime({ offset: true }),
  })
  .refine((p) => p.salePrice === undefined || p.salePrice <= p.price, {
    message: "salePrice must not exceed price",
    path: ["salePrice"],
  });

export type Product = z.infer<typeof Product>;

export function validateBatch(rows: unknown[]) {
  const valid: Product[] = [];
  const quarantined: { row: unknown; errors: string }[] = [];
  for (const row of rows) {
    const result = Product.safeParse(row);
    if (result.success) valid.push(result.data);
    else quarantined.push({ row, errors: z.prettifyError(result.error) });
  }
  return { valid, quarantined, invalidRate: rows.length ? quarantined.length / rows.length : 0 };
}
```

Notes on zod 4: `z.strictObject` rejects unknown keys (`z.looseObject` passes them through), `z.url()` and `z.iso.datetime()` are top-level formats, `safeParse` never throws, and `z.toJSONSchema(Product)` exports a Draft 2020-12 schema. Refinements cannot be expressed in JSON Schema, so keep cross-field rules documented next to the export. Zod 3 code uses `z.string().url()` and `z.string().datetime()` instead.

## Python with Pydantic (v2)

```python
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (AwareDatetime, BaseModel, ConfigDict, Field, HttpUrl,
                      ValidationError, field_validator, model_validator)

PLACEHOLDERS = {"", "n/a", "-", "loading...", "null", "undefined"}
Money = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]


class Product(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, frozen=True)

    sku: Annotated[str, Field(pattern=r"^[A-Z0-9-]{4,32}$")]
    title: Annotated[str, Field(min_length=1, max_length=300)]
    url: HttpUrl
    price: Money
    currency: Literal["USD", "EUR", "GBP"]
    sale_price: Money | None = None
    in_stock: bool
    fetched_at: AwareDatetime  # rejects timestamps without an offset

    @field_validator("title")
    @classmethod
    def not_placeholder(cls, v: str) -> str:
        if v.lower() in PLACEHOLDERS:
            raise ValueError("placeholder value")
        return v

    @model_validator(mode="after")
    def sale_not_above_price(self) -> "Product":
        if self.sale_price is not None and self.sale_price > self.price:
            raise ValueError("sale_price must not exceed price")
        return self


def validate_batch(rows: list[dict]) -> tuple[list[Product], list[dict]]:
    valid, quarantined = [], []
    for row in rows:
        try:
            valid.append(Product.model_validate(row))
        except ValidationError as exc:
            quarantined.append({"row": row, "errors": exc.errors(include_url=False)})
    return valid, quarantined
```

`exc.errors()` returns dictionaries with `loc`, `type` and `msg`, for example `('fetched_at',) timezone_aware` or `('extra',) extra_forbidden`, which are ideal for aggregating failure reasons per run. `Product.model_json_schema()` exports JSON Schema, and `TypeAdapter(list[Product])` validates whole lists.

## JSON Schema as the shared contract

When the producer is a Node scraper and the consumer is a Python analysis job (or an LLM extraction step), export one schema and validate on both sides: Ajv in JavaScript, `jsonschema` in Python.

```python
from jsonschema import Draft202012Validator

validator = Draft202012Validator(Product.model_json_schema())
row = {"sku": "ab", "title": "Kettle", "url": "https://shop.example/p/1", "price": "24.50",
       "currency": "EUR", "in_stock": True, "fetched_at": "2026-10-24T08:00:00Z", "colour": "red"}
for err in sorted(validator.iter_errors(row), key=lambda e: list(e.path)):
    print(list(err.path), err.message)
# [] Additional properties are not allowed ('colour' was unexpected)
# ['sku'] 'ab' does not match '^[A-Z0-9-]{4,32}$'
```

Generated schemas carry only what JSON Schema can express. Model validators, refinements and custom coercions live in code, so run the native validator where the data is produced.

## A validation strategy for scrapers

1. **Validate every record** after extraction; never let unvalidated data reach storage.
2. **Quarantine with context:** raw snippet or pointer, field, error type, parser version, URL.
3. **Fail the run on systemic breakage:** if the invalid rate passes a threshold (often 2 to 5 percent) or a required field is missing on most records, stop publishing and alert instead of loading a broken batch ([Data Quality Monitoring](data-quality-monitoring.md)).
4. **Be strict on your output, tolerant on upstream input.** Reject unknown keys in your own records; for third-party JSON APIs, accept unknown fields but log new keys as schema drift.
5. **Version contracts.** Add a `schema_version`; make additive changes optional first, and remove fields only after consumers have moved.
6. **Test schemas with fixtures** of real good and bad pages ([Testing Scrapers](testing-scrapers.md)).

## Pitfalls

- **Coercion surprises.** `z.coerce.number()` turns `""` into `0`, a classic way to store free products. Prefer explicit parsing, then validate.
- **Lax mode defaults.** Pydantic accepts `"1"` for an `int` field by default; enable strict mode on fields where a string means the selector is wrong.
- **Optional everything.** A schema where every field is optional validates garbage. Decide what is truly required.
- **Validating after loading.** Bad rows already reached consumers.
- **Dropping invalid records silently.** You lose the evidence you need to repair the scraper.
- **Treating JSON Schema export as complete.** Refinements and validators are not in it.

## Checklist

- [ ] One schema per record type, shared by tests and production.
- [ ] Required fields, formats, ranges, enums and placeholder rules defined.
- [ ] Cross-field invariants implemented and tested.
- [ ] Unknown-field policy chosen (strict for output, logged for input).
- [ ] Quarantine table with reasons and parser version.
- [ ] Invalid rate tracked per run, with a threshold that blocks publishing.
- [ ] JSON Schema exported for cross-language consumers.
- [ ] `schema_version` field and a change process for consumers.

## See Also

- [Data Cleaning Pipeline](data-cleaning-pipeline.md)
- [Data Quality Monitoring](data-quality-monitoring.md)
- [Testing Scrapers](testing-scrapers.md)
- [Schema-Guided Extraction](../llm-scraping/schema-guided-extraction.md)
- [Validating LLM Extractions](../llm-scraping/validating-llm-output.md)
- [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md)
