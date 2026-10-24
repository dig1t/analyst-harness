---
tags: [scraping, storage, postgres, sql, upsert]
aliases: [PostgreSQL, Postgres, upsert, ON CONFLICT, JSONB, MERGE, table partitioning]
---

# PostgreSQL for Scraped Data

> Sources: PostgreSQL documentation: INSERT and ON CONFLICT (https://www.postgresql.org/docs/current/sql-insert.html); MERGE (https://www.postgresql.org/docs/current/sql-merge.html); JSON Types (https://www.postgresql.org/docs/current/datatype-json.html); JSON Functions and Operators (https://www.postgresql.org/docs/current/functions-json.html); GIN Indexes (https://www.postgresql.org/docs/current/gin.html); BRIN Indexes (https://www.postgresql.org/docs/current/brin.html); Table Partitioning (https://www.postgresql.org/docs/current/ddl-partitioning.html); COPY (https://www.postgresql.org/docs/current/sql-copy.html); Generated Columns (https://www.postgresql.org/docs/current/ddl-generated-columns.html); psycopg 3, Using COPY TO and COPY FROM (https://www.psycopg.org/psycopg3/docs/basic/copy.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

PostgreSQL is the default server database for production scraping: many concurrent writers, real transactions, exact `numeric`, `timestamptz`, `jsonb`, arrays and ranges, and an atomic upsert. The core patterns: key items by the source's own identifier, keep a current-state table maintained with `INSERT ... ON CONFLICT DO UPDATE`, compare content hashes so only real changes count as changes, append every observation to a time-partitioned table with a BRIN index, keep the long tail of fields in `jsonb` with a GIN index, and bulk-load with `COPY` into a staging table followed by an upsert or `MERGE`. Deduplicate each batch before upserting, avoid rewriting unchanged rows, and implement retention by dropping partitions rather than deleting rows. Statements below were run on PostgreSQL 18; version requirements are noted where they matter.

## Schema

```sql
-- Current state: one row per item, updated in place
CREATE TABLE item (
  source       text        NOT NULL,
  source_id    text        NOT NULL,              -- the site's own id, not the URL
  url          text        NOT NULL,
  name         text,
  price        numeric(12,2),
  currency     char(3),                           -- ISO 4217
  data         jsonb       NOT NULL DEFAULT '{}', -- long-tail attributes
  content_hash bytea       NOT NULL,              -- sha256 of the canonical record
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  last_changed timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);

-- History: append-only, partitioned by time
CREATE TABLE observation (
  source      text        NOT NULL,
  source_id   text        NOT NULL,
  observed_at timestamptz NOT NULL,
  price       numeric(12,2),
  data        jsonb       NOT NULL,
  fetch_id    uuid,
  PRIMARY KEY (source, source_id, observed_at)   -- must include the partition key
) PARTITION BY RANGE (observed_at);

CREATE TABLE observation_2025_02 PARTITION OF observation
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE observation_2025_03 PARTITION OF observation
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE INDEX observation_observed_brin ON observation USING brin (observed_at);
CREATE INDEX item_data_gin ON item USING gin (data jsonb_path_ops);
```

A primary key or unique constraint on a partitioned table must include the partition column; PostgreSQL rejects `id bigint PRIMARY KEY` on a table partitioned by `observed_at`.

## Upsert with change tracking

```python
import hashlib
import json
from datetime import datetime, timezone
import psycopg
from psycopg.types.json import Jsonb

def content_hash(record: dict) -> bytes:
    """Hash a canonical serialization so key order and whitespace never count as changes."""
    canonical = json.dumps(record, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).digest()

UPSERT = """
INSERT INTO item AS i (source, source_id, url, name, price, currency, data, content_hash,
                       first_seen, last_seen, last_changed)
VALUES (%(source)s, %(source_id)s, %(url)s, %(name)s, %(price)s, %(currency)s, %(data)s,
        %(hash)s, %(seen)s, %(seen)s, %(seen)s)
ON CONFLICT (source, source_id) DO UPDATE SET
  url = EXCLUDED.url, name = EXCLUDED.name, price = EXCLUDED.price, currency = EXCLUDED.currency,
  data = EXCLUDED.data, content_hash = EXCLUDED.content_hash, last_seen = EXCLUDED.last_seen,
  last_changed = CASE WHEN i.content_hash IS DISTINCT FROM EXCLUDED.content_hash
                      THEN EXCLUDED.last_seen ELSE i.last_changed END
"""

def save_batch(conn: psycopg.Connection, records: list[dict]) -> None:
    seen = datetime.now(timezone.utc)
    latest = {(r["source"], r["source_id"]): r for r in records}      # dedupe: last one wins
    params = [{**r, "data": Jsonb(r.get("attrs", {})), "hash": content_hash(r), "seen": seen}
              for r in latest.values()]
    with conn.transaction(), conn.cursor() as cur:
        cur.executemany(UPSERT, params)

with psycopg.connect("postgresql://scraper@localhost/scrape") as conn:
    save_batch(conn, [{"source": "shopA", "source_id": "K-17", "url": "https://a.example/k17",
                       "name": "Kettle", "price": "19.99", "currency": "EUR", "attrs": {"brand": "Acme"}}])
```

- `EXCLUDED` is the row proposed for insertion; columns not listed in `SET` (here `first_seen`) keep their stored value.
- The PostgreSQL documentation guarantees an atomic insert-or-update outcome for `ON CONFLICT DO UPDATE`, even with concurrent writers.
- `IS DISTINCT FROM` treats NULLs as comparable values, unlike `<>`.
- A statement may not touch the same row twice: two rows with the same key in one `VALUES` list or `INSERT ... SELECT` fail with "ON CONFLICT DO UPDATE command cannot affect row a second time". Hence the deduplication in `save_batch`.
- On PostgreSQL 18, append `RETURNING source_id, (old.content_hash IS DISTINCT FROM new.content_hash) AS changed` to learn which rows really changed; with psycopg call `executemany(UPSERT, params, returning=True)` and read each result via `for _ in cur.results(): cur.fetchall()`.
- To skip writes when nothing changed, add `WHERE i.content_hash IS DISTINCT FROM EXCLUDED.content_hash` to the `DO UPDATE`, and record sightings in `observation` instead of `last_seen`.

For large batches, `COPY` into a temporary staging table is much faster than row-by-row statements:

```python
with conn.transaction(), conn.cursor() as cur:
    cur.execute("CREATE TEMP TABLE stage (LIKE item INCLUDING DEFAULTS) ON COMMIT DROP")
    with cur.copy("COPY stage (source, source_id, url, name, price, currency, data, content_hash, last_seen) FROM STDIN") as copy:
        for p in params:
            copy.write_row((p["source"], p["source_id"], p["url"], p["name"], p["price"],
                            p["currency"], p["data"], p["hash"], p["seen"]))
    cur.execute(MERGE_FROM_STAGE)          # the MERGE below, or INSERT ... SELECT ... ON CONFLICT
```

## Merging a staged batch

```sql
MERGE INTO item AS t
USING stage AS s
  ON t.source = s.source AND t.source_id = s.source_id
WHEN MATCHED AND t.content_hash IS DISTINCT FROM s.content_hash THEN
  UPDATE SET name = s.name, price = s.price, data = s.data, content_hash = s.content_hash,
             last_seen = s.last_seen, last_changed = s.last_seen
WHEN MATCHED THEN
  UPDATE SET last_seen = s.last_seen
WHEN NOT MATCHED THEN
  INSERT (source, source_id, url, name, price, currency, data, content_hash, first_seen, last_seen, last_changed)
  VALUES (s.source, s.source_id, s.url, s.name, s.price, s.currency, s.data, s.content_hash,
          s.last_seen, s.last_seen, s.last_seen)
RETURNING merge_action(), t.source_id;
```

`MERGE` exists since PostgreSQL 15; `RETURNING` with `merge_action()` and `WHEN NOT MATCHED BY SOURCE` arrived in 17. The last clause can mark items missing from a **complete** snapshot of one source (`WHEN NOT MATCHED BY SOURCE AND t.source = 'shopA' THEN UPDATE SET ...`); never use it with a partial crawl. The `MERGE` documentation warns that concurrent inserts into the target can still raise unique violations and points to `INSERT ... ON CONFLICT` when that matters, so run merges from a single job per source.

## JSONB

| Operator | Meaning | Example |
|---|---|---|
| `->`, `->>` | Field as `jsonb`, field as text | `data ->> 'brand'` |
| `#>>` | Path as text | `data #>> '{dims,width}'` |
| `@>` | Contains | `data @> '{"brand": "Acme"}'` |
| `?` | Top-level key exists | `data ? 'gtin'` |
| `@?`, `@@` | SQL/JSON path exists, matches | `data @? '$.tags[*] ? (@ == "sale")'` |

A GIN index with the default `jsonb_ops` class serves `@>`, `?`, `?|`, `?&`, `@?` and `@@`; `jsonb_path_ops` is smaller and faster but serves only `@>`, `@?` and `@@` (a `?` query fell back to a sequential scan in testing). Promote fields you filter or join on to real columns. A generated column keeps one in sync automatically: `brand text GENERATED ALWAYS AS (data ->> 'brand') STORED`. PostgreSQL 18 made `VIRTUAL` the default when neither keyword is given, so write `STORED` when you want the value materialized.

## Indexes

| Index | Use it for |
|---|---|
| B-tree primary key `(source, source_id)` | Upserts and lookups |
| BRIN on `observed_at` | Huge append-only, time-ordered tables; tiny index, range scans |
| GIN on `data` | Containment and JSON path filters |
| GIN with `pg_trgm` (`gin_trgm_ops`) | Fuzzy name search and `ILIKE '%term%'` |
| Partial, `WHERE delisted_at IS NULL` | Queries over active items only |

## Partitions, retention and bloat

- Create partitions ahead of time (a scheduled job or the pg_partman extension). Without a matching partition an insert fails loudly, which is usually what you want. A `DEFAULT` partition catches such rows instead, but it has costs: adding a partition scans the default and fails if it already holds rows for the new range (they are not moved), and `DETACH ... CONCURRENTLY` is refused while a default partition exists.
- Retention is a metadata operation: `ALTER TABLE observation DETACH PARTITION observation_2024_01 CONCURRENTLY;` (PostgreSQL 14+, outside a transaction block, no default partition) followed by `DROP TABLE observation_2024_01;`. `DELETE` on hundreds of millions of rows is slow and bloats the table.
- `ON CONFLICT DO UPDATE` cannot move a row to a different partition by changing its partition key.
- Every `UPDATE` writes a new row version. Touching `last_seen` on every unchanged row every day creates dead tuples, WAL volume and vacuum work. Update only on change, record sightings in the append-only table, and consider a lower `fillfactor` so updates that do not change indexed columns can stay on the same page (HOT updates).
- `COPY ... WITH (FORMAT csv, ON_ERROR ignore)` (PostgreSQL 17+) skips malformed rows during bulk loads; count the skips, do not ignore them.
- `uuidv7()` (PostgreSQL 18) generates time-ordered UUIDs, which index better than random v4 values for fetch and run ids.

## Pitfalls

- **Batches with duplicate keys.** The cardinality error aborts the whole statement; deduplicate first.
- **`timestamp` instead of `timestamptz`.** Store instants as `timestamptz`; naive timestamps lose the zone.
- **Floats for money.** Use `numeric(p, s)` and pass `Decimal` or strings from Python.
- **NULLs in unique keys.** By default NULLs never conflict; `UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15+) makes them collide when that is the intent.
- **Long transactions.** A transaction left open (even idle) stops vacuum from removing dead rows created after it started, across the whole database; keep scraper transactions short and use a connection pool.
- **Treating URLs as identity.** URLs change and carry tracking parameters; key on the source id and keep URLs as attributes ([URL Normalization and Canonicalization](../crawling/url-normalization.md)).

## Checklist

- [ ] Natural key `(source, source_id)` with a primary key; URL stored as an attribute.
- [ ] Upserts deduplicated per batch, hash-based change detection, `first_seen` preserved.
- [ ] Observations append-only, range-partitioned, BRIN-indexed, with partitions created ahead.
- [ ] Hot JSON fields promoted to columns; GIN operator class chosen for the queries you run.
- [ ] Bulk loads via `COPY` into staging; merges run by one job per source.
- [ ] Retention by dropping partitions; vacuum and bloat monitored.

## See Also

- [Data Modeling for Scraped Data](data-modeling-for-scraped-data.md)
- [SQLite and DuckDB](sqlite-and-duckdb.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
- [Queues and Workers](../operations/queues-and-workers.md)
