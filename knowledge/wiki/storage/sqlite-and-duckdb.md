---
tags: [scraping, storage, sqlite, duckdb, sql]
aliases: [SQLite, DuckDB, embedded database, local analytics, OLAP, WAL]
---

# SQLite and DuckDB

> Sources: SQLite, Appropriate Uses For SQLite (https://www.sqlite.org/whentouse.html); SQLite, Write-Ahead Logging (https://www.sqlite.org/wal.html); SQLite, UPSERT (https://www.sqlite.org/lang_upsert.html); SQLite, JSON Functions (https://www.sqlite.org/json1.html); SQLite, STRICT Tables (https://www.sqlite.org/stricttables.html); Python documentation, sqlite3 (https://docs.python.org/3/library/sqlite3.html); DuckDB documentation (https://duckdb.org/docs/stable/); DuckDB Python API (https://duckdb.org/docs/stable/clients/python/overview); DuckDB, JSON (https://duckdb.org/docs/stable/data/json/overview)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

SQLite and DuckDB are embedded databases: a library and a single file, no server to run. They complement each other. **SQLite** is row-oriented and transactional, built for many small writes and point lookups, which makes it an excellent working store for a scraper: URL frontier, fetch log, deduplication state and the current version of each item. **DuckDB** is columnar and vectorized, built for scans and aggregations over millions of rows, and it queries JSONL, CSV and Parquet files in place, which makes it the analysis and export engine. A common pipeline: the scraper writes SQLite (or JSONL), DuckDB validates, deduplicates and exports partitioned Parquet, and analysts query the Parquet. Respect the concurrency models: SQLite allows one writer at a time (readers continue under WAL), and a DuckDB file is either open read-write by one process or read-only by several.

## Which one for what

| Aspect | SQLite | DuckDB |
|---|---|---|
| Storage | Row-oriented B-trees | Columnar, compressed |
| Sweet spot | Many small transactions, lookups by key | Scans, aggregations, window functions, large joins |
| Concurrency | Many readers and one writer across processes (WAL) | One read-write process (many threads), or many read-only processes when nobody writes |
| Upsert | `INSERT ... ON CONFLICT DO UPDATE` (3.24+) | `INSERT ... ON CONFLICT DO UPDATE`, `INSERT OR REPLACE` |
| JSON | JSON functions, `->` and `->>` operators (3.38+) | `JSON` type, `read_json_auto`, `->>`, struct and list types |
| External files | Its own database file | Reads and writes Parquet, CSV, JSON; attaches SQLite and PostgreSQL databases |
| Typing | Flexible by default; `STRICT` tables (3.37+) | Static types |
| In a scraper | Frontier, fetch log, state, current items | Analysis, history deduplication, Parquet export, ad hoc questions |

## SQLite as the working store

```python
import json
import sqlite3

con = sqlite3.connect("scrape.db", timeout=30)        # waits up to 30 s on a locked database
con.execute("PRAGMA journal_mode=WAL")                 # readers keep working while one writer commits
con.execute("PRAGMA synchronous=NORMAL")               # safe with WAL, much faster than FULL
con.execute("PRAGMA foreign_keys=ON")

con.executescript("""
CREATE TABLE IF NOT EXISTS fetch_log (
  url            TEXT    NOT NULL,
  fetched_at     TEXT    NOT NULL,           -- ISO 8601 UTC
  status         INTEGER NOT NULL,
  content_sha256 TEXT,
  raw_ref        TEXT,                       -- key of the raw response in object storage
  PRIMARY KEY (url, fetched_at)
) STRICT;

CREATE TABLE IF NOT EXISTS item (
  source     TEXT NOT NULL,
  source_id  TEXT NOT NULL,
  data       TEXT NOT NULL CHECK (json_valid(data)),
  price      REAL GENERATED ALWAYS AS (json_extract(data, '$.price')) VIRTUAL,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  PRIMARY KEY (source, source_id)
) STRICT;
CREATE INDEX IF NOT EXISTS item_price ON item(price);
""")

UPSERT = """
INSERT INTO item (source, source_id, data, first_seen, last_seen)
VALUES (:source, :source_id, :data, :seen, :seen)
ON CONFLICT (source, source_id) DO UPDATE SET
  data = excluded.data,
  last_seen = excluded.last_seen
RETURNING source_id, first_seen, last_seen
"""
batch = [
    {"source": "shopA", "source_id": "K-17", "data": json.dumps({"name": "Kettle", "price": 19.99}), "seen": "2025-02-01T10:00:00Z"},
    {"source": "shopA", "source_id": "K-17", "data": json.dumps({"name": "Kettle", "price": 18.49}), "seen": "2025-02-02T10:00:00Z"},
]
with con:                                   # one transaction per batch: commit on success, roll back on error
    for row in batch:
        print(con.execute(UPSERT, row).fetchall())

print(con.execute("SELECT source_id, data ->> '$.name', price, first_seen, last_seen FROM item").fetchall())
# [('K-17', 'Kettle', 18.49, '2025-02-01T10:00:00Z', '2025-02-02T10:00:00Z')]
```

Notes on this design:

- `STRICT` makes SQLite reject a text value in an `INTEGER` column instead of storing it silently.
- The generated `price` column plus an index makes a JSON field queryable and fast without a separate column to keep in sync.
- `RETURNING` (3.35+) reports what each upsert did; `first_seen` survives updates.
- Keep write transactions short and funnel writes through one thread or process; concurrent writers get `database is locked` after the timeout.
- `REAL` is a float. For money you will sum, store integer minor units or decimal text, and do exact arithmetic downstream.

## DuckDB as the analysis engine

```python
import duckdb

con = duckdb.connect("analytics.duckdb")
con.execute("SET memory_limit = '2GB'")

# Query extraction output in place; glob patterns and compressed files work
con.execute("""
CREATE OR REPLACE TABLE observation AS
SELECT source, source_id, name,
       TRY_CAST(price AS DECIMAL(12, 2)) AS price,
       CAST(fetched_at AS TIMESTAMPTZ)   AS fetched_at
FROM read_json_auto('runs/*.jsonl')
""")

# Latest observation per item
latest = con.sql("""
SELECT * FROM observation
QUALIFY row_number() OVER (PARTITION BY source, source_id ORDER BY fetched_at DESC) = 1
""").df()

# The same idea as an aggregate, plus history statistics
print(con.execute("""
SELECT source_id, arg_max(price, fetched_at) AS last_price,
       min(fetched_at) AS first_seen, max(fetched_at) AS last_seen, count(*) AS n
FROM observation GROUP BY ALL ORDER BY source_id
""").fetchall())

print(con.sql("SUMMARIZE observation").df().loc[:, ["column_name", "column_type", "null_percentage"]])

# pandas DataFrames in scope can be queried by name
print(con.execute("SELECT count(*) FROM latest").fetchone())

# Export partitioned Parquet for everyone else
con.execute("""
COPY (SELECT *, CAST(fetched_at AS DATE) AS dt FROM observation)
TO 'curated' (FORMAT parquet, PARTITION_BY (source, dt), COMPRESSION zstd, OVERWRITE_OR_IGNORE)
""")
```

DuckDB can also read the scraper's SQLite file directly through its `sqlite` extension (downloaded on first use), which avoids an export step:

```sql
INSTALL sqlite;
LOAD sqlite;
ATTACH 'scrape.db' AS lite (TYPE sqlite, READ_ONLY);
SELECT source_id, json_extract_string(data, '$.name') AS name FROM lite.item;
```

For files in S3-compatible storage, the `httpfs` extension and a secret (`CREATE SECRET (TYPE s3, ...)`) let `read_parquet('s3://bucket/curated/**/*.parquet')` run without downloading first ([Object Storage and Raw Archives](object-storage-and-raw-archives.md)).

## Concurrency, durability and backups

- **SQLite WAL.** Readers do not block the writer and the writer does not block readers. WAL needs shared memory on one host, so never put the database on a network file system; the SQLite documentation warns that locking there is unreliable.
- **Checkpoints.** The WAL file grows if readers never pause; run `PRAGMA wal_checkpoint(TRUNCATE)` from maintenance jobs.
- **Backups.** `VACUUM INTO 'backup.db'` (3.27+) or the `sqlite3` backup API make consistent copies of a live database; copying the file during writes does not.
- **DuckDB locking.** While one process has the file open read-write, other processes cannot open it, not even read-only. Let the pipeline write, then let dashboards use `duckdb.connect(path, read_only=True)` once it is closed, or have readers query the exported Parquet instead.
- **DuckDB API versions.** In DuckDB 2.0 a relation from `con.sql()` no longer has `fetchone()`; `con.execute(...).fetchone()`, `.fetchall()` and `con.sql(...).df()` work across versions.

## Pitfalls

- **Flexible typing.** Without `STRICT`, SQLite stores `'two hundred'` in an `INTEGER` column. Use `STRICT` tables or validate before writing.
- **Many writers.** Several scraper processes writing one SQLite file serialize and time out. Use one writer with a queue, or one file per worker merged later.
- **Float prices.** `REAL` and JSON numbers are floats; keep exact types for money end to end ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)).
- **Inference surprises.** `read_json_auto` and `read_csv_auto` guess types from a sample; a field that is numeric on early rows and text later can fail or degrade to `VARCHAR`. Pass `columns=` for stable pipelines.
- **Unbounded growth.** A fetch log that stores bodies inline bloats the database; keep bodies in object storage and store keys.

## Checklist

- [ ] SQLite opened with WAL, a busy timeout and short transactions; one writer.
- [ ] `STRICT` tables, explicit keys, indexes on lookup columns; bodies stored outside.
- [ ] DuckDB jobs read raw files in place with declared types and export partitioned Parquet.
- [ ] Readers never open the DuckDB file while the pipeline writes it.
- [ ] Consistent backups with `VACUUM INTO` or the backup API.

## See Also

- [File Formats for Scraped Data](file-formats.md)
- [PostgreSQL for Scraped Data](postgres-for-scraped-data.md)
- [Data Modeling for Scraped Data](data-modeling-for-scraped-data.md)
- [Object Storage and Raw Archives](object-storage-and-raw-archives.md)
- [URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md)
- [Cheap Hosting for Scrapers](../operations/cheap-hosting.md)
