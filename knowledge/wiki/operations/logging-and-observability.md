---
tags: [scraping, operations, logging, observability, opentelemetry]
aliases: [structured logging, JSON logs, correlation id, run id, metrics, tracing]
---

# Logging and Observability

> Sources: Python docs, Logging HOWTO (https://docs.python.org/3/howto/logging.html); structlog documentation (https://www.structlog.org/); pino documentation (https://getpino.io/); OpenTelemetry semantic conventions, HTTP spans (https://opentelemetry.io/docs/specs/semconv/http/http-spans/); OpenTelemetry, SDK environment variables (https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/); Prometheus docs, Metric and label naming (https://prometheus.io/docs/practices/naming/); Prometheus docs, Instrumentation (https://prometheus.io/docs/practices/instrumentation/); W3C Trace Context (https://www.w3.org/TR/trace-context/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

When a scraper breaks at 03:00, the logs are the only witness. Make them structured (one JSON object per line), consistent (the same field names in every scraper), correlated (a `run_id` on every line and on every stored record), and safe (no cookies, tokens or proxy passwords). Add a few low-cardinality metrics for dashboards and alerts, and traces when a pipeline has enough stages that timing questions matter. Raw page bodies do not belong in logs; archive them separately and log a pointer.

## Logs, metrics, traces

| Signal | Answers | Scraper examples |
|---|---|---|
| Logs | What happened to this URL, this item, this run? | Fetched, retried, selector missed, item dropped, run finished |
| Metrics | How much and how fast, over time? | Requests by status class, items per run, p95 latency per host |
| Traces | Where did the time go in one unit of work? | Run, listing page, detail request, parse, store |

## What to log

**Per request:** `url` (with secrets stripped from the query string), `host`, `method`, `status`, `final_url` after redirects, `bytes`, `duration_ms`, `attempt`, `from_cache`, `content_type`, and the proxy pool name if any (never its credentials).

**Per item:** the item key, `parser_version`, and validation failures by field name.

**Per run:** `run_id`, spider name, code version (git SHA or image tag), start and end time, counts (requests by status, items, dropped items, errors) and `finish_reason`. This summary line feeds [Monitoring and Alerting](monitoring-and-alerting.md).

**Never:** `Cookie`, `Authorization`, API keys, proxy URLs with passwords, session tokens in URLs, or full personal data (see [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Correlation ids

Generate a `run_id` when a run starts and attach it to every log line, every metric push and every stored record (with the source URL and fetch time, see [Provenance and Lineage](../data-quality/provenance-and-lineage.md)). Then "where did this wrong price come from?" becomes a single query: record, then `run_id`, then the log lines for that URL, then the archived raw response. In Python, carry ids in `contextvars` so they survive `await`; in Node, use a child logger (or `AsyncLocalStorage`).

## Python: JSON lines with the standard library

No dependencies; `extra={...}` fields become top-level keys. Tested on Python 3.13.

```python
import json
import logging
import sys
import time
import uuid
from contextvars import ContextVar

run_id_var: ContextVar[str] = ContextVar("run_id", default="-")


class JsonFormatter(logging.Formatter):
    RESERVED = set(vars(logging.makeLogRecord({}))) | {"message", "asctime"}

    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(record.created)) + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
            "run_id": run_id_var.get(),
        }
        entry.update({k: v for k, v in vars(record).items() if k not in self.RESERVED})
        if record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str, ensure_ascii=False)


handler = logging.StreamHandler(sys.stdout)
handler.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[handler])
log = logging.getLogger("scraper.books")

run_id_var.set(uuid.uuid4().hex[:12])
log.info("fetched", extra={"url": "https://example.com/p/1", "status": 200, "bytes": 51234, "duration_ms": 412})
log.warning("selector_miss", extra={"url": "https://example.com/p/2", "field": "price"})
```

Output:

```json
{"ts": "2026-10-24T17:34:32.266Z", "level": "info", "logger": "scraper.books", "msg": "fetched", "run_id": "0e75e3fb2552", "url": "https://example.com/p/1", "status": 200, "bytes": 51234, "duration_ms": 412}
```

## Python: structlog

structlog builds the same output from a processor chain and has first-class context variables:

```python
import structlog

structlog.configure(
    processors=[
        structlog.contextvars.merge_contextvars,
        structlog.processors.add_log_level,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.dict_tracebacks,
        structlog.processors.JSONRenderer(),
    ]
)
log = structlog.get_logger()

structlog.contextvars.bind_contextvars(run_id="r-20261024-0612", spider="books")
log.info("fetched", url="https://example.com/p/1", status=200, duration_ms=412)
log.info("run_finished", items=118, errors=2, finish_reason="finished")
```

## Node.js: pino

pino writes JSON lines by default. `child()` adds correlation fields and `redact` scrubs sensitive paths before serialization.

```typescript
import { randomUUID } from "node:crypto";
import pino from "pino";

const logger = pino({
  base: { service: "price-scraper" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: { paths: ["headers.authorization", "headers.cookie", "proxyUrl"], censor: "[redacted]" },
});

const runLog = logger.child({ runId: randomUUID() });
runLog.info({ url: "https://example.com/p/1", status: 200, durationMs: 412, attempt: 1 }, "fetched");
runLog.warn({ url: "https://example.com/p/2", headers: { authorization: "Bearer abc" } }, "blocked");
runLog.error({ err: new Error("price selector matched 0 nodes"), url: "https://example.com/p/3" }, "parse_failed");
```

## Levels

| Level | Use for |
|---|---|
| DEBUG | Selector-by-selector detail, response headers (off in production) |
| INFO | Run start and summary; one line per request on small scrapers (sample on big crawls) |
| WARNING | Retries, selector misses, dropped items, 429s |
| ERROR | A URL that failed after all retries, an aborted run |

## Metrics

Follow the Prometheus naming rules: base units (seconds, bytes), a `_total` suffix for counters, one unit per metric. Keep label cardinality low: every unique label combination is a new time series, so never use URLs, item ids or query strings as labels. Prometheus suggests keeping most metrics label-free and the cardinality of any metric below about 10 where possible.

| Metric | Type | Labels |
|---|---|---|
| `scraper_requests_total` | Counter | `spider`, `status_class` (2xx, 3xx, 4xx, 5xx, error) |
| `scraper_request_duration_seconds` | Histogram | `spider` |
| `scraper_items_total` | Counter | `spider`, `outcome` (stored, dropped) |
| `scraper_last_success_timestamp_seconds` | Gauge | `spider` |

Long-running workers expose `/metrics`; short batch jobs push a few gauges at the end of a run or just write the run summary to a table.

## Traces

OpenTelemetry spans help when a run has several stages (fetch, render, parse, LLM extraction, store) and you need to know where time and errors concentrate. The HTTP client conventions are stable; record `http.request.method`, `url.full`, `server.address`, `http.response.status_code`, `error.type` and `http.request.resend_count` (set on retries). Span names should be low cardinality, for example `GET` rather than the full URL.

A caution for scrapers: HTTP client auto-instrumentation propagates context by adding `traceparent` (W3C Trace Context) to outgoing requests. That leaks your internal trace ids to third-party sites and adds a header no browser sends. Disable propagation for the scraping client, or set `OTEL_PROPAGATORS=none` for the scraper process if it only talks to external sites. Control volume with `OTEL_TRACES_SAMPLER` and set `OTEL_SERVICE_NAME` so traces are attributable.

## Shipping and retention

- Write JSON lines to stdout and let the runtime collect them: journald for systemd units, the container log driver for Docker. Docker's default `json-file` driver has **no size limit** unless you set `max-size` and `max-file`, which is a classic way to fill a small VPS disk (see [Cheap Hosting for Scrapers](cheap-hosting.md)).
- Ship to a log store when you have several hosts (Loki, Elasticsearch or OpenSearch, a cloud logging service), or keep it simple with files plus `jq` (see [Command-Line Tools](../tools/cli-tools.md)).
- Keep raw HTML in object storage keyed by `run_id` and URL hash, and log the key (see [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).
- Set a retention period, and remember that logs containing personal data are subject to the same rules as the dataset.

## Pitfalls

- Free-text logs (`print(f"got {url}")`) that cannot be filtered or aggregated.
- Different field names per scraper (`url`, `link`, `href`), which breaks shared queries and dashboards.
- Logging request headers or full URLs that contain tokens; redact at the logger, not by convention.
- URLs as metric labels, causing a cardinality explosion.
- Trace headers propagated to target sites by auto-instrumentation.
- Timestamps in local time without an offset.
- Unbounded log files on small disks.

## Checklist

- [ ] JSON lines with a shared field vocabulary
- [ ] `run_id` on every line and every stored record
- [ ] Redaction configured for auth headers, cookies and proxy credentials
- [ ] Run summary line with counts and `finish_reason`
- [ ] Low-cardinality metrics in base units
- [ ] Trace propagation disabled toward third-party sites
- [ ] Log rotation and a retention period

## See Also

- [Monitoring and Alerting](monitoring-and-alerting.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Secrets and Configuration](secrets-and-config.md)
- [Data Quality Monitoring](../data-quality/data-quality-monitoring.md)
- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
