---
name: sql-analysis
description: Answer analytical questions over scraped datasets with DuckDB SQL (profile, query, cross-check). Use for counts, trends, rankings, distributions and comparisons over files in datasets/ or the workspace.
---

# SQL analysis with DuckDB

## Steps

1. **Find the data.** `glob_files("datasets/**/*.jsonl")` or `list_files("datasets", recursive=true)`.
2. **Profile first.**
   ```sql
   SUMMARIZE SELECT * FROM read_json_auto('datasets/<dataset>/*.jsonl');
   SELECT min(_scraped_at), max(_scraped_at), count(*) FROM read_json_auto('datasets/<dataset>/*.jsonl');
   ```
   Note nulls, types, the time range and duplicates (`count(*)` vs `count(DISTINCT _key)`).
3. **Deduplicate when needed.** Datasets append new and changed versions; take the latest
   version per key:
   ```sql
   CREATE TABLE latest AS
   SELECT * FROM read_json_auto('datasets/<dataset>/*.jsonl')
   QUALIFY row_number() OVER (PARTITION BY _key ORDER BY _scraped_at DESC) = 1;
   ```
4. **Answer the question** with an aggregate query. Keep results small (aggregate in SQL).
5. **Cross-check** the headline number a second way (a different grouping, a manual count of a
   small slice, or a Python script with `bash`).
6. **Save** the queries you relied on to `reports/<topic>.sql` when the answer matters.

## Verification

- The time range and filters behind every number are stated.
- Duplicate versions were handled (or shown not to matter).
- The cross-check agrees, or the difference is explained.
