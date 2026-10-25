---
tags: [scraping, operations, queues, workers, backpressure]
aliases: [task queue, job queue, BullMQ, Celery, RQ, SQS, worker pool, dead-letter queue]
---

# Queues and Workers

> Sources: BullMQ docs (https://docs.bullmq.io/), Going to production (https://docs.bullmq.io/guide/going-to-production) and Migrate from v5 to v6 (https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6); Celery docs, Tasks (https://docs.celeryq.dev/en/stable/userguide/tasks.html), Configuration (https://docs.celeryq.dev/en/stable/userguide/configuration.html) and Using Redis (https://docs.celeryq.dev/en/stable/getting-started/backends-and-brokers/redis.html); RQ documentation (https://python-rq.org/docs/); Amazon SQS Developer Guide (https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html); PostgreSQL docs, SELECT locking clause (https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A queue decouples the stages of a scraper (discover URLs, fetch, parse, validate, store) so each can run, retry and scale on its own, and so a crash loses no work. Every practical queue gives **at-least-once** delivery: a job can run twice after a timeout or a worker crash, so handlers must be idempotent. The other essentials are retries with backoff, a dead-letter destination for jobs that keep failing, rate limits that protect target sites even when you add workers, and backpressure so discovery cannot outrun fetching. Small scrapers do not need any of this; in-process concurrency is enough (see [Concurrency and Async IO](concurrency-and-async.md)).

## When a queue pays off

- Several sites or many jobs on more than one machine.
- Fan-out: one listing page produces hundreds of detail jobs.
- Long or flaky jobs (browsers) that need retries with delays and survive restarts.
- Mixed workloads: HTTP fetches, browser renders, CPU-heavy parsing and LLM extraction, each with different limits.
- Jobs triggered by people or agents, not only by a schedule.

A typical topology: `discover` (sitemaps, listings) puts URLs on `fetch`; fetch workers store raw responses and put a reference on `parse`; parse workers validate and upsert. Keep browser jobs on their own queue so a slow renderer cannot starve plain HTTP work, and pass references (URL, storage key), not page bodies, through the queue (see [Crawler Architecture](../crawling/crawler-architecture.md)).

## Options compared

| | BullMQ (Node, Redis) | Celery (Python) | RQ (Python, Redis) | Amazon SQS | Postgres table |
|---|---|---|---|---|---|
| Delivery | Job lock; stalled jobs are retried | Ack early by default; `task_acks_late` for after completion | Worker moves jobs between registries | Visibility timeout, at-least-once (standard queues) | Row lock with `SKIP LOCKED` |
| Retries | `attempts` plus `backoff` (fixed or exponential, optional jitter) | `autoretry_for`, `retry_backoff`, `retry_jitter` | `Retry(max, interval)` | Redelivery, then a DLQ after `maxReceiveCount` | Your code |
| Rate limits | `limiter` per worker options, global across workers; `setGlobalRateLimit` | `rate_limit`, per worker instance only | None built in (released versions) | None | Your code |
| Scheduling | `upsertJobScheduler` (since 5.16) | Celery beat | `enqueue_in`, `enqueue_at`; `CronScheduler` (beta) | EventBridge Scheduler | pg_cron or an external scheduler |
| Good for | TypeScript scrapers | Large Python estates | Simple Python workers | Serverless and AWS shops | No extra infrastructure |

## BullMQ

Tested with BullMQ 6.4 and ioredis 6 against a local Redis. Two BullMQ 6 changes matter: the legacy repeatable-job API is gone (use job schedulers), and `ioredis` is now an optional dependency that you install yourself; in native ESM, pass constructed client instances.

```typescript
import { Queue, Worker, type Job } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const producerConn = new IORedis(REDIS_URL, { enableOfflineQueue: false }); // producers fail fast
const workerConn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });  // required for workers

const fetchQueue = new Queue("fetch", {
  connection: producerConn,
  defaultJobOptions: {
    attempts: 4,
    backoff: { type: "exponential", delay: 2_000, jitter: 0.5 },
    removeOnComplete: 1_000, // keep the last 1,000 completed jobs
    removeOnFail: 5_000,
  },
});

// Recurring discovery: 6-field pattern, seconds first (here 00:17:00, 06:17:00 ... UTC).
await fetchQueue.upsertJobScheduler("discover-books", { pattern: "0 17 */6 * * *", tz: "UTC" }, {
  name: "discover",
  data: { site: "books" },
});

const worker = new Worker(
  "fetch",
  async (job: Job<{ url: string }>) => {
    const res = await fetch(job.data.url, { signal: AbortSignal.timeout(20_000) });
    const body = await res.text();
    if (res.status === 429 || res.status >= 500) throw new Error(`retryable status ${res.status}`);
    await storeRaw(job.data.url, body); // idempotent: keyed by URL hash and fetch window
    return { status: res.status, bytes: body.length };
  },
  {
    connection: workerConn,
    concurrency: 10,
    limiter: { max: 4, duration: 1_000 }, // at most 4 jobs per second across all workers of this queue
  },
);
worker.on("failed", (job, err) => console.error(job?.id, `attempt ${job?.attemptsMade}`, err.message));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.close(); // finish active jobs, take no new ones
    process.exit(0);
  });
}
```

Production notes from the BullMQ docs: set Redis `maxmemory-policy` to `noeviction` (the only setting that keeps queues correct), keep `maxRetriesPerRequest: null` on worker connections, attach `error` listeners, and shut down gracefully on `SIGTERM`. The worker `limiter` is global, so 10 workers with `{ max: 4, duration: 1000 }` still process at most 4 jobs per second; it limits the queue, not each host, so give hosts that need different rates their own queues.

## Celery

Tested with Celery 5.6 and a Redis broker:

```python
import hashlib

import httpx
from celery import Celery

app = Celery("scrapers", broker="redis://localhost:6379/0")
app.conf.update(
    task_acks_late=True,              # ack after the task finishes, so a crashed worker's task is redelivered
    task_reject_on_worker_lost=True,  # requeue if the worker process dies mid-task
    worker_prefetch_multiplier=1,     # do not hoard long tasks (the default prefetches 4 per process)
    task_soft_time_limit=240,         # raises SoftTimeLimitExceeded inside the task
    task_time_limit=300,              # hard kill
    broker_transport_options={"visibility_timeout": 3600},  # must exceed the longest task
)


class RetryableStatus(Exception):
    pass


@app.task(bind=True, autoretry_for=(httpx.TransportError, RetryableStatus), max_retries=5,
          retry_backoff=2, retry_backoff_max=600, retry_jitter=True, rate_limit="30/m")
def fetch_page(self, url: str) -> dict:
    resp = httpx.get(url, headers={"User-Agent": "acme-research-bot/1.0 (+https://acme.example/bot)"},
                     timeout=20, follow_redirects=True)
    if resp.status_code in (429, 500, 502, 503, 504):
        raise RetryableStatus(f"{resp.status_code} for {url}")
    resp.raise_for_status()
    key = hashlib.sha256(url.encode()).hexdigest()  # idempotent storage key
    store_raw(key, resp.content)
    return {"url": url, "status": resp.status_code}
```

Run with `celery -A tasks worker --concurrency=4`. Two Celery facts that bite scrapers: `rate_limit` applies per worker instance, not globally (the docs suggest a dedicated queue to enforce a global limit), and with the Redis broker a task that runs longer than the visibility timeout (1 hour by default) is redelivered to another worker while the first is still running.

## RQ

```python
from redis import Redis
from rq import Queue, Retry

q = Queue("fetch", connection=Redis.from_url("redis://localhost:6379/2"))
q.enqueue("scraper.tasks.fetch_page", "https://books.toscrape.com/",
          retry=Retry(max=3, interval=[10, 30, 60]),  # intervals need a worker started with --with-scheduler
          job_timeout="5m", result_ttl=3600, failure_ttl=7 * 24 * 3600)
```

Start workers with `rq worker fetch --with-scheduler`. Jobs that exhaust their retries land in the `FailedJobRegistry` for inspection and requeueing.

## Amazon SQS

From the current API reference: standard queues deliver at least once; the visibility timeout defaults to 30 s and can be up to 12 hours; long polling waits up to 20 s; a receive returns at most 10 messages; retention defaults to 4 days (maximum 14); messages can be up to 1 MiB; a redrive policy moves a message to a dead-letter queue once it has been received `maxReceiveCount` times.

```python
import json

import boto3

sqs = boto3.client("sqs")
QUEUE_URL = "https://sqs.eu-west-1.amazonaws.com/123456789012/fetch"

while True:
    resp = sqs.receive_message(QueueUrl=QUEUE_URL, MaxNumberOfMessages=10,
                               WaitTimeSeconds=20, VisibilityTimeout=300)
    for msg in resp.get("Messages", []):
        try:
            handle(json.loads(msg["Body"]))  # must be idempotent
        except Exception:
            continue  # not deleted: visible again after the timeout, DLQ after maxReceiveCount
        sqs.delete_message(QueueUrl=QUEUE_URL, ReceiptHandle=msg["ReceiptHandle"])
```

## Postgres as a queue

When the data already lives in Postgres, a jobs table with `FOR UPDATE SKIP LOCKED` lets many workers claim work without blocking each other. The PostgreSQL docs note that skipping locked rows gives an inconsistent view of the data, which is fine for a queue-like table but not for general queries.

```sql
WITH next AS (
  SELECT id FROM fetch_jobs
  WHERE status = 'queued' AND run_after <= now()
  ORDER BY priority DESC, id
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE fetch_jobs AS j
SET status = 'running', locked_at = now(), attempts = j.attempts + 1
FROM next
WHERE j.id = next.id
RETURNING j.id, j.url;
```

Libraries such as pg-boss and Graphile Worker (Node) or Procrastinate (Python) package this pattern with retries and scheduling. Reclaim rows whose `locked_at` is older than the longest allowed run.

## Backpressure and politeness

- **Bound the backlog.** Producers check depth (`getJobCounts()` in BullMQ, `ApproximateNumberOfMessages` in SQS) and pause discovery above a threshold, instead of enqueueing a million URLs at once.
- **Rate limit where the target is.** Workers multiply; a per-process delay does not protect a site once you run ten processes. Use a queue-level limiter, one queue per host group, or a shared token bucket keyed by host (see [Distributed Crawling](../crawling/distributed-crawling.md) and [URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md)).
- **Prefetch little** for long jobs, so one worker does not reserve work it cannot start.
- **Watch** queue depth, age of the oldest job, throughput, retry rate and dead-letter count (see [Monitoring and Alerting](monitoring-and-alerting.md)).

## Pitfalls

- Non-idempotent handlers under at-least-once delivery: duplicate rows, double alerts.
- Visibility timeout or lock duration shorter than the slowest job, so the job runs twice concurrently.
- Retrying in the HTTP client, the task and the queue at once (see [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)).
- Redis configured as a cache with an eviction policy, silently deleting queue keys.
- Large payloads (whole HTML pages) in messages, exhausting Redis memory or message size limits.
- No dead-letter alerting, so poisoned jobs disappear quietly.
- Assuming Celery `rate_limit` or a per-worker delay protects a site when many workers run.
- BullMQ 6 upgrades without first migrating repeatable jobs to job schedulers.

## Checklist

- [ ] Handlers idempotent; storage keyed by stable identity
- [ ] Retries with backoff at one layer; dead-letter destination with an alert
- [ ] Visibility timeout or lock longer than the slowest job; graceful shutdown on `SIGTERM`
- [ ] Rate limits that hold no matter how many workers run
- [ ] Bounded backlog; producers pause when depth is high
- [ ] Separate queues for browser, HTTP, parse and LLM work
- [ ] Queue metrics on a dashboard; Redis `noeviction` where Redis is the broker

## See Also

- [Distributed Crawling](../crawling/distributed-crawling.md)
- [URL Frontier and Scheduling](../crawling/url-frontier-and-scheduling.md)
- [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)
- [Concurrency and Async IO](concurrency-and-async.md)
- [Scheduling and Cron](scheduling-and-cron.md)
- [Crawler Architecture](../crawling/crawler-architecture.md)
