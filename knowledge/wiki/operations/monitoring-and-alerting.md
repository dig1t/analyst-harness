---
tags: [scraping, operations, monitoring, alerting, discord]
aliases: [scraper monitoring, alerts, dead man's switch, heartbeat monitoring, Discord webhook alerts]
---

# Monitoring and Alerting

> Sources: Google SRE book, Monitoring Distributed Systems (https://sre.google/sre-book/monitoring-distributed-systems/); Prometheus docs, Instrumentation, batch jobs (https://prometheus.io/docs/practices/instrumentation/); Prometheus docs, When to use the Pushgateway (https://prometheus.io/docs/practices/pushing/); Discord Developer Docs, Execute Webhook (https://discord.com/developers/docs/resources/webhook#execute-webhook); Discord Developer Docs, Rate Limits (https://discord.com/developers/docs/topics/rate-limits); Slack, Sending messages using incoming webhooks (https://api.slack.com/messaging/webhooks); Healthchecks.io, Pinging API (https://healthchecks.io/docs/http_api/); Spidermon documentation (https://spidermon.readthedocs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scrapers fail quietly. The process exits 0, the server answered 200, and the dataset is empty because a class name changed, a consent wall appeared, or the schedule stopped firing weeks ago. Monitor **outcomes** (did a run happen, how many valid items did it produce, how fresh is the newest record) as well as process health, compare them with a baseline, and route alerts by severity to a place where a human (or the repair agent) will act on them. Every alert should say what broke and link to the runbook.

## What to measure

| Signal | Why it matters | Example alert |
|---|---|---|
| Last successful run (heartbeat) | Catches runs that never start | No success for 2 intervals |
| Items per run vs baseline | The main breakage signal | 0 items: critical; under half the 10-run median: warning |
| Listing pages with zero items | Selector or layout change | Any, on pages that normally have items |
| Validation failures and null rate per field | Partial breakage (price missing, wrong currency) | Over 2 percent of items |
| Responses by status, especially 403 and 429 | Blocks and rate limits | Over 5 percent of requests |
| Latency p50 and p95 per host | Overload on the target or on you | p95 doubles vs last week |
| Freshness: age of the newest record | The user-facing symptom | Older than the agreed SLA |
| Run duration | Creeping slowness, hung browsers | Over 80 percent of the interval |
| Bytes, proxy GB, browser minutes, LLM tokens | Cost runaways | Daily spend over budget |

Field-level and drift checks are covered in [Data Quality Monitoring](../data-quality/data-quality-monitoring.md); canary URLs with known expected values are in [Testing Scrapers](../data-quality/testing-scrapers.md).

## Evaluate every run

Emit one summary per run (see [Logging and Observability](logging-and-observability.md)) and evaluate it against recent history:

```python
from statistics import median


def evaluate_run(stats: dict, history: list[int]) -> list[tuple[str, str]]:
    """Turn one finished run's counters into (severity, message) alerts."""
    alerts: list[tuple[str, str]] = []
    items, requests = stats["items"], max(1, stats["requests"])
    recent = history[-10:]
    if recent:
        baseline = median(recent)
        if items == 0:
            alerts.append(("critical", f"0 items (median of last {len(recent)} runs: {baseline:.0f})"))
        elif items < 0.5 * baseline:
            alerts.append(("warning", f"{items} items, under half the median {baseline:.0f}"))
    blocked = stats.get("status_403", 0) + stats.get("status_429", 0)
    if blocked / requests > 0.05:
        alerts.append(("warning", f"{blocked}/{requests} responses were 403 or 429: slow down"))
    if stats.get("validation_errors", 0) > 0.02 * max(1, items):
        alerts.append(("warning", f"{stats['validation_errors']} items failed schema validation"))
    if stats.get("empty_listing_pages", 0) > 0:
        alerts.append(("warning", f"{stats['empty_listing_pages']} listing pages had no items"))
    return alerts
```

A sudden 0 together with many 403s means "blocked, back off and investigate" (see [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)); a sudden 0 with normal 200s means "the page changed" (see [Maintenance and Breakage Response](scraper-maintenance-and-breakage.md)).

## Dead man's switch

Failure alerts cannot fire for a run that never starts. Invert the check: the job reports success, and silence triggers the alert.

**Healthchecks.io** (hosted, or self-hosted since it is open source) gives each check a ping URL. Ping `/start` when the run begins (to measure duration), the plain URL on success, and `/fail` or `/<exit-status>` on failure. Their API docs ask clients not to ping one check more than 5 times per minute.

```bash
HC="https://hc-ping.com/your-check-uuid"
curl -fsS -m 10 --retry 5 -o /dev/null "$HC/start"
python -m scraper.main --once
curl -fsS -m 10 --retry 5 -o /dev/null "$HC/$?"   # 0 = success, anything else = failure
```

**Prometheus.** For batch jobs, the key metric is the last time the job succeeded. Prometheus recommends the Pushgateway only for service-level batch jobs, without instance labels (pushed series are never forgotten automatically).

```python
from prometheus_client import CollectorRegistry, Gauge, push_to_gateway

registry = CollectorRegistry()
last_ok = Gauge("scraper_last_success_timestamp_seconds", "Last successful run", ["spider"], registry=registry)
items = Gauge("scraper_items_last_run", "Items extracted by the last run", ["spider"], registry=registry)
last_ok.labels(spider="books").set_to_current_time()
items.labels(spider="books").set(118)
push_to_gateway("pushgateway.internal:9091", job="scrapers", registry=registry)
```

```yaml
groups:
  - name: scrapers
    rules:
      - alert: ScraperStale
        expr: time() - scraper_last_success_timestamp_seconds > 2 * 6 * 3600
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: "{{ $labels.spider }} has not succeeded for 12 hours"
          runbook: "https://wiki.example.com/runbooks/scraper-stale"
```

## Routing alerts to Discord or Slack

Chat webhooks are the cheapest alert channel for small teams. Facts from the Discord docs that matter for automation: message `content` is limited to 2000 characters, a message carries up to 10 embeds (title 256 characters, description 4096, up to 25 fields with values of 1024, and 6000 characters across all embeds), a 429 response carries a JSON body with `retry_after` in seconds, and webhooks parse user mentions by default. Tested TypeScript sender:

```typescript
type Severity = "info" | "warning" | "critical";
const COLORS: Record<Severity, number> = { info: 0x3498db, warning: 0xf1c40f, critical: 0xe74c3c };

export interface Alert {
  title: string;
  severity: Severity;
  fields: Record<string, string | number>;
  link?: string; // CI run, dashboard or runbook URL
}

export async function sendDiscordAlert(webhookUrl: string, alert: Alert): Promise<void> {
  const payload = {
    username: "scraper-monitor",
    allowed_mentions: { parse: [] }, // automated alerts never ping @everyone or users
    embeds: [
      {
        title: `[${alert.severity.toUpperCase()}] ${alert.title}`.slice(0, 256),
        url: alert.link,
        color: COLORS[alert.severity],
        timestamp: new Date().toISOString(),
        fields: Object.entries(alert.fields)
          .slice(0, 25)
          .map(([name, value]) => ({ name: name.slice(0, 256), value: String(value).slice(0, 1024), inline: true })),
      },
    ],
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${webhookUrl}?wait=true`, { // wait=true surfaces errors
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      const { retry_after } = (await res.json()) as { retry_after: number };
      await new Promise((r) => setTimeout(r, Math.ceil(retry_after * 1000)));
      continue;
    }
    if (!res.ok) throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
    return;
  }
  throw new Error("Discord webhook still rate limited after 3 attempts");
}

await sendDiscordAlert(process.env.DISCORD_WEBHOOK_URL!, {
  title: "books: 0 items scraped",
  severity: "critical",
  fields: { run_id: "r-20261024-0612", pages: 48, items: 0, http_403: 47 },
  link: "https://github.com/acme/scrapers/actions/runs/123",
});
```

Slack incoming webhooks take a JSON body with a `text` field (Discord also accepts Slack-format payloads at the webhook URL plus `/slack`):

```bash
curl -fsS -m 10 -X POST -H 'Content-Type: application/json' \
  --data '{"text":"[WARNING] books: 40 items, median 119. Runbook: https://wiki.example.com/runbooks/books"}' \
  "$SLACK_WEBHOOK_URL"
```

Treat webhook URLs as secrets: anyone holding one can post to the channel (see [Secrets and Configuration](secrets-and-config.md)).

## Alert design

- **Alert on symptoms**, such as no data, stale data or a validation spike, rather than on causes like CPU usage. This is the core advice of the SRE monitoring chapter.
- **Make every alert actionable.** Include run id, counts, the first failing URL and a runbook link. If nobody ever acts on an alert, fix or delete it.
- **Route by severity.** Critical goes to a channel that notifies a person (or the on-call), warning to the team channel, info to a daily digest.
- **Deduplicate.** One open alert per spider and condition; repeat at most every few hours, and send a recovery message when it clears.
- **Use hysteresis.** Require the condition for two runs or a `for:` duration to avoid flapping.
- **Test the path.** Send a test alert on deploy; a broken webhook is a silent monitoring outage.

## Tooling options

| Need | Lightweight | Heavier |
|---|---|---|
| Heartbeats | Healthchecks.io (hosted or self-hosted), Uptime Kuma push monitors | Prometheus with Alertmanager |
| Run metrics and dashboards | A `runs` table in SQLite or DuckDB plus a notebook | Prometheus and Grafana |
| Scrapy spiders | Spidermon: monitors over crawl stats, item validation, notifications | |
| Exceptions | Sentry or similar error tracker | |

## Pitfalls

- Alerting only on exceptions, so empty or partial runs pass as successes.
- Static thresholds on sources whose volume varies by weekday; compare with the same weekday or a rolling median.
- Webhook alerts that mention `@everyone` or echo scraped text into the message (mention injection, leaking data into chat).
- Alert storms: one failing site producing an alert per URL instead of one per run.
- Monitoring that runs on the same box and scheduler as the scrapers, so it dies with them. Keep the dead man's switch external.
- Forgetting to alert on cost metrics until the invoice arrives.

## Checklist

- [ ] Heartbeat per scheduled job, checked by an external service
- [ ] Item count compared with a rolling baseline each run
- [ ] 403 and 429 rates tracked per host
- [ ] Validation failure and null rates tracked per field
- [ ] Freshness SLA per dataset with an alert
- [ ] Alerts deduplicated, routed by severity, with runbook links
- [ ] Webhook URLs stored as secrets; mentions disabled for automated posts

## See Also

- [Logging and Observability](logging-and-observability.md)
- [Data Quality Monitoring](../data-quality/data-quality-monitoring.md)
- [Maintenance and Breakage Response](scraper-maintenance-and-breakage.md)
- [Scheduling and Cron](scheduling-and-cron.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
