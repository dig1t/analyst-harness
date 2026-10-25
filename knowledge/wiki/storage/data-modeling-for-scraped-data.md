---
tags: [scraping, storage, data-modeling, scd, history]
aliases: [data modeling, slowly changing dimensions, SCD Type 2, snapshots, append-only observations, bitemporal data, history tables]
---

# Data Modeling for Scraped Data

> Sources: Kimball Group, Dimensional Modeling Techniques (https://www.kimballgroup.com/data-warehouse-business-intelligence-resources/kimball-techniques/dimensional-modeling-techniques/); dbt documentation, Snapshots (https://docs.getdbt.com/docs/build/snapshots); Martin Fowler, Bitemporal History (https://martinfowler.com/articles/bitemporal-history.html); PostgreSQL documentation, Range Types and exclusion constraints (https://www.postgresql.org/docs/current/rangetypes.html); PostgreSQL documentation, btree_gist (https://www.postgresql.org/docs/current/btree-gist.html); DuckDB documentation, FROM clause and joins including ASOF (https://duckdb.org/docs/stable/sql/query_syntax/from)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scraped data is a stream of observations of things that change: prices move, listings appear and vanish, articles get edited. Model it so history is never lost and every value can answer "what did we see, when, and from which fetch". The default that works: an **append-only observation table** at the grain of one entity per fetch, keyed by the source's own identifier; a **content hash** of the business fields so re-sightings are not mistaken for changes; **derived tables** for current state and for versioned history (slowly changing dimension Type 2 with `valid_from` and `valid_to`); and **two time axes**, when you observed something and when the source says it was true. Treat "not seen in this crawl" as missing information, not as deletion. Keep layers separate (raw, staging, core, marts) so everything downstream can be rebuilt from what you stored.

## Layers

| Layer | Contents | Mutability | Rebuilt from |
|---|---|---|---|
| Raw | HTTP responses, WARC files, fetch manifest | Immutable | Nothing: source of truth ([Object Storage and Raw Archives](object-storage-and-raw-archives.md)) |
| Staging | Parser output per fetch, typed and validated, tagged with `parser_version` | Append-only; replaced when re-parsed | Raw |
| Core | Entities, observations, versions, source-to-entity mappings | Append-only facts plus derived versions | Staging |
| Marts | Current state, aggregates, exports | Rebuilt freely | Core |

## Grain and keys

- **State the grain of every table** in one sentence: "one row per (source, source_id, observed_at)". Mixing grains (a crawl summary row inside an item table) breaks every aggregate.
- **Natural keys come from the source**: SKU, listing id, job id, DOI, scoped by `source`. URLs are attributes: they change, carry tracking parameters and multiply through variants ([URL Normalization and Canonicalization](../crawling/url-normalization.md)).
- **No id on the site?** Derive one deterministically (canonical URL or a hash of identifying fields) and document the rule; changing it later re-keys history.
- **Cross-source identity** lives in a mapping table from `(source, source_id)` to a global entity id, maintained by entity resolution ([Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)).

## Ways to keep history

| Pattern | Shape | Answers | Cost | Use when |
|---|---|---|---|---|
| Overwrite (SCD Type 1) | One row per entity, updated in place | Current state only | Smallest | History truly does not matter |
| Full snapshots | Complete copy per crawl, partitioned by date | Exactly what each crawl saw | Largest: unchanged rows repeat | Small datasets, audit replicas |
| Append-only observations | One row per entity per fetch | Everything, including when it was seen | Grows with fetches, compresses well | Default for scraped data |
| Versions (SCD Type 2) | One row per distinct state with `valid_from`, `valid_to` | As-of queries, change history | Compact | Derived from observations for consumers |
| Previous-value column (SCD Type 3) | `price`, `previous_price` | One step back | Tiny | Simple dashboards |

## Observations and content hashes

```sql
CREATE TABLE observation (
  source         VARCHAR     NOT NULL,
  source_id      VARCHAR     NOT NULL,
  observed_at    TIMESTAMPTZ NOT NULL,
  price          DECIMAL(12, 2),
  availability   VARCHAR,
  content_hash   VARCHAR     NOT NULL,   -- hash of the business fields only
  fetch_id       VARCHAR,                -- links to the raw archive manifest
  parser_version VARCHAR
);
```

The hash decides what counts as a change, so build it from the fields that matter, serialized canonically, and leave out volatile noise (fetch time, "14 people are viewing this", rotating recommendations, session tokens):

```python
import hashlib
import json

def business_hash(record: dict, fields: tuple[str, ...]) -> str:
    """Hash only the fields whose change matters, in a canonical serialization."""
    canonical = json.dumps({k: record.get(k) for k in fields}, sort_keys=True,
                           separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

FIELDS = ("price", "availability", "title")
a = {"price": "19.99", "availability": "InStock", "title": "Kettle", "viewers_now": 14}
b = {**a, "viewers_now": 3}
assert business_hash(a, FIELDS) == business_hash(b, FIELDS)   # noise is not a change
```

Version the field list and normalization (`hash_version`): changing either changes every hash at once. Normalize text the same way every time ([Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)).

## Deriving versions (DuckDB)

Collapse consecutive observations with the same hash into one version ("gaps and islands"). A price that goes 19.99, 18.49, 19.99 correctly yields three versions:

```sql
CREATE OR REPLACE TABLE item_version AS
WITH marked AS (
  SELECT *,
         CASE WHEN lag(content_hash) OVER w IS DISTINCT FROM content_hash THEN 1 ELSE 0 END AS is_change
  FROM observation
  WINDOW w AS (PARTITION BY source, source_id ORDER BY observed_at)
),
islands AS (
  SELECT *, sum(is_change) OVER (PARTITION BY source, source_id ORDER BY observed_at) AS version_no
  FROM marked
),
versions AS (
  SELECT source, source_id, version_no,
         any_value(price) AS price, any_value(availability) AS availability,
         any_value(content_hash) AS content_hash,
         min(observed_at) AS valid_from,      -- first sighting of this state
         max(observed_at) AS last_seen_at,    -- last sighting of this state
         count(*)         AS sightings
  FROM islands
  GROUP BY source, source_id, version_no
)
SELECT *, lead(valid_from) OVER (PARTITION BY source, source_id ORDER BY version_no) AS valid_to
FROM versions;
```

The real change happened somewhere between `last_seen_at` of one version and `valid_from` of the next; keeping both makes that uncertainty explicit instead of pretending the change happened at the moment you noticed it. Query the state at a point in time, or join events to the price in force with DuckDB's `ASOF JOIN`:

```sql
SELECT source_id, price
FROM item_version
WHERE valid_from <= TIMESTAMPTZ '2025-02-03 12:00:00+00'
  AND (valid_to IS NULL OR valid_to > TIMESTAMPTZ '2025-02-03 12:00:00+00');

SELECT o.order_id, o.ordered_at, v.price
FROM orders o
ASOF JOIN item_version v
  ON o.source = v.source AND o.source_id = v.source_id AND o.ordered_at >= v.valid_from;
```

## Maintaining versions incrementally (PostgreSQL)

When the version table is the system of record for consumers, maintain it per batch and let constraints guard it:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE item_version (
  source       text        NOT NULL,
  source_id    text        NOT NULL,
  valid_from   timestamptz NOT NULL,
  valid_to     timestamptz,                       -- NULL means current
  price        numeric(12,2),
  content_hash bytea       NOT NULL,
  EXCLUDE USING gist (source WITH =, source_id WITH =, tstzrange(valid_from, valid_to) WITH &&)
);
CREATE UNIQUE INDEX item_version_current ON item_version (source, source_id) WHERE valid_to IS NULL;

-- Per batch, in one transaction; stage holds one latest observation per key
UPDATE item_version v SET valid_to = s.observed_at
FROM stage s
WHERE v.source = s.source AND v.source_id = s.source_id AND v.valid_to IS NULL
  AND v.content_hash IS DISTINCT FROM s.content_hash
  AND v.valid_from < s.observed_at;

INSERT INTO item_version (source, source_id, valid_from, price, content_hash)
SELECT s.source, s.source_id, s.observed_at, s.price, s.content_hash
FROM stage s
WHERE NOT EXISTS (SELECT 1 FROM item_version v
                  WHERE v.source = s.source AND v.source_id = s.source_id AND v.valid_to IS NULL);
```

The exclusion constraint rejects overlapping validity periods for the same item and the partial unique index allows only one open version. PostgreSQL 18 can express the same rule as a temporal key, `PRIMARY KEY (source, source_id, valid WITHOUT OVERLAPS)` on a `tstzrange` column. In dbt-based warehouses, snapshots implement this pattern with a timestamp or check strategy. Details on upserts and partitioning are in [PostgreSQL for Scraped Data](postgres-for-scraped-data.md).

## Two kinds of time

- **Observed time** (`observed_at`): when your fetch saw the value. You know it exactly.
- **Source time**: what the page claims (`datePublished`, "price valid until", the event date, a listing's "updated" stamp).

Keep both. "What did we know on 1 March?" filters on observed time; "what was the price on 1 March?" uses source time where it exists. Re-parsing old raw data creates observations with old `observed_at` values but a new `parser_version`; rebuild derived tables rather than patching them ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

## Disappearance and deletion

An item missing from a crawl may be gone, or the crawl may have failed, been blocked, hit a pagination change or stopped early. Record crawl coverage (which listing pages or sitemap files were completely processed) and mark an item `delisted_at` only after it is absent from N consecutive **complete** crawls, or on an explicit signal such as a 404 or 410 on its own page or a "sold" status ([HTTP Status Codes and How to React](../http/http-status-codes.md)). Store that as an observation (a tombstone with `status = 'gone'`), so a reappearance simply starts a new version.

## Pitfalls

- **URLs as identity.** Tracking parameters, renamed slugs and variants split one item into many.
- **Noisy hashes.** Volatile fields in the hash turn every fetch into a "change" and the version table into a copy of the observation table.
- **Accidental overwrite.** An upsert on the observation table silently converts history into SCD Type 1.
- **Parser changes masquerading as data changes.** A fix that changes extracted values creates fake versions unless you re-derive from re-parsed observations and record `parser_version`.
- **Missing equals deleted.** Partial crawls produce mass "deletions" followed by mass "reappearances".
- **Naive timestamps.** Store `observed_at` as timezone-aware UTC ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)).

## Checklist

- [ ] Every table has a stated grain and a natural key scoped by source.
- [ ] Observations are append-only with `observed_at`, `fetch_id` and `parser_version`.
- [ ] Content hashes cover business fields only, canonicalized and versioned.
- [ ] Versions and current state are derived (or constraint-guarded) and can be rebuilt.
- [ ] Observed time and source time are both stored; deletions require complete-crawl evidence.

## See Also

- [PostgreSQL for Scraped Data](postgres-for-scraped-data.md)
- [Object Storage and Raw Archives](object-storage-and-raw-archives.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [E-commerce and Price Monitoring](../sources/ecommerce-and-prices.md)
