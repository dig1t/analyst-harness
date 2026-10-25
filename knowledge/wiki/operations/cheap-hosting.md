---
tags: [scraping, operations, hosting, docker, github-actions]
aliases: [scraper hosting, free tier, VPS for scrapers, GitHub Actions cron, serverless scraping, run a bot 24/7]
---

# Cheap Hosting for Scrapers

> Sources: GitHub Docs, GitHub Actions billing (https://docs.github.com/en/billing/concepts/product-billing/github-actions); GitHub Docs, Actions limits (https://docs.github.com/en/actions/reference/limits); GitHub Docs, GitHub-hosted runners (https://docs.github.com/en/actions/reference/runners/github-hosted-runners); GitHub Terms for Additional Products and Features, Actions (https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#actions); Google Cloud, Cloud Run pricing (https://cloud.google.com/run/pricing); Google Cloud, Cloud Scheduler pricing (https://cloud.google.com/scheduler/pricing); Google Cloud free tier (https://cloud.google.com/free); Cloudflare Workers pricing and limits (https://developers.cloudflare.com/workers/platform/pricing/ and https://developers.cloudflare.com/workers/platform/limits/); Fly.io pricing (https://fly.io/docs/about/pricing/); Railway plans (https://docs.railway.com/pricing/plans); Microsoft Learn, Azure free account (https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/avoid-charges-free-account); Playwright, Docker (https://playwright.dev/docs/docker); Docker docs, Compose services reference (https://docs.docker.com/reference/compose-file/services/) and JSON file logging driver (https://docs.docker.com/engine/logging/drivers/json-file/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A handful of HTTP scrapers and a chat bot can run for a few dollars a month, or for free. The choice depends on four questions. Does something need to run continuously (a bot, a queue worker) or only on a schedule? Does it need a headless browser (memory)? How much data leaves the machine (egress pricing)? And how do target sites treat the network you run from (IP reputation)? A small VPS with Docker Compose covers almost everything; scheduled CI runners and serverless cron triggers are cheaper for small periodic jobs, with limits and terms that must be read first. Prices below are marked "as of 2026-10" where they were checked against the provider's own pages; everything else is described without numbers because prices change.

## Options at a glance

| Option | Price | Runs 24/7 | Fits | Watch out for |
|---|---|---|---|---|
| Small VPS (Hetzner, DigitalOcean, Vultr, Linode/Akamai, OVHcloud and similar) | Entry plans typically cost a few USD or EUR per month; check current price pages | Yes | Bots, workers, cron, Docker, browsers on 2 GB plans or larger | You patch and secure it; datacenter IP ranges |
| Oracle Cloud Always Free | Free Arm (Ampere) and small x86 instances | Yes | Personal projects that need RAM | Capacity can be scarce in popular regions; idle instances can be reclaimed |
| Google Cloud free tier | 1 e2-micro instance per month free (as of 2026-10), region limits apply | Yes | Tiny HTTP-only jobs | Too little memory for browsers |
| GitHub Actions schedule | Free for public repos on standard runners; private repos get 2,000 min/month (Free plan) or 3,000 (Pro), then Linux 2-core $0.006/min (as of 2026-10) | No, 6 h per job | Small periodic scrapers, "git scraping" of public data | Terms of use, delays at the top of the hour, schedules disabled after 60 days of inactivity in public repos |
| Cloud Run jobs + Cloud Scheduler | Jobs free tier: 240,000 vCPU-seconds and 450,000 GiB-seconds per month; Scheduler: 3 free jobs per billing account, then $0.10 per job per 31 days (as of 2026-10) | No (batch tasks) | Containerized batch scrapers, including headless browsers | Egress beyond the free tier, IAM setup |
| Cloudflare Workers Cron Triggers | Free: 100,000 requests/day, 10 ms CPU per invocation, 50 subrequests per request, 5 cron triggers; Paid from $5/month (as of 2026-10) | No | Light API polling, feeds, change checks | CPU limits, UTC-only cron, a `CF-Worker` header on every subrequest |
| Cloudflare Browser Run | Free: 10 browser minutes/day; Paid: 10 h/month included, then $0.09/h (as of 2026-10) | No | Occasional rendering | Concurrency and session limits |
| Fly.io Machines | No free tier, trial only; `shared-cpu-1x` 256 MB about $2.19 per 30 days, 1 GB about $6.70; egress $0.02/GB in North America and Europe (as of 2026-10, varies by region) | Yes | Small always-on bots near users | Pay per use; set spending alerts |
| Railway | Free plan with $1 credit/month; Hobby $5/month including $5 of usage; egress $0.05/GB (as of 2026-10) | Yes | Bot plus cron services in one project | Cron is UTC, at least 5 minutes apart, skipped while the previous run is alive |
| AWS (Lambda, EventBridge Scheduler, Fargate) | Monthly free allowances exist; the free tier for new accounts changed to a credit-based model in 2025 | Lambda: no (15 min max) | Teams already on AWS | Many moving parts, egress pricing |
| Azure | $200 credit for 30 days plus limited free services for 12 months (as of 2026-10) | Yes | Trying things out | Services disabled when the credit expires unless upgraded |
| Home server or Raspberry Pi | Hardware and power | Yes | Hobby projects | Your home IP takes the reputation hit; ISP terms; uptime |

## Choosing by workload

- **A few periodic HTTP scrapers of public data:** GitHub Actions in a public repository, a Cloud Run job, or a Workers cron trigger. All are free at small scale.
- **A bot that must stay connected (Discord, Telegram) plus scrapers:** a small VPS, a Fly.io machine or a Railway service, with a restart policy.
- **Headless browsers:** plan memory first. Chromium inside 512 MB rarely works; start from 2 GB, measure per-page memory, and see [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md).
- **Large crawls:** several VPS workers behind a queue (see [Queues and Workers](queues-and-workers.md)), on providers whose plans include generous traffic.

## The 24/7 VPS setup with Docker Compose

A small scraper image, tested with Docker 29. The loop runs, sleeps with jitter, writes a heartbeat file for the health check, and exits cleanly on `SIGTERM` (so `docker stop` takes about a second instead of the 10 s grace period).

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY scraper/ ./scraper/
RUN useradd --create-home --uid 10001 app && mkdir -p /data && chown app /data
USER app

CMD ["python", "-m", "scraper.main"]
```

```python
# scraper/main.py  (requirements.txt: httpx==0.28.1, selectolax==1.0.2)
import json, logging, os, random, signal, sys, time
from pathlib import Path

import httpx
from selectolax.lexbor import LexborHTMLParser

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("scraper")
DATA = Path(os.environ.get("DATA_DIR", "/data"))
START_URL = os.environ["START_URL"]
INTERVAL = int(os.environ.get("INTERVAL_MINUTES", "60")) * 60
USER_AGENT = os.environ.get("USER_AGENT", "acme-research-bot/1.0 (+https://acme.example/bot)")
stopping = False


def on_sigterm(signum, frame):  # docker stop sends SIGTERM, then SIGKILL after the grace period
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, on_sigterm)


def run_once() -> int:
    with httpx.Client(headers={"User-Agent": USER_AGENT}, timeout=20, follow_redirects=True) as c:
        resp = c.get(START_URL)
        resp.raise_for_status()
    titles = [n.text(strip=True) for n in LexborHTMLParser(resp.text).css("article h3 a")]
    (DATA / f"items-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json").write_text(json.dumps(titles))
    return len(titles)


def main() -> None:
    once = "--once" in sys.argv
    while not stopping:
        started = time.monotonic()
        try:
            log.info("run finished items=%d", run_once())
            (DATA / "heartbeat").touch()
        except Exception:
            log.exception("run failed")
        if once:
            return
        deadline = started + INTERVAL + random.uniform(0, 60)  # interval plus jitter
        while not stopping and time.monotonic() < deadline:
            time.sleep(1)


if __name__ == "__main__":
    main()
```

```yaml
# docker-compose.yml
services:
  scraper:
    build: .
    restart: unless-stopped        # back after crashes and reboots
    init: true                     # reap zombie processes, forward signals
    env_file: .env                 # secrets live here, never in git
    environment:
      START_URL: "https://books.toscrape.com/catalogue/page-1.html"
      INTERVAL_MINUTES: "60"
    volumes:
      - ./data:/data
    mem_limit: 256m                # a browser-based job needs 1g or more
    cpus: 0.5
    stop_grace_period: 30s
    logging:
      driver: json-file
      options:
        max-size: "10m"            # the default is unlimited and can fill a small disk
        max-file: "3"
    healthcheck:                   # unhealthy if no successful run in 2 hours
      test: ["CMD", "python", "-c", "import os,sys,time; sys.exit(time.time() - os.path.getmtime('/data/heartbeat') > 7200)"]
      interval: 5m
      timeout: 10s
      start_period: 2m
      retries: 2
```

Notes for this setup:

- A standalone Docker engine marks a container `unhealthy` but does not restart it; the health check is for visibility (`docker ps`) or for an external watchdog. Restart policies act on exits.
- For a bot, add a second service with the same `restart`, `init` and logging settings. Long-lived connections need reconnect logic in the code, not just a restart policy.
- For Playwright, start from the official image (`mcr.microsoft.com/playwright/python:v<version>-noble`). Playwright's Docker guide recommends `--init`, and `--ipc=host` for Chromium because otherwise it can run out of shared memory and crash (in Compose, a larger `shm_size` is the usual alternative to the 64 MB default). For crawling untrusted sites it recommends a non-root user plus its seccomp profile, because running as root disables the Chromium sandbox.
- Hardening: SSH keys only, a firewall that allows SSH and nothing else inbound (scrapers and bots only connect outward), automatic security updates, and a backup of the data volume.

## GitHub Actions on a schedule

Facts from GitHub's docs (as of 2026-10): usage is free for public repositories on standard runners (Linux: 4 vCPU, 16 GB RAM); private repositories draw on included minutes and then run on 2 vCPU, 8 GB Linux runners at $0.006 per minute. A single-CPU `ubuntu-slim` runner (5 GB RAM) costs $0.002 per minute in private repos but stops jobs after 15 minutes. Jobs on GitHub-hosted runners are limited to 6 hours. Scheduled workflows run on the default branch, at most every 5 minutes, may be delayed at busy times such as the start of each hour, and are disabled in public repositories after 60 days without repository activity.

Read the Actions terms before using it as a scraping platform: Actions must not be used in ways that place a burden on GitHub's servers disproportionate to the benefit to users, and with GitHub-hosted runners must not be used for "any other activity unrelated to the production, testing, deployment, or publication of the software project associated with the repository". Small "git scraping" workflows that publish open data from a public repository are common, but the judgment is yours; for heavy or commercial workloads use a VPS or a self-hosted runner.

```yaml
# .github/workflows/scrape.yml  (validated with actionlint 1.7.12)
name: scrape-prices

on:
  schedule:
    - cron: "17 */6 * * *"        # 00:17, 06:17, 12:17, 18:17 (avoid minute 0)
      timezone: "Europe/Madrid"   # optional; omit for UTC
  workflow_dispatch:              # manual "Run workflow" button

permissions:
  contents: write                 # needed to push the data commit

concurrency:
  group: scrape-prices            # never two runs at once
  cancel-in-progress: false       # let a running scrape finish

jobs:
  scrape:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.13"
          cache: pip
      - run: pip install -r requirements.txt
      - name: Scrape
        env:
          START_URL: https://books.toscrape.com/catalogue/page-1.html
          DATA_DIR: data
          USER_AGENT: acme-research-bot/1.0 (+https://acme.example/bot)
          API_TOKEN: ${{ secrets.API_TOKEN }}
        run: python -m scraper.main --once
      - name: Commit data if it changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git add data/
          git diff --staged --quiet || git commit -m "data: $(date -u +%Y-%m-%dT%H:%MZ)"
          git push
      - name: Report success to the dead man's switch
        run: curl -fsS -m 10 --retry 3 -o /dev/null "${{ secrets.HC_PING_URL }}"
      - name: Report failure
        if: failure()
        run: curl -fsS -m 10 --retry 3 -o /dev/null "${{ secrets.HC_PING_URL }}/fail"
```

Secrets are not passed to workflows triggered from forks (except a read-only `GITHUB_TOKEN`), so a public repository does not leak them through pull requests (see [Secrets and Configuration](secrets-and-config.md)).

## Serverless with cron triggers

**Cloud Run jobs plus Cloud Scheduler** run a container to completion on a schedule, so the same image as above works with `--once`:

```bash
gcloud run jobs deploy books-scraper \
  --image=europe-west1-docker.pkg.dev/PROJECT/scrapers/books:1.4.0 \
  --region=europe-west1 --memory=1Gi --cpu=1 --task-timeout=30m --max-retries=1 \
  --command=python --args=-m,scraper.main,--once   # --args alone would replace the whole CMD

gcloud scheduler jobs create http books-scraper-6h \
  --location=europe-west1 --schedule="17 */6 * * *" --time-zone="Etc/UTC" \
  --http-method=POST \
  --uri="https://run.googleapis.com/v2/projects/PROJECT/locations/europe-west1/jobs/books-scraper:run" \
  --oauth-service-account-email=scheduler@PROJECT.iam.gserviceaccount.com
```

The scheduler's service account needs permission to run the job (see the Cloud Run docs for the role). **Cloudflare Workers** run a `scheduled()` handler from `"triggers": { "crons": ["17 */6 * * *"] }` in the Wrangler configuration; cron triggers use UTC. Outbound `fetch()` calls from a Worker carry a `CF-Worker` header naming your zone, so sites can attribute the traffic to you.

## IP reputation and identity

Requests from datacenter and cloud ranges are more likely to be rate limited or challenged than requests from consumer networks, and on serverless platforms and shared CI runners you share egress addresses with other tenants and inherit their reputation (see [How Bot Detection Works](../anti-bot/how-bot-detection-works.md)). The responsible answer is not to hide behind residential proxies but to be easy to identify and easy to allow: an honest User-Agent with a contact URL, low request rates, and ideally a stable egress IP the site owner can allowlist (a VPS address, Fly.io's static egress IP, or a cloud NAT address). See [Identifying Your Bot](../anti-bot/identifying-your-bot.md) and [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md).

## Pitfalls

- Running Chromium in 256 to 512 MB containers and debugging "random" crashes; Docker's 64 MB `/dev/shm` default makes it worse.
- Unbounded Docker logs filling a 20 GB disk.
- Relying on GitHub Actions schedules for anything time-critical, or forgetting the 60-day inactivity rule.
- Free tiers that expire or get reclaimed (trial credits, idle Always Free instances) holding the only copy of your data.
- Egress charges from cloud providers when downloading images, PDFs or archives at scale.
- Running from a home connection and getting the household's IP challenged or blocked.
- No spending limit or budget alert on pay-as-you-go platforms.

## Checklist

- [ ] Workload classified: scheduled or 24/7, HTTP or browser, expected egress
- [ ] Platform terms read (especially CI runners)
- [ ] Container runs as non-root, with `init`, a restart policy and memory limits
- [ ] Log rotation configured
- [ ] External dead man's switch on every scheduled job
- [ ] Data volume backed up off the machine
- [ ] Budget alert or hard spending cap set
- [ ] Bot identity (User-Agent, contact page, stable IP if possible) documented

## See Also

- [Scheduling and Cron](scheduling-and-cron.md)
- [Cost Control](cost-control.md)
- [Secrets and Configuration](secrets-and-config.md)
- [Monitoring and Alerting](monitoring-and-alerting.md)
- [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
