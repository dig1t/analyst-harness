---
tags: [scraping, data-quality, provenance, lineage, metadata]
aliases: [Data provenance, Data lineage, Source tracking, Record provenance]
---

# Provenance and Lineage

> Sources: W3C PROV-O, The PROV Ontology (https://www.w3.org/TR/prov-o/); W3C PROV-DM, The PROV Data Model (https://www.w3.org/TR/prov-dm/); OpenLineage documentation (https://openlineage.io/docs/); IIPC, The WARC Format 1.1 (https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/); Gebru et al., "Datasheets for Datasets" (https://arxiv.org/abs/1803.09010); Regulation (EU) 2016/679, GDPR, Articles 14, 15 and 30 (https://eur-lex.europa.eu/eli/reg/2016/679/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Every scraped record should be able to answer four questions: **where did this come from** (exact URL, after redirects), **when** (fetch time in UTC), **how** (fetcher, parser and extraction method, with versions) and **from which bytes** (a hash and a pointer to the archived raw response). That is **provenance**. **Lineage** connects those records through the pipeline: which run read which inputs and wrote which outputs. Together they let you debug a bad value back to the page that produced it, re-parse history when a parser improves, honour data protection requests that require knowing a person's data and its source, cite sources in analyses and LLM answers, and show what terms and robots.txt rules applied when the data was collected.

## Minimum provenance per record

| Field | Example | Why |
|---|---|---|
| `requested_url` | `http://shop.example/p/ab-2` | What the crawler asked for |
| `final_url` | `https://shop.example/p/ab-2` | Where content actually came from after redirects |
| `fetched_at` | `2026-10-24T08:00:00Z` | When; set by the fetcher in UTC, never by the parser |
| `http_status`, `content_type` | `200`, `text/html; charset=utf-8` | Detect soft errors and wrong content |
| `etag`, `last_modified` | from response headers | Conditional requests and change evidence |
| `raw_sha256` | `0ebd0d1c...` | Integrity, deduplication, exact-bytes reference |
| `raw_uri` | `raw/shop.example/2026/10/24/<sha>.html.gz` | Re-parse and audit |
| `parser` | `shop-parser@2.3.0+git.3f9c2ab` | Which code produced the values |
| `method` | `css`, `xpath`, `json`, `llm` | How values were extracted |
| `llm_model`, `prompt_sha256` | when `method` is `llm` | Reproducibility of model-based extraction |
| `run_id` | UUID | Join to logs, metrics and lineage events |
| `robots_allowed`, `terms_sha256` | `true`, hash of the terms page | What rules applied at collection time |

For records merged from several sources, keep provenance **per field**, not just per record, so a golden record can say that the phone number came from one directory and the website from the official site ([Record Deduplication and Entity Resolution](record-deduplication-entity-resolution.md)).

## Implementation

A frozen Pydantic model makes provenance mandatory and validated, and content-addressed raw storage makes archiving idempotent: the same bytes always map to the same key.

```python
import gzip
import hashlib
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, HttpUrl


class Provenance(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    requested_url: HttpUrl
    final_url: HttpUrl                       # after redirects
    fetched_at: AwareDatetime                # UTC, from the fetcher
    http_status: int
    content_type: str | None = None
    etag: str | None = None
    raw_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    raw_uri: str                             # where the exact bytes live
    parser: str                              # name@version+commit
    method: Literal["css", "xpath", "json", "llm"]
    llm_model: str | None = None             # set when method == "llm"
    run_id: str
    robots_allowed: bool


def archive_raw(body: bytes, host: str, fetched_at: datetime, root: Path) -> tuple[str, str]:
    """Content-addressed, write-once raw storage: same bytes, same key."""
    digest = hashlib.sha256(body).hexdigest()
    path = root / host / f"{fetched_at:%Y/%m/%d}" / f"{digest}.html.gz"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(gzip.compress(body))
    return digest, path.as_posix()
```

Store records as `{"data": {...}, "provenance": {...}}` or as provenance columns next to the data. In object storage, the same key layout works with an `s3://` or `r2://` prefix ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

## Raw archives and WARC

For large crawls, the WARC format (ISO 28500, used by web archives and Common Crawl) stores requests, responses and metadata together. Its record headers map directly onto provenance fields: `WARC-Target-URI` (URL), `WARC-Date` (fetch time), `WARC-Payload-Digest` (content hash), `WARC-Record-ID` (unique id) and `WARC-Type` (`request`, `response`, `metadata`). Pointing `raw_uri` at a WARC file plus offset gives the same re-parse capability as one file per page, with far fewer objects. See [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md).

## Lineage across the pipeline

Record-level provenance says where a value came from; lineage says how datasets relate. The W3C PROV model gives the vocabulary:

| PROV concept | In a scraping pipeline |
|---|---|
| Entity | Raw response, extracted record, dataset version |
| Activity | Fetch, parse, normalize, load (one run) |
| Agent | The scraper and its version, the operating organisation |
| `used` | The parse activity used the raw response |
| `wasGeneratedBy` | The record was generated by the parse activity |
| `wasDerivedFrom` | The record was derived from the raw response |
| `wasAttributedTo` | The raw response is attributed to the source site |

OpenLineage applies the same idea to jobs: each run emits events naming the job, the run id, and input and output datasets, which tools such as Marquez can collect and graph. An abridged event:

```json
{
  "eventType": "COMPLETE",
  "eventTime": "2026-10-24T08:05:12Z",
  "run": {"runId": "0e7d4f6c-3b6a-4d7e-9a77-1f0c2b9d5a10"},
  "job": {"namespace": "scrapers", "name": "shop_example.products"},
  "inputs": [{"namespace": "https://shop.example", "name": "/category/kettles"}],
  "outputs": [{"namespace": "sqlite://analytics.db", "name": "listings"}],
  "producer": "https://example.org/analyst-harness"
}
```

Use the same `run_id` in record provenance, structured logs and metrics so any one of them leads to the others ([Logging and Observability](../operations/logging-and-observability.md)).

## What provenance is used for

- **Debugging:** a wrong price leads to the run, the raw bytes and the parser version that produced it.
- **Reprocessing:** select raw captures by `parser` version and re-run extraction after a fix ([Data Cleaning Pipeline](data-cleaning-pipeline.md)).
- **Change evidence:** compare `raw_sha256` and record fingerprints across fetches ([Change Detection and Diffing](change-detection-and-diffing.md)).
- **Data protection:** the GDPR requires telling people the source of personal data not collected from them (Article 14(2)(f)) and giving any available information about the source on request (Article 15(1)(g)); controllers also keep records of processing (Article 30). Deletion requests need to find every record and raw capture for a person ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- **Citation:** analyses and agent answers cite `final_url` and `fetched_at`, so readers can check the source and its age.
- **Dataset documentation:** a datasheet (Gebru et al.) summarizing sources, collection dates, terms and known gaps is easy to generate when provenance exists per record.

## Pitfalls

- **Only the start URL.** Redirects, canonical URLs and pagination mean the content often came from somewhere else.
- **Local or parser-generated timestamps.** Use the fetcher's UTC time; reprocessing must not change `fetched_at`.
- **No parser version,** so you cannot tell which records a bug affected.
- **Overwriting raw captures** instead of writing content-addressed, immutable objects.
- **Batch-level provenance for merged records,** which hides which source supplied each field.
- **Keeping raw data forever.** Raw pages contain personal data you chose not to extract; set retention, which conflicts with re-parsing only if you let it.
- **Secrets in provenance.** Do not store cookies, tokens or authorization headers with the record.

## Checklist

- [ ] Every record carries requested URL, final URL, UTC fetch time, status and content type.
- [ ] Raw bytes archived immutably with a SHA-256 hash and a resolvable `raw_uri`.
- [ ] Parser name, version and commit, plus extraction method (and model id for LLM extraction), recorded.
- [ ] `run_id` shared by records, logs, metrics and lineage events.
- [ ] Terms and robots.txt snapshots referenced from each run.
- [ ] Per-field provenance kept for merged or golden records.
- [ ] Retention policy for raw captures; personal data findable by subject for access and deletion.

## See Also

- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
- [Data Cleaning Pipeline](data-cleaning-pipeline.md)
- [Change Detection and Diffing](change-detection-and-diffing.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
- [Logging and Observability](../operations/logging-and-observability.md)
- [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)
