---
tags: [scraping, operations, cron, scheduling]
aliases: [cron, crontab, cron expression, scheduled jobs, job scheduler]
---

# Scheduling and Cron

> Sources: crontab(5), cronie manual (https://man7.org/linux/man-pages/man5/crontab.5.html); POSIX crontab utility (https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html); systemd.timer(5) (https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html); flock(1), util-linux (https://man7.org/linux/man-pages/man1/flock.1.html); GitHub Docs, schedule event (https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule); Kubernetes, CronJob (https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/); croner documentation (https://croner.56k.guru/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Most scrapers run on a schedule: every few minutes for a price watch, nightly for a catalog, weekly for a slow registry. Writing the expression is the easy part. What breaks production systems is time zones and daylight saving time (DST), many jobs firing at the same instant, a slow run overlapping the next one, and runs that silently never happen. The rules: schedule in UTC (or know exactly how your scheduler treats DST), add jitter, forbid overlap, bound every run with a timeout, and make jobs window-based so a missed run heals itself on the next one.

## Cron syntax

Five fields, then the command:

```text
# minute (0-59)
# | hour (0-23)
# | | day of month (1-31)
# | | | month (1-12 or JAN-DEC)
# | | | | day of week (0-7 or SUN-SAT, 0 and 7 are Sunday)
# | | | | |
  * * * * *  command
```

Operators: `*` (any), `,` (list), `-` (inclusive range), `/` (step). Two rules surprise people:

1. **Day of month and day of week are ORed** when both are restricted. `30 4 1,15 * 5` runs at 04:30 on the 1st, on the 15th, and on every Friday (the example comes straight from crontab(5)).
2. **Steps restart inside each field.** `*/23` in the hour field means 00:00 and 23:00 every day, not "every 23 hours".

## Expression cookbook

All times below were checked by computing next runs in UTC.

| Expression | Runs at | Notes |
|---|---|---|
| `*/15 * * * *` | :00, :15, :30, :45 | Every 15 minutes |
| `17 * * * *` | Minute 17 of every hour | Hourly, off the top of the hour |
| `17 */6 * * *` | 00:17, 06:17, 12:17, 18:17 | Every 6 hours |
| `30 6 * * 1-5` | 06:30 Monday to Friday | Weekdays |
| `0 3 * * 0` | 03:00 on Sunday | Weekly |
| `5 4 1 * *` | 04:05 on the 1st | Monthly |
| `0 9-17/2 * * 1-5` | 09, 11, 13, 15, 17 h on weekdays | Step inside a range |
| `30 4 1,15 * 5` | 1st, 15th, and every Friday | The OR rule |
| `0 */23 * * *` | 00:00 and 23:00 | Step trap |
| `0 0 L * *` | Last day of each month | croner/Quartz extension, not POSIX |
| `@daily` | 00:00 | Nickname; not accepted by GitHub Actions |

## Dialects differ

| Scheduler | Format | Time zone | Worth knowing |
|---|---|---|---|
| cronie (Fedora, RHEL) | 5 fields, `@reboot`, `@daily` | System zone, or `CRON_TZ=` per table | `RANDOM_DELAY=` and `6~15` random ranges; `%` means newline |
| Debian/Ubuntu cron | 5 fields, nicknames | System zone | Check `man 5 crontab` before relying on `CRON_TZ` |
| systemd timers | `OnCalendar=Mon..Fri *-*-* 06:30:00 Europe/Madrid` | Per expression | Test with `systemd-analyze calendar` |
| GitHub Actions | 5 POSIX fields, no nicknames | UTC, optional `timezone:` (IANA) | Minimum interval 5 minutes, default branch only |
| Kubernetes CronJob | 5 fields | `.spec.timeZone` | `concurrencyPolicy`, `startingDeadlineSeconds` |
| croner (Node, Deno, Bun) | 5, 6 or 7 fields | `timezone` option | A 6-field pattern starts with **seconds** |
| BullMQ job schedulers | Pattern with seconds, e.g. `0 15 3 * * *` | `tz` option | Replaced repeatable jobs in v5.16 |
| Cloudflare Workers Cron Triggers | 5 fields | UTC only | 5 triggers per account on the free plan |
| Railway cron services | 5 fields | UTC | Runs must be at least 5 minutes apart; a run is skipped while the previous one is still going |

## Time zones and daylight saving time

Run schedulers in UTC and convert at the edges. When a requirement really is local ("06:30 Madrid time"), use a scheduler that accepts an IANA zone and learn its DST rule, because they differ:

- **cronie** matches wall-clock time, so a time skipped by the spring change never matches (the job does not run) and a time repeated in autumn matches twice (the job runs twice).
- **GitHub Actions** with `timezone:` advances a schedule that falls into a skipped hour to the next valid time (02:30 becomes 03:00).
- **croner** skips jobs in the gap and runs jobs in the overlap once.

Avoid local-time schedules in the early-morning hours when most zones switch, and log timestamps in UTC with an explicit offset (see [Logging and Observability](logging-and-observability.md)).

## Jitter: stay off the top of the hour

Everyone schedules at minute 0. Shared runners get congested (GitHub warns that scheduled runs can be delayed at the start of every hour and that some queued jobs may be dropped under high load), and target sites see synchronized bursts from many bots. Options, from simplest:

- Pick an odd fixed minute per job (`17`, `43`).
- Random delay in the scheduler: cronie `RANDOM_DELAY=` (minutes, chosen once per daemon start) or a `~` range in a field; systemd `RandomizedDelaySec=`, plus `FixedRandomDelay=true` for a stable per-machine offset.
- A deterministic per-job offset, so the same job always lands at the same second while different jobs spread out:

```python
import hashlib
import time

def stable_offset_seconds(job_name: str, window_s: int = 900) -> int:
    digest = hashlib.sha256(job_name.encode()).digest()
    return int.from_bytes(digest[:4], "big") % window_s

time.sleep(stable_offset_seconds("books-catalog"))  # first line of the job
```

Jitter at the scheduler level complements, and does not replace, per-request politeness (see [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)).

## Prevent overlapping runs

A run that takes longer than the interval doubles the load on the target and races on writes. Pick the mechanism that matches the scheduler:

| Scheduler | Overlap guard |
|---|---|
| cron | `flock -n /run/lock/job.lock cmd` (fails instead of waiting; `-E` sets the exit code) |
| systemd timer | Built in: if the service is still active when the timer elapses, it is left running and not started again |
| GitHub Actions | `concurrency:` group with `cancel-in-progress: false` |
| Kubernetes | `concurrencyPolicy: Forbid` |
| croner | `protect: true` or a callback |
| Several hosts | A database lock, for example a Postgres advisory lock |

```python
import psycopg

with psycopg.connect(DSN, autocommit=True) as conn:
    locked = conn.execute("SELECT pg_try_advisory_lock(hashtext('books-catalog'))").fetchone()[0]
    if not locked:
        raise SystemExit("another run holds the lock")
    run_scrape()  # the lock is released when the session closes
```

Also give every run a hard timeout shorter than its interval (`timeout 45m`, `TimeoutStartSec=`, `activeDeadlineSeconds`, `timeout-minutes`). A hung headless browser should cost one run, not the whole schedule.

## Missed runs

Plain cron does not catch up after downtime. With systemd `Persistent=true`, a timer that missed at least one run while inactive (for example during a reboot) triggers once as soon as it is active again. Kubernetes skips runs older than `startingDeadlineSeconds`, and GitHub may delay or drop scheduled runs and disables schedules in public repositories after 60 days without repository activity. Design for it:

- Make jobs **window-based**: read the last successful watermark (for example the newest `lastmod` already stored) and fetch everything after it, instead of "the last 6 hours". A late or skipped run then catches up automatically (see [Incremental Crawling](../crawling/incremental-crawling.md)).
- Make writes idempotent so a catch-up or double run is harmless (see [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)).
- Alert when a run does not happen, not only when it fails: a dead man's switch (see [Monitoring and Alerting](monitoring-and-alerting.md)).

## Worked examples

**crontab** (`crontab -e`): absolute paths, a lock, a timeout, and logs. Cron runs with a minimal environment, so set `PATH` explicitly.

```cron
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=""
17 */6 * * * flock -n /tmp/books.lock timeout 45m /opt/books/.venv/bin/python -m scraper.main --once >> /var/log/books/run.log 2>&1
```

**systemd timer**: journald logging, catch-up, randomized delay, resource limits.

```ini
# /etc/systemd/system/books.service
[Unit]
Description=Books scraper, one run
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=scraper
WorkingDirectory=/opt/books
EnvironmentFile=/etc/books.env
ExecStart=/opt/books/.venv/bin/python -m scraper.main --once
# oneshot services have no start timeout by default: set one
TimeoutStartSec=45min
MemoryMax=1G

# /etc/systemd/system/books.timer
[Unit]
Description=Books scraper every 6 hours

[Timer]
OnCalendar=*-*-* 00/6:17:00 UTC
RandomizedDelaySec=10min
FixedRandomDelay=true
Persistent=true

[Install]
WantedBy=timers.target
```

Enable with `systemctl enable --now books.timer`, inspect with `systemctl list-timers` and `journalctl -u books.service`.

**In-process scheduler** (TypeScript, croner) for a long-running service:

```typescript
import { Cron } from "croner";

const job = new Cron(
  "17 */6 * * *",
  {
    name: "books",
    timezone: "UTC",
    protect: (j: Cron) => console.warn(`skipped: run from ${j.currentRun()?.toISOString()} still busy`),
    catch: (err: unknown) => console.error("run failed", err),
  },
  async () => {
    await runScrape();
  },
);
console.log("next run", job.nextRun()?.toISOString());
```

**GitHub Actions**: the trigger and overlap guard (full workflow in [Cheap Hosting for Scrapers](cheap-hosting.md)):

```yaml
on:
  schedule:
    - cron: "17 */6 * * *"
      timezone: "Europe/Madrid"   # optional, default is UTC
  workflow_dispatch:
concurrency:
  group: books-scraper
  cancel-in-progress: false
```

## Choosing where the schedule lives

| Situation | Good fit |
|---|---|
| One small VPS, a few jobs | crontab with `flock`, or systemd timers |
| Need catch-up, memory limits, structured logs | systemd timers |
| Already running a long-lived service | In-process scheduler (croner, APScheduler) |
| Many jobs, retries, fan-out to workers | Queue-based schedulers, see [Queues and Workers](queues-and-workers.md) |
| No server at all | GitHub Actions, Cloud Scheduler with Cloud Run jobs, Workers Cron Triggers |
| Kubernetes cluster | CronJob with `concurrencyPolicy: Forbid` |

## Pitfalls

- An unescaped `%` in a crontab command becomes a newline (write `date +\%F`), and a crontab without a final newline is treated as broken.
- Copying a 5-field expression into a 6-field scheduler (croner, BullMQ) shifts every field: the first one is seconds.
- Expecting `*/23` or `*/7` to spread evenly across day or hour boundaries.
- Forgetting the day-of-month OR day-of-week rule and getting extra runs.
- Treating GitHub Actions schedules as precise: they can start late, be dropped, and stop after 60 days of inactivity in public repositories.
- Local-time schedules during DST changes: skipped or doubled runs depending on the scheduler.
- No overlap guard, so a slow run and the next run hit the same site together.
- No timeout, so one hung run blocks every later run behind a lock.

## Checklist

- [ ] Schedule in UTC, or an explicit IANA zone with known DST behavior
- [ ] Minute is not `0`, or a random or stable jitter is applied
- [ ] Overlap guard matching the scheduler
- [ ] Hard timeout shorter than the interval
- [ ] Job is window-based and its writes are idempotent
- [ ] Dead man's switch alerts on missing runs
- [ ] Expression verified (`systemd-analyze calendar`, croner `nextRuns()`, or a dry run)

## See Also

- [Retries, Backoff and Idempotency](retries-backoff-idempotency.md)
- [Monitoring and Alerting](monitoring-and-alerting.md)
- [Cheap Hosting for Scrapers](cheap-hosting.md)
- [Queues and Workers](queues-and-workers.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
