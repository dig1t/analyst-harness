---
tags: [scraping, storage, object-storage, warc, archives]
aliases: [S3, R2, raw archive, raw HTML storage, WARC, content-addressed storage, re-parsing]
---

# Object Storage and Raw Archives

> Sources: Amazon S3 User Guide (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html); Amazon S3, Optimizing performance (https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html); Amazon S3, Managing the lifecycle of objects (https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html); Amazon S3 Object Lock (https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html); Amazon S3 storage classes (https://aws.amazon.com/s3/storage-classes/); boto3, S3 client reference (https://boto3.amazonaws.com/v1/documentation/api/latest/reference/services/s3.html); Cloudflare R2 documentation (https://developers.cloudflare.com/r2/); IIPC, The WARC Format 1.1 (https://iipc.github.io/warc-specifications/specifications/warc-format/warc-1.1/); warcio (https://github.com/webrecorder/warcio)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Keep the raw bytes of every response you parse. Parsers have bugs, sites change and requirements grow; with a raw archive you can re-parse history to fix a bug or add a field without fetching anything again (cheaper and politer), reproduce the exact input behind a bad record, and show what a page said at fetch time. Object storage (Amazon S3, Cloudflare R2, Google Cloud Storage, MinIO) is the natural home: durable, cheap per gigabyte, addressed by key. Store compressed bodies under deterministic keys, record URL, status, headers, fetch time and hash in a manifest table, or bundle records into WARC files when volumes are large or you want a standard format. Then apply lifecycle rules, private access, encryption and a retention policy, because raw pages can contain personal data.

## Why raw archives pay off

| Need | Without raw | With raw |
|---|---|---|
| Parser bug found | Re-crawl everything, or live with bad history | Re-run the fixed parser over stored responses |
| New field wanted | Only from today on | Backfill across all history |
| Bad record investigation | Guesswork | Open the exact bytes the parser saw |
| Audit or dispute | "The site said so" | Timestamped, hashed evidence |
| Tests and LLM evaluation | Hand-made fixtures | Real pages from every template ([Testing Scrapers](../data-quality/testing-scrapers.md)) |

## Two layouts

| Aspect | One object per response, plus manifest | WARC files |
|---|---|---|
| Unit | One compressed body per key | Many request, response and metadata records per file |
| Random access | Trivial, by key | Needs an index of offsets (CDX or CDXJ) |
| Object count | One per fetch (or per unique body) | One per large file, commonly rotated around 1 GB |
| Standard | Your own convention | WARC 1.1 (ISO 28500), used by the Internet Archive and Common Crawl |
| Tooling | Any S3 client, DuckDB, Spark | warcio, pywb replay, Common Crawl tooling |
| Deduplication | Content-addressed keys | `revisit` records |
| Best for | Moderate volumes, simple re-parse jobs | Large crawls, long-term preservation, replay |

## One object per response

Content-addressed keys (the SHA-256 of the body) deduplicate identical responses for free; the manifest records every fetch, including the ones whose body was already stored.

```python
import gzip
import hashlib
import boto3
from botocore.exceptions import ClientError

s3 = boto3.client("s3")   # R2 or MinIO: boto3.client("s3", endpoint_url="https://<account_id>.r2.cloudflarestorage.com")

def archive_response(bucket, source, url, status, headers, body: bytes, fetched_at) -> dict:
    """Store one response body under a content-addressed key and return its manifest row."""
    digest = hashlib.sha256(body).hexdigest()
    key = f"raw/sha256/{digest[:2]}/{digest[2:4]}/{digest}.gz"
    try:
        s3.put_object(
            Bucket=bucket, Key=key, Body=gzip.compress(body),
            ContentType="application/gzip",
            ChecksumAlgorithm="SHA256",          # integrity check on upload
            IfNoneMatch="*",                     # conditional write: never overwrite an existing key
        )
        stored = True
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("PreconditionFailed", "412"):
            raise
        stored = False                           # identical body archived earlier
    return {"source": source, "url": url, "status": status, "fetched_at": fetched_at.isoformat(),
            "sha256": digest, "size": len(body), "key": key, "stored": stored, "headers": dict(headers)}
```

Write the returned rows to the manifest (a database table or daily Parquet files) and put the `key` or a fetch id into every curated record as `raw_ref` ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)). Keep URLs and headers in the manifest rather than in object metadata, which is small (S3 limits user-defined metadata to about 2 KB). With `IfNoneMatch="*"` S3 answers `412 Precondition Failed` when the key exists, which turns "already archived" into a cheap, race-free check; tested here against a mock S3.

Decide what "raw" means and record it: the body as transferred (still gzip or brotli encoded, as WARC response records conventionally hold it) or the decoded body. Store the final URL after redirects and the response headers either way, because the charset and content type are needed to decode the bytes again ([Compression, Encodings and Character Sets](../http/compression-and-encodings.md)).

## WARC files

```python
import io
from warcio.warcwriter import WARCWriter
from warcio.statusandheaders import StatusAndHeaders
from warcio.archiveiterator import ArchiveIterator

def write_response(writer: WARCWriter, url: str, status: int, reason: str, headers: list, body: bytes) -> str:
    http_headers = StatusAndHeaders(f"{status} {reason}", headers, protocol="HTTP/1.1")
    record = writer.create_warc_record(url, "response", payload=io.BytesIO(body), http_headers=http_headers)
    writer.write_record(record)
    return record.rec_headers.get_header("WARC-Record-ID")

with open("fetches.warc.gz", "wb") as fh:
    writer = WARCWriter(fh, gzip=True)                 # each record is its own gzip member
    write_response(writer, "https://shop.example/p/k17", 200, "OK",
                   [("Content-Type", "text/html; charset=utf-8")], b"<html><h1>Kettle</h1></html>")

# Re-parsing later
with open("fetches.warc.gz", "rb") as fh:
    for record in ArchiveIterator(fh):
        if record.rec_type == "response":
            url = record.rec_headers.get_header("WARC-Target-URI")
            fetched = record.rec_headers.get_header("WARC-Date")
            html = record.content_stream().read()      # chunked and supported content encodings removed
            print(url, fetched, record.http_headers.get_statuscode(), len(html))
```

Per-record gzip lets readers seek straight to one record: `warcio index fetches.warc.gz` prints each record's offset, type and URL, which is the basis of CDX-style lookups. warcio also writes the `WARC-Payload-Digest` automatically. Upload finished WARC files to object storage as ordinary objects. Corpora such as Common Crawl publish the same format ([Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)).

## Re-parsing workflow

1. Select manifest rows (by source, date range or template version).
2. Fetch the objects or WARC records, decode with the stored headers.
3. Run parser version N and write output tagged with `parser_version` and `raw_ref`.
4. Replace the curated partition atomically; the job is idempotent, so it can be re-run safely ([Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)).

DuckDB can scan manifests and Parquet directly in the bucket through its `httpfs` extension, so selection and validation rarely need a separate system ([SQLite and DuckDB](sqlite-and-duckdb.md)).

## Cost and performance

- **Storage classes and lifecycle.** Move raw data to infrequent-access or archive classes after it cools, and expire it when the retention period ends. Those classes bill a minimum object size and storage duration (S3 Standard-IA: 128 KB and 30 days), which punishes millions of tiny objects.
- **Request costs.** At small object sizes, per-request prices dominate. Batch into WARC files or daily archives once volume grows.
- **Egress.** S3 charges for data transferred out to the internet; Cloudflare R2 does not charge egress fees, which matters if other systems read the archive often ([Cost Control](../operations/cost-control.md)).
- **Throughput.** S3 supports at least 3,500 write and 5,500 read requests per second per prefix and scales by spreading keys over prefixes; the hashed `ab/cd/` key layout does that naturally.
- **Consistency and size.** S3 provides strong read-after-write consistency, and individual objects can be very large (botocore's bundled API documentation cites 50 TB, with multipart uploads above 5 GB).

## Security, retention and rights

- Keep buckets private (block public access), use least-privilege credentials per job, and enable encryption at rest. Never put secrets in keys or metadata.
- Raw pages can contain names, emails and comments. Set a retention period, map deletion requests to keys through the manifest, and minimize what you keep ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- Versioning and Object Lock make an archive tamper-evident and write-once, which helps audits but conflicts with deletion obligations: choose deliberately.
- Archiving for internal re-parsing is different from republishing archived pages ([Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)).

## Pitfalls

- **Missing context.** A body without its final URL, status, headers and fetch time cannot be decoded or interpreted reliably later.
- **No manifest.** Listing a bucket to find fetches is slow and costly; the manifest is the index.
- **Mutable raw data.** Overwriting keys destroys history; use conditional writes or versioning.
- **Small-object explosion.** Hundreds of millions of tiny objects make listing, lifecycle transitions and requests expensive; batch them.
- **Broken lineage.** Curated records without `raw_ref` cannot be traced back or re-derived.
- **Keeping everything forever.** Unbounded retention of personal data is a legal risk, not just a storage bill.

## Checklist

- [ ] Every parsed response is archived compressed, with URL, final URL, status, headers, fetch time and hash in a manifest.
- [ ] Keys are deterministic (content-addressed or fetch id); writes never overwrite.
- [ ] Curated records carry `raw_ref` and `parser_version`; re-parse jobs are idempotent.
- [ ] Lifecycle, retention and deletion procedures are defined and tested.
- [ ] Buckets are private and encrypted; credentials are scoped per job.

## See Also

- [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [File Formats for Scraped Data](file-formats.md)
- [Data Modeling for Scraped Data](data-modeling-for-scraped-data.md)
- [Cost Control](../operations/cost-control.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
