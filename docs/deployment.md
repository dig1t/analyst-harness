# Deployment

The harness is one container with one volume. It needs outbound HTTPS (the Claude API,
Discord, the sites it scrapes) and no inbound ports.

## Sizing and cost

| Option                                           | Monthly cost (approx.)        | Good for                                      |
| ------------------------------------------------ | ----------------------------- | --------------------------------------------- |
| Small VPS, 2 vCPU and 2 to 4 GB RAM (ARM or x86) | 4 to 8 USD                    | Everything: bot, agents, scrapers, DuckDB     |
| 1 GB VPS, image built with `WITH_DUCKDB=false`   | 3 to 5 USD                    | Bot, agents and scrapers without `sql_query`  |
| GitHub Actions only (`scrape-cron.yml`)          | Free within the Actions quota | Scrapers and webhook alerts, no bot or agents |

Prices are rough and vary by provider and region; check current pricing. The model calls
dominate the bill. `budgets.dailyUsd` caps them per day across runs, judges and
reflections; `budgets.runUsd` caps a single run.

## First deployment on a VPS

```bash
# 1. Docker Engine with the compose plugin, then:
sudo mkdir -p /opt/analyst-harness && sudo chown "$USER" /opt/analyst-harness
cd /opt/analyst-harness
curl -fsSLO https://raw.githubusercontent.com/firebit-dev/analyst-harness/main/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/firebit-dev/analyst-harness/main/.env.example
$EDITOR .env                        # ANTHROPIC_API_KEY, Discord settings

# 2. If the GHCR package is private, log in once with a read-only token:
echo "$GHCR_TOKEN" | docker login ghcr.io -u <github-user> --password-stdin

# 3. Start it
docker compose pull && docker compose up -d
docker compose logs -f harness
curl -s http://127.0.0.1:8080/healthz
```

To build on the server instead of pulling, clone the repository and run
`docker compose up -d --build`.

## What the container does

- Runs as the unprivileged `node` user on a read-only root filesystem with all capabilities
  dropped, `no-new-privileges`, a memory limit and a process limit (see `docker-compose.yml`).
- Mounts the `harness-data` volume at `/app/data`. On every start, `docker/entrypoint.sh`
  copies seed files from the image into the volume without overwriting anything: the vault
  (`/app/data/knowledge`) and scraper specs (`/app/data/scrapers`). Edited files are kept and
  new seed files from an upgraded image are added. A deleted seed file comes back on restart,
  so disable a scraper with `enabled: false` instead of deleting its spec.
- Learned and proposed skills go to `/app/data/skills`; the built-in skills stay in the image.
- Serves `/healthz` and the dashboards (`/dashboards/`) on port 8080, bound to the host's
  loopback by compose. The image has a Docker `HEALTHCHECK` that calls `/healthz`. To read
  dashboards remotely, use an SSH tunnel, a private network, or a TLS proxy with
  `DASHBOARD_PASSWORD` set ([dashboards.md](dashboards.md)). Dashboards live on the volume
  under `/app/data/dashboards`.
- Logs JSON lines to stdout; compose rotates them (3 files of 10 MB).
- Optionally runs shell commands in a sandbox container with no network and no secrets:
  `docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d` (Docker Engine 26 or
  newer; see [security.md](security.md)).

## Operating it

```bash
docker compose exec harness node dist/cli.js doctor
docker compose exec harness node dist/cli.js jobs
docker compose exec harness node dist/cli.js scrape hn-top-stories --dry-run
docker compose exec harness node dist/cli.js runs --limit 10
docker compose exec harness node dist/cli.js vault lint
docker compose exec harness node dist/cli.js skills proposed
```

Backups: the volume is the whole state. For example, nightly:

```bash
docker run --rm -v analyst-harness_harness-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/harness-$(date +%F).tgz -C /data .
```

The volume name depends on the compose project name; `docker volume ls` shows it.

## Continuous deployment

`.github/workflows/deploy.yml` builds a multi-arch image (amd64 and arm64) on every push to
`main` and on `v*` tags, and pushes it to `ghcr.io/firebit-dev/analyst-harness`. To let it
restart the server too, set:

| Kind                | Name                 | Value                                                                        |
| ------------------- | -------------------- | ---------------------------------------------------------------------------- |
| Repository variable | `DEPLOY_HOST`        | Server hostname or IP                                                        |
| Repository variable | `DEPLOY_USER`        | SSH user (default `deploy`), in the `docker` group                           |
| Repository variable | `DEPLOY_DIR`         | Folder with `docker-compose.yml` and `.env` (default `/opt/analyst-harness`) |
| Secret              | `DEPLOY_SSH_KEY`     | Private key for that user (use a dedicated key)                              |
| Secret              | `DEPLOY_KNOWN_HOSTS` | Output of `ssh-keyscan <host>`                                               |

The deploy job runs in the `production` environment, so you can require a manual approval in
the repository settings.

## Scrapers on GitHub Actions only

`.github/workflows/scrape-cron.yml` runs the enabled scrapers every 6 hours and posts through
Discord webhooks. Set the repository variable `ENABLE_ACTIONS_CRON=true` and the secrets
`DISCORD_WEBHOOK_REPORTS_URL` and `DISCORD_WEBHOOK_ALERTS_URL`. Scraper state survives between
runs through the Actions cache, and each run uploads its datasets as an artifact for 30 days.
Scheduled workflows can start late under load and pause after 60 days without repository
activity, so treat this as a convenience, not a guarantee.

## Upgrading

`docker compose pull && docker compose up -d`. Data formats are append-only JSONL and plain
Markdown, so upgrades do not need migrations. Run `node dist/cli.js vault index` after an
upgrade that adds vault articles if you want them listed in your existing `wiki/index.md`.
