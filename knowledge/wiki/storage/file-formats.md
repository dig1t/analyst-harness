---
tags: [scraping, storage, file-formats, parquet, jsonl]
aliases: [CSV, JSONL, JSON Lines, NDJSON, Parquet, Avro, Arrow, data file formats]
---

# File Formats for Scraped Data

> Sources: IETF RFC 4180, Common Format and MIME Type for CSV Files (https://www.rfc-editor.org/rfc/rfc4180); JSON Lines (https://jsonlines.org/); Apache Parquet documentation (https://parquet.apache.org/docs/); Apache Avro documentation and specification (https://avro.apache.org/docs/); Apache Arrow, Reading and Writing the Apache Parquet Format (https://arrow.apache.org/docs/python/parquet.html); DuckDB documentation, Parquet files (https://duckdb.org/docs/stable/data/parquet/overview); Python documentation, csv module (https://docs.python.org/3/library/csv.html); OWASP, CSV Injection (https://owasp.org/www-community/attacks/CSV_Injection)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Choose a format per stage, not per project. **JSONL** (one JSON object per line) is the right default for extraction output: append-only, crash-tolerant, nested, schema-flexible and readable with `head`. **Parquet** is the right home for curated and analytical data: columnar, typed (decimals, time zones, lists, structs), compressed, and fast to filter because readers skip row groups by their statistics. **CSV** is for handing data to spreadsheets and people, never for typed storage. **Avro** fits row-oriented streaming with schema evolution, typically through Kafka. Whatever you choose: serialize dates and decimals explicitly, compress, partition by source and date, avoid thousands of tiny files, and keep raw HTTP responses separately ([Object Storage and Raw Archives](object-storage-and-raw-archives.md)).

## Comparison

| Format | Layout | Schema | Types | Nested | Appendable | Compression | Best for |
|---|---|---|---|---|---|---|---|
| CSV | Rows of text | Header row only | None (everything is a string) | No | Yes | External (`.gz`, `.zst`) | Spreadsheets, interchange |
| JSON document | One value | None | JSON types | Yes | No (rewrite the file) | External | Small configs, single API responses |
| JSONL / NDJSON | One JSON value per line | Implicit | JSON types; no date or decimal | Yes | Yes | External; gzip members concatenate | Raw extraction output, logs, LLM batch files |
| Parquet | Columnar row groups | Embedded, typed | Rich logical types | Yes | No (add files to a dataset) | Built in, per column | Analytics, curated datasets, data lakes |
| Avro | Binary row blocks | Embedded JSON schema | Rich logical types | Yes | Yes | Built in, per block | Streaming, Kafka, schema evolution |
| Arrow IPC (Feather) | Columnar, in-memory layout | Embedded | Rich | Yes | Limited | LZ4 or ZSTD | Fast exchange between processes |
| SQLite database | B-tree tables | Database schema | SQLite types | As JSON text | Yes, transactional | No | Local working store ([SQLite and DuckDB](sqlite-and-duckdb.md)) |
| Excel (`.xlsx`) | Sheets | None | Cell types, guessed | No | No | Zip container | Final delivery to business users |

## JSONL for extraction output

The JSON Lines convention: UTF-8, one valid JSON value per line, lines separated by `\n`. JSON has no date or decimal type, so serialize them deliberately instead of relying on `default=str`:

```python
import json
from datetime import datetime, timezone
from decimal import Decimal

def to_json(o):
    if isinstance(o, datetime):
        return o.isoformat()                 # 2025-02-01T10:00:00+00:00
    if isinstance(o, Decimal):
        return str(o)                        # keep money exact: "19.99"
    raise TypeError(f"not JSON serializable: {type(o).__name__}")

records = [
    {"source": "shopA", "source_id": "007", "name": "Kettle", "price": Decimal("19.99"),
     "fetched_at": datetime(2025, 2, 1, 10, tzinfo=timezone.utc), "tags": ["kitchen", "sale"]},
    {"source": "shopA", "source_id": "T-01", "name": "Toaster, \"deluxe\"", "price": None,
     "fetched_at": datetime(2025, 2, 1, 10, 5, tzinfo=timezone.utc), "tags": []},
]

with open("items.jsonl", "a", encoding="utf-8") as f:
    for r in records:
        f.write(json.dumps(r, ensure_ascii=False, default=to_json) + "\n")
```

A crash leaves at most one truncated last line, which readers can detect and skip. Gzip files can be appended to as well: concatenated gzip members form a valid stream, so `gzip.open(path, "at")` per batch works, and DuckDB, pandas, polars and `zcat` all read the result as one file. DuckDB (`read_json_auto`), polars (`read_ndjson`, `scan_ndjson`) and pandas (`read_json(..., lines=True)`) read JSONL directly, compressed or not.

## Parquet for curated data

A Parquet file holds row groups; each row group stores one column chunk per column, split into pages; the footer holds the schema and per-chunk statistics (min, max, null count). Readers fetch only the columns a query needs and skip row groups whose statistics cannot match the filter. Files are immutable: "appending" means writing another file into a dataset directory.

```python
from decimal import Decimal
import pyarrow as pa
import pyarrow.parquet as pq

schema = pa.schema([
    ("source", pa.string()),
    ("source_id", pa.string()),                       # ids are strings: "007" must stay "007"
    ("name", pa.string()),
    ("price", pa.decimal128(12, 2)),
    ("fetched_at", pa.timestamp("us", tz="UTC")),
    ("tags", pa.list_(pa.string())),
])
table = pa.Table.from_pylist(records, schema=schema)
pq.write_table(table, "items.parquet", compression="zstd")

meta = pq.ParquetFile("items.parquet").metadata
print(meta.num_rows, meta.num_row_groups, meta.row_group(0).column(3).statistics.max)   # 2 1 19.99

subset = pq.read_table("items.parquet", columns=["source_id", "price"],
                       filters=[("price", ">", Decimal("10"))])                       # projection + pushdown
pq.write_to_dataset(table, root_path="curated", partition_cols=["source"])             # curated/source=shopA/...
```

The same with DuckDB, which converts JSONL to partitioned Parquet in one statement:

```sql
COPY (
    SELECT *, CAST(fetched_at AS DATE) AS dt
    FROM read_json_auto('items.jsonl')
) TO 'curated_by_day' (FORMAT parquet, PARTITION_BY (source, dt), COMPRESSION zstd);

SELECT source, dt, count(*)
FROM read_parquet('curated_by_day/**/*.parquet', hive_partitioning = true)
WHERE dt = DATE '2025-02-01'
GROUP BY ALL;
```

Size files sensibly: many readers and object stores pay a per-file cost, so thousands of kilobyte-sized files are far slower than a few files of tens to hundreds of megabytes. Compact small daily outputs into larger files on a schedule.

## CSV for people

RFC 4180 CSV quotes fields that contain commas, quotes or line breaks and doubles embedded quotes; Python's `csv` module does this when the file is opened with `newline=""`. For files people will open in a spreadsheet, also write a BOM (`utf-8-sig`) so Excel detects UTF-8, and neutralize formula injection: text cells starting with `=`, `+`, `-`, `@`, tab or carriage return can execute as formulas.

```python
import csv

FORMULA_START = ("=", "+", "-", "@", "\t", "\r")
TEXT_FIELDS = {"source", "source_id", "name"}

def spreadsheet_safe(value) -> str:
    text = "" if value is None else str(value)
    return "'" + text if text.startswith(FORMULA_START) else text

with open("items.csv", "w", encoding="utf-8-sig", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["source", "source_id", "name", "price"], extrasaction="ignore")
    w.writeheader()
    for r in records:
        w.writerow({k: spreadsheet_safe(r.get(k)) if k in TEXT_FIELDS else r.get(k) for k in w.fieldnames})
```

Spreadsheets also strip leading zeros (`007` becomes `7`), render long ids in scientific notation, reinterpret dates, and in many European locales expect `;` as the delimiter. CSV cannot distinguish an empty string from a missing value. When reading CSV programmatically, declare types (`read_csv(..., all_varchar = true)` or explicit `columns` in DuckDB, `dtype=` in pandas).

## Avro for streams

An Avro object container file starts with a header holding the JSON schema and codec, followed by blocks separated by sync markers, so it is appendable and splittable. Readers resolve the writer's schema against their own: new fields need defaults, and aliases support renames.

```python
import fastavro

avro_schema = fastavro.parse_schema({
    "type": "record", "name": "Item", "namespace": "scrape",
    "fields": [
        {"name": "source", "type": "string"},
        {"name": "source_id", "type": "string"},
        {"name": "price", "type": ["null", {"type": "bytes", "logicalType": "decimal", "precision": 12, "scale": 2}], "default": None},
        {"name": "fetched_at", "type": {"type": "long", "logicalType": "timestamp-micros"}},
    ],
})
with open("items.avro", "wb") as f:
    fastavro.writer(f, avro_schema, records, codec="deflate")
with open("items.avro", "rb") as f:
    print(next(iter(fastavro.reader(f))))
```

## Layout conventions

- Partition by source and ingestion date: `curated/source=shopA/dt=2025-02-01/part-0001.parquet`.
- Carry provenance columns in every record: `source_url`, `fetched_at`, `run_id`, `parser_version`, `raw_ref` ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).
- Write to a temporary name and rename when complete, so readers never see half-written files.
- Raw data is append-only; curated files can always be rebuilt from raw.

## Pitfalls

- **Type coercion on read.** `pandas.read_json` turned the string price `"19.99"` into a float and parsed `fetched_at` because of its name; pass `dtype=False` or explicit dtypes. DuckDB kept the price as `VARCHAR`.
- **Floats for money.** Store `Decimal` in Parquet (`decimal128`) and strings in JSON.
- **Naive timestamps.** Write timezone-aware UTC (`timestamp(..., tz="UTC")`); naive values are ambiguous forever.
- **Schema drift in JSONL.** A field that is a string on one page and a number on the next makes inference produce `VARCHAR` or unions. Validate at write time ([Schema Validation](../data-quality/schema-validation.md)).
- **Expecting Parquet appends.** There are none; write new files and compact.
- **Excel as storage.** It silently rewrites ids, dates and numbers. Deliver Excel, never read it back as a source of truth.

## Checklist

- [ ] JSONL for raw extraction output, with explicit datetime and decimal serialization.
- [ ] Parquet with an explicit schema for curated data; zstd compression; sensible file sizes.
- [ ] CSV only for people: BOM, formula neutralization, ids as text.
- [ ] Partitioned paths, provenance columns, atomic writes.
- [ ] Readers declare types instead of trusting inference.

## See Also

- [SQLite and DuckDB](sqlite-and-duckdb.md)
- [Object Storage and Raw Archives](object-storage-and-raw-archives.md)
- [Data Modeling for Scraped Data](data-modeling-for-scraped-data.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Schema Validation](../data-quality/schema-validation.md)
