---
tags: [scraping, data-quality, change-detection, hashing, diffing]
aliases: [Content hashing, Diffing, Change monitoring, Page change detection, Fingerprinting records]
---

# Change Detection and Diffing

> Sources: RFC 9110, HTTP Semantics, validators and conditional requests (https://www.rfc-editor.org/rfc/rfc9110); RFC 8785, JSON Canonicalization Scheme (https://www.rfc-editor.org/rfc/rfc8785); Python hashlib (https://docs.python.org/3/library/hashlib.html); Node.js crypto (https://nodejs.org/api/crypto.html); DeepDiff documentation (https://zepworks.com/deepdiff/); Manku, Jain and Das Sarma, "Detecting Near-Duplicates for Web Crawling", WWW 2007 (https://doi.org/10.1145/1242572.1242592)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most monitoring scrapers exist to answer one question: **what changed since last time?** Answer it at three levels. At the **transport** level, conditional requests (ETag, Last-Modified, 304) skip unchanged pages before you download them. At the **document** level, a hash of the normalized main content tells you whether the page changed in a way that matters. At the **record** level, a hash of the canonical extracted record detects any change, and a **field-level diff** says exactly what changed so you can decide whether to alert. The hard part is not hashing; it is excluding volatile noise (timestamps, CSRF tokens, ads, rotating recommendations) so that "changed" means changed.

## Three levels of change detection

| Level | Mechanism | Cost saved | Blind spots |
|---|---|---|---|
| Transport | `If-None-Match` / `If-Modified-Since`, 304 responses | Bandwidth and server load | Many dynamic pages never send validators |
| Document | SHA-256 of normalized main content | Parsing and storage | Over-sensitive if noise is not removed |
| Record | SHA-256 of canonical extracted record, plus field diff | Downstream writes and alerts | Only sees fields you extract |

Start with transport-level validators wherever the server supports them ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)), and schedule revisits by observed change rate ([Incremental Crawling](../crawling/incremental-crawling.md)).

## Document fingerprints: normalize, then hash

Hash only the part of the page you care about, after removing nodes that change on every request:

```python
import hashlib, re
from bs4 import BeautifulSoup

VOLATILE_SELECTORS = ["script", "style", "noscript", "[data-testid=timestamp]", ".ad-slot",
                      "input[name=csrf_token]", "#recently-viewed"]

def page_fingerprint(html: str, root_selector: str = "main") -> str:
    soup = BeautifulSoup(html, "html.parser")
    root = soup.select_one(root_selector) or soup
    for sel in VOLATILE_SELECTORS:
        for node in root.select(sel):
            node.decompose()
    text = re.sub(r"\s+", " ", root.get_text(" ")).strip()
    return hashlib.sha256(text.encode("utf-8")).hexdigest()
```

A timestamp, CSRF token or ad rotation leaves this fingerprint unchanged; a price change does not. For "how different" rather than "whether different", use similarity hashing (SimHash, as in Manku et al.) or a text diff ratio ([Deduplication (URLs and Content)](../crawling/deduplication.md)).

## Record fingerprints: canonical JSON

Hash a canonical serialization of the extracted record with volatile fields removed: keys sorted, no insignificant whitespace, UTF-8. The Python and TypeScript versions below produce identical hashes for records made of strings, integers, booleans, null, lists and objects (verified on a shared fixture), so a Node scraper and a Python pipeline can compare fingerprints.

```python
import hashlib, json

VOLATILE = {"fetched_at", "run_id", "rank"}

def fingerprint(record: dict, volatile: set[str] = VOLATILE) -> str:
    stable = {k: v for k, v in record.items() if k not in volatile}
    canonical = json.dumps(stable, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
```

```typescript
import { createHash } from "node:crypto";

// Matches Python's json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)
// for strings, integers, booleans and null. Keep money as strings.
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

const VOLATILE = new Set(["fetchedAt", "fetched_at", "runId", "run_id", "rank"]);

export function fingerprint(record: Record<string, unknown>, volatile = VOLATILE): string {
  const stable = Object.fromEntries(Object.entries(record).filter(([k]) => !volatile.has(k)));
  return createHash("sha256").update(canonicalize(stable), "utf8").digest("hex");
}
```

Floats break cross-language parity: Python serializes `1.0` as `1.0`, JavaScript as `1`. Store prices as strings or integer minor units, or use an RFC 8785 (JCS) implementation in both languages.

## Field-level diffs

When the fingerprint changes, compute which fields changed and classify each change:

```python
from decimal import Decimal

def flatten(value, prefix=""):
    """{'specs': {'color': 'red'}, 'tags': ['x']} -> {'specs.color': 'red', 'tags[0]': 'x'}"""
    if isinstance(value, dict):
        out = {}
        for k, v in value.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else k))
        return out
    if isinstance(value, list):
        out = {}
        for i, v in enumerate(value):
            out.update(flatten(v, f"{prefix}[{i}]"))
        return out
    return {prefix: value}

def diff(old: dict, new: dict, volatile: set[str] = VOLATILE) -> list[dict]:
    a = {k: v for k, v in flatten(old).items() if k.split(".")[0].split("[")[0] not in volatile}
    b = {k: v for k, v in flatten(new).items() if k.split(".")[0].split("[")[0] not in volatile}
    return [{"field": k, "old": a.get(k), "new": b.get(k)}
            for k in sorted(a.keys() | b.keys()) if a.get(k) != b.get(k)]

def significant(change: dict) -> bool:
    field, old, new = change["field"], change["old"], change["new"]
    if field == "price" and old and new:
        return abs(Decimal(new) - Decimal(old)) / Decimal(old) >= Decimal("0.05")
    return field in {"in_stock", "title"} or old is None or new is None

old = {"sku": "AB-2", "price": "24.50", "in_stock": True, "specs": {"color": "red"}, "fetched_at": "2026-10-24T08:00:00Z"}
new = {**old, "price": "22.00", "specs": {"color": "rouge"}, "fetched_at": "2026-10-25T08:00:00Z"}
for change in diff(old, new):
    print(change, "significant" if significant(change) else "minor")
# {'field': 'price', 'old': '24.50', 'new': '22.00'} significant
# {'field': 'specs.color', 'old': 'red', 'new': 'rouge'} minor
```

For complex nested data, DeepDiff handles ordering and type changes:

```python
from deepdiff import DeepDiff

dd = DeepDiff({"price": "24.50", "tags": ["kettle", "red"], "fetched_at": "a"},
              {"price": "22.00", "tags": ["red", "kettle", "sale"], "fetched_at": "b"},
              ignore_order=True, exclude_paths=["root['fetched_at']"])
print(dd.to_dict())
# {'values_changed': {"root['price']": {'new_value': '22.00', 'old_value': '24.50'}},
#  'iterable_item_added': {"root['tags'][2]": 'sale'}}
```

In the browser or Node, jsondiffpatch plays a similar role.

## Storing history

Do not overwrite the previous value; you will want the time series later. Two common shapes ([Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)):

- **Append-only observations:** one row per fetch with the fingerprint; changes are rows whose fingerprint differs from the previous one for the same key.
- **Type 2 history:** one row per version with `valid_from` and `valid_to`, closed when the fingerprint changes. Compact, and easy to query "as of" a date.

Either way, store the field diff alongside the change so alerts and audits do not need to recompute it.

## Alerting on change

- **Alert on significance, not on difference.** A 0.5 percent price move or a reordered list is not news; a stock-out or a 30 percent drop may be.
- **Suppress flapping.** Require a change to persist for two consecutive observations before alerting when values oscillate (A/B tests, regional caches).
- **Watch the change rate itself.** If 90 percent of records change in one run, the site or your parser changed, not the world. Route that to breakage triage, not to business alerts ([Data Quality Monitoring](data-quality-monitoring.md)).
- **Batch notifications** into a digest per run, with a link to the diff report.

## Pitfalls

- **Hashing raw HTML.** Nonces, timestamps and ad markup change every request, so everything looks changed.
- **Hashing after lossy extraction only.** If a field you do not extract changes, you never know; combine record and document fingerprints for important pages.
- **Unstable serialization.** Unsorted keys, locale-formatted numbers or floats give different hashes for identical data.
- **Volatile fields inside nested objects.** Exclude them at every level, or extract them out before hashing.
- **Overwriting history** in place, which destroys the evidence needed to explain an alert.
- **Alerting on every diff,** which trains people to ignore alerts.

## Checklist

- [ ] Conditional requests used where validators exist.
- [ ] Volatile selectors and fields listed per source and excluded before hashing.
- [ ] Record fingerprints computed from canonical JSON with money as strings or integers.
- [ ] Cross-language fingerprint parity tested on shared fixtures.
- [ ] Field diffs stored with each change; history kept append-only or as type 2 versions.
- [ ] Significance rules and flapping suppression defined per field.
- [ ] Change rate per run monitored as a breakage signal.

## See Also

- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Deduplication (URLs and Content)](../crawling/deduplication.md)
- [Data Quality Monitoring](data-quality-monitoring.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
- [Monitoring and Alerting](../operations/monitoring-and-alerting.md)
