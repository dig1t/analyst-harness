---
tags: [scraping, data-quality, deduplication, entity-resolution, fuzzy-matching]
aliases: [Record linkage, Entity resolution, Fuzzy matching, Record deduplication, Golden record]
---

# Record Deduplication and Entity Resolution

> Sources: Fellegi and Sunter, "A Theory for Record Linkage", Journal of the American Statistical Association 64(328), 1969 (https://doi.org/10.1080/01621459.1969.10501049); Peter Christen, Data Matching, Springer 2012 (https://doi.org/10.1007/978-3-642-31164-2); RapidFuzz documentation (https://rapidfuzz.github.io/RapidFuzz/); Splink documentation (https://moj-analytical-services.github.io/splink/); dedupe library documentation (https://docs.dedupe.io/); python-phonenumbers (https://github.com/daviddrysdale/python-phonenumbers)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scraped datasets contain three kinds of duplication: the **same record seen twice** (overlapping pages, retries, re-runs), **near duplicates within a source** (relisted items, variant pages) and the **same real-world entity across sources** ("Joe's Café & Bakery LLC" on one directory, "Joes Cafe and Bakery" on another). The first is solved with normalized keys and idempotent upserts. The other two are **entity resolution** (record linkage): normalize, build candidate pairs with **blocking**, score them with fuzzy comparisons, classify into match, review and non-match, **cluster** matches, then build a golden record with field-level provenance. Page-level duplicate detection (hashing, SimHash, MinHash) is covered in [Deduplication (URLs and Content)](../crawling/deduplication.md).

## The pipeline

1. **Normalize** each field into a matching key (separate from the display value).
2. **Exact-key dedupe** for records that share a reliable identifier.
3. **Block:** generate candidate pairs only among records sharing a cheap key.
4. **Compare:** compute similarity per field (names, phones, domains, addresses, geo distance).
5. **Classify:** combine evidence into a score; thresholds give match, review and non-match.
6. **Cluster:** merge transitive matches with union-find.
7. **Survivorship:** pick each field's value for the golden record and record where it came from.
8. **Evaluate:** measure precision and recall on labeled pairs; review the uncertain band.

## Normalized matching keys

Keys strip what varies between sources and nothing else. Never overwrite the display value with the key.

```python
import re, unicodedata
from urllib.parse import urlsplit
import phonenumbers

LEGAL_SUFFIXES = {"inc", "llc", "ltd", "limited", "gmbh", "sa", "sl", "srl", "bv", "plc", "corp", "co"}

def name_key(name: str) -> str:
    s = unicodedata.normalize("NFKD", name.casefold())
    s = "".join(c for c in s if not unicodedata.combining(c))  # strip accents
    s = re.sub(r"['\u2019]", "", s).replace("&", " and ")
    s = re.sub(r"[^\w\s]", " ", s)
    return " ".join(t for t in s.split() if t not in LEGAL_SUFFIXES)

def phone_key(raw: str | None, region: str = "US") -> str | None:
    if not raw:
        return None
    try:
        num = phonenumbers.parse(raw, region)
    except phonenumbers.NumberParseException:
        return None
    if not phonenumbers.is_valid_number(num):
        return None
    return phonenumbers.format_number(num, phonenumbers.PhoneNumberFormat.E164)

def domain_key(url: str | None) -> str | None:
    if not url:
        return None
    host = urlsplit(url if "://" in url else f"http://{url}").hostname or ""
    return host.removeprefix("www.") or None

assert name_key("Joe's Café & Bakery LLC") == name_key("Joes Cafe and Bakery") == "joes cafe and bakery"
assert phone_key("(415) 555-0132") == phone_key("+1 415-555-0132") == "+14155550132"
```

The same key in a Node scraper must produce identical output, or cross-language joins silently fail. Test both implementations against shared fixtures:

```typescript
const LEGAL_SUFFIXES = new Set(["inc", "llc", "ltd", "limited", "gmbh", "sa", "sl", "srl", "bv", "plc", "corp", "co"]);

export function nameKey(name: string): string {
  return name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/ß/g, "ss") // toLowerCase is not casefold; cover the most common gap
    .replace(/\p{M}/gu, "") // drop combining marks (accents)
    .replace(/['\u2019]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}_\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !LEGAL_SUFFIXES.has(t))
    .join(" ");
}
```

## Exact duplicates

Keep one row per natural key, usually the latest observation, in SQL that works on PostgreSQL, DuckDB and SQLite:

```sql
SELECT * FROM (
  SELECT o.*, ROW_NUMBER() OVER (PARTITION BY source, natural_key ORDER BY fetched_at DESC) AS rn
  FROM observations AS o
) AS ranked
WHERE rn = 1;
```

Better still, prevent them at load time with keyed upserts ([Data Cleaning Pipeline](data-cleaning-pipeline.md)).

## Blocking, scoring and clustering

Comparing every pair is quadratic: 100,000 records make about 5 billion pairs. Blocking compares only records that share at least one cheap key (same postcode and name initial, same phone, same domain). Scores combine field evidence, including **negative** evidence such as different postcodes.

```python
from collections import defaultdict
from itertools import combinations
from rapidfuzz import fuzz
from rapidfuzz.distance import JaroWinkler

def prepare(rec: dict) -> dict:
    return {**rec, "_name": name_key(rec["name"]), "_phone": phone_key(rec.get("phone")),
            "_domain": domain_key(rec.get("website")), "_zip": (rec.get("zip") or "")[:5]}

def candidate_pairs(recs: list[dict]) -> set[tuple[int, int]]:
    blocks = defaultdict(set)
    for i, r in enumerate(recs):
        if r["_zip"] and r["_name"]:
            blocks[("zip+initial", r["_zip"], r["_name"][0])].add(i)
        if r["_phone"]:
            blocks[("phone", r["_phone"])].add(i)
        if r["_domain"]:
            blocks[("domain", r["_domain"])].add(i)
    return {pair for members in blocks.values() for pair in combinations(sorted(members), 2)}

def score(a: dict, b: dict) -> float:
    name = max(fuzz.token_sort_ratio(a["_name"], b["_name"]) / 100,
               JaroWinkler.normalized_similarity(a["_name"], b["_name"]))
    s = 0.6 * name
    s += 0.25 if a["_phone"] and a["_phone"] == b["_phone"] else 0.0
    s += 0.15 if a["_domain"] and a["_domain"] == b["_domain"] else 0.0
    if a["_zip"] and b["_zip"] and a["_zip"] != b["_zip"]:
        s -= 0.3  # strong evidence against
    return round(s, 3)

class UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))
    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x
    def union(self, a: int, b: int) -> None:
        self.parent[self.find(a)] = self.find(b)

def resolve(raw: list[dict], match_at: float = 0.80, review_at: float = 0.65):
    recs = [prepare(r) for r in raw]
    uf, review = UnionFind(len(recs)), []
    for i, j in sorted(candidate_pairs(recs)):
        s = score(recs[i], recs[j])
        if s >= match_at:
            uf.union(i, j)
        elif s >= review_at:
            review.append((raw[i]["id"], raw[j]["id"], s))  # send to a human or an LLM judge
    clusters = defaultdict(list)
    for i, r in enumerate(raw):
        clusters[uf.find(i)].append(r["id"])
    return sorted(clusters.values()), review

data = [
    {"id": "a1", "name": "Joe's Café & Bakery LLC", "phone": "(415) 555-0132", "website": "https://www.joescafe.example/", "zip": "94107"},
    {"id": "b7", "name": "Joes Cafe and Bakery", "phone": "+1 415-555-0132", "website": "joescafe.example", "zip": "94107-2201"},
    {"id": "c3", "name": "Joe's Coffee", "phone": None, "website": None, "zip": "94107"},
    {"id": "d9", "name": "Joe's Café & Bakery", "phone": None, "website": None, "zip": "10001"},
]
clusters, review = resolve(data)
print(clusters)  # a1 and b7 merge; c3 and d9 stay separate
print(review)    # empty: no pair landed in the review band
```

The weights above are hand-tuned. The **Fellegi-Sunter** model formalizes them: for each field, estimate m (probability of agreement among true matches) and u (among non-matches); agreement adds log2(m/u) to the score and disagreement adds log2((1-m)/(1-u)). Splink implements this at scale with blocking rules and unsupervised estimation; dedupe learns weights from labeled examples through active learning.

## Survivorship: building the golden record

```python
SOURCE_TRUST = {"official_site": 3, "directory_a": 2, "directory_b": 1}

def golden_record(members: list[dict], fields=("name", "phone", "website", "zip")) -> dict:
    """Per field: most trusted source wins, then the most recent observation."""
    out, provenance = {}, {}
    for field in fields:
        candidates = [m for m in members if m.get(field)]
        if not candidates:
            continue
        best = max(candidates, key=lambda m: (SOURCE_TRUST.get(m["source"], 0), m["seen_at"]))
        out[field] = best[field]
        provenance[field] = {"source": best["source"], "record_id": best["id"], "seen_at": best["seen_at"]}
    return {**out, "_provenance": provenance, "_members": sorted(m["id"] for m in members)}
```

Store cluster membership separately from source records so merges can be undone, and keep per-field provenance ([Provenance and Lineage](provenance-and-lineage.md)).

## Evaluating and tuning

- Label a few hundred candidate pairs, stratified by score, and compute precision and recall at each threshold.
- Choose thresholds by cost: a false merge (two shops become one) is usually worse than a missed merge.
- Keep a **review band** between the thresholds; route it to a human or an LLM judge with the evidence shown, and feed decisions back as labels.
- Track cluster size distribution: a sudden giant cluster means a key collapsed (for example, every record got the same empty phone key).

## Pitfalls

- **`token_set_ratio` subset trap.** RapidFuzz scores "bank" against "bank of america" at 100 with `token_set_ratio` because one token set contains the other; prefer `token_sort_ratio` or require supporting evidence.
- **Transitive chaining.** A matches B, B matches C, so A and C merge even if they share nothing. Inspect large clusters and consider requiring a minimum link strength.
- **Shared identifiers.** Chains share websites; call centers share phone numbers; franchises share names. Add location evidence.
- **Over-normalization.** Removing too many tokens ("the", "and", numbers) merges distinct entities such as "Store 12" and "Store 21".
- **Empty keys colliding.** Never block or match on empty strings or default values.
- **Irreversible merges.** Overwriting source rows makes errors permanent.
- **Different key logic in different languages.** Python's `casefold` and JavaScript's `toLowerCase` differ for some characters; test parity.

## Checklist

- [ ] Matching keys computed separately from display values, with parity tests across languages.
- [ ] Exact duplicates prevented by keyed upserts.
- [ ] Blocking keys chosen so that true matches almost always share one.
- [ ] Negative evidence (different postcode, different country) included in scoring.
- [ ] Thresholds set from labeled pairs; review band routed for decisions.
- [ ] Clusters stored as reversible mappings; golden record keeps per-field provenance.
- [ ] Cluster size and merge counts monitored per run.

## See Also

- [Deduplication (URLs and Content)](../crawling/deduplication.md)
- [Data Cleaning Pipeline](data-cleaning-pipeline.md)
- [Change Detection and Diffing](change-detection-and-diffing.md)
- [Provenance and Lineage](provenance-and-lineage.md)
- [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)
- [URL Normalization and Canonicalization](../crawling/url-normalization.md)
