# analyst-harness

A self-learning data analyst agent harness built on Claude. It runs agents with skills and
tools, keeps autonomous scrapers on cron schedules, reports to Discord and takes commands from
it, and learns from every run. It is designed to live on one small, cheap server.

The agent loop follows the findings of "An Empirical Study of Harness Design for Coding
Agents" (arXiv 2609.20804): a ReAct loop with a planning tool, tiered context management,
stuck detection, a guarded workspace and post-edit diagnostics. The paper's main conclusion
(the best harness components depend on the model, the task type and the budget) is turned into
a learning loop: a bandit picks the harness profile per model and task type, and an LLM judge,
reflection and skill synthesis feed lessons and new skills back into the system.

## What is in the box

| Area       | What you get                                                                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent loop | ReAct loop, `update_plan`, context tiers T0 to T4 (elision, recall store, summarization), stuck detection, budgets, refusal fallback, prompt caching, preserved thinking                                                                                         |
| Tools      | `read_file`, `write_file`, `edit_file`, `list_files`, `glob_files`, `grep_text`, `bash`, `web_fetch`, `sql_query` (DuckDB), `profile_data`, `build_dashboard`, `domain_status`, `search_knowledge`, `load_skill`, `run_scraper`, `delegate_task`, `recall_event` |
| Agents     | `analyst`, `dashboard-builder`, `scraper-engineer`, `verifier`, `librarian`, `reporter` (Markdown files in `agents/`)                                                                                                                                            |
| Skills     | Karpathy LLM Wiki (vendored), 15 Karpathy method skills (vendored), 7 harness skills, plus skills the system learns and you approve                                                                                                                              |
| Dashboards | Self-contained interactive HTML: KPI tiles, line, area, bar, scatter, histogram, heatmap, pivot, facets, a searchable table and column profiles, with cross-filtering, URL state, table views, exports and a notebook export; explorers for every dataset        |
| Scrapers   | Declarative YAML specs (JSON APIs, XML, CSV, HTML, RSS/Atom, sitemaps) with robots.txt, rate limits, retries, conditional requests, validation, change detection and self-repair proposals                                                                       |
| Scheduler  | Cron jobs for every scraper, a daily digest, the learning sweep and a weekly vault lint                                                                                                                                                                          |
| Discord    | Slash commands, progress updates, feedback buttons, approval buttons, alerts; webhook-only mode without a bot                                                                                                                                                    |
| Learning   | Trajectory store, phase labels, LLM judge, Thompson-sampling profile bandit, lessons in the vault, skill proposals                                                                                                                                               |
| Knowledge  | `knowledge/`: an Obsidian vault in the LLM Wiki layout covering data scraping end to end                                                                                                                                                                         |
| Ops        | Dockerfile, docker compose for a small VPS, GitHub Actions for CI, image publishing, SSH deploy and an optional free cron runner                                                                                                                                 |

## Quick start

To use it day to day, install it with `bash scripts/install.sh`: it keeps the harness running in
the background and starts it with every Claude Code session. [GETTING_STARTED.md](GETTING_STARTED.md)
walks through installing, configuring, using and removing it. The steps below are for working on
the code.

Requirements: Node 22 (`.nvmrc`), Python 3 for analysis scripts, and [Claude Code](https://code.claude.com/docs)
logged in to your Claude account. Model calls run through `claude -p` and use your Claude plan,
not an API key ([Model provider](#model-provider)).

```bash
npm ci
cp .env.example .env              # optional settings (read on every start)
npm run cli -- doctor             # checks configuration and optional dependencies
npm run cli -- run "Summarize the latest Hacker News scrape: top 5 stories by score"
npm run cli -- scrape hn-top-stories --dry-run
npm run cli -- vault search "robots.txt crawl-delay"
npm run cli -- explore hn-top-stories   # an explorer dashboard for a scraped dataset
npm run dev                       # scheduler, Discord bot, /healthz and /dashboards/ on :8080
```

`HARNESS_PROVIDER=scripted` runs everything offline with a placeholder model, which is handy
for trying the scheduler, scrapers and bot wiring without spending anything.

## How it fits together

```
 Discord (slash commands, buttons)        GitHub Actions (CI, deploy, optional cron)
              |                                          |
              v                                          v
 +----------------------------------------------------------------------------+
 | HarnessRuntime (src/app/runtime.ts)                                        |
 |                                                                            |
 |  CommandRouter -> runTask -> runAgent: ReAct loop (src/core)               |
 |                               planning, context tiers, stuck detection     |
 |                               tools (src/tools) behind the safety layer    |
 |                                                                            |
 |  Scheduler -> scrapers, daily digest, learning sweep, vault lint           |
 |                                                                            |
 |  Learning -> run store -> judge -> bandit, lessons, skill proposals        |
 +----------------------------------------------------------------------------+
       |              |                  |                    |
   data/runs     data/datasets     knowledge/ vault     skills/ (+ learned)
```

A task arrives from Discord, the CLI or a schedule. The runtime classifies it (analysis,
scraping, maintenance, reporting, research), picks a harness profile, builds the system prompt
(agent instructions, environment, skills index, relevant lessons) and runs the loop. Every
event is recorded. After the run the learning service labels the trajectory, asks the judge
for a verdict, updates the bandit, writes lessons into the vault and may draft a skill.

More detail: [docs/architecture.md](docs/architecture.md), [docs/paper-mapping.md](docs/paper-mapping.md),
[docs/self-learning.md](docs/self-learning.md), [docs/domains.md](docs/domains.md).

## Model provider

`provider` in `config/harness.yaml` picks how the harness reaches Claude:

- `claude-code` (the default) runs the Claude Code CLI you are logged in to, so runs, judges and
  reflections count against your Claude plan's usage limits instead of an API bill. The harness
  keeps its own loop, tools and permission checks; Claude Code runs with its tools, settings,
  hooks, MCP servers and CLAUDE.md turned off and only answers each turn. The harness never
  passes `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` to it. On a machine without a browser
  login, set `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`. The dollar budgets do not apply,
  because these calls cost nothing per token; the plan's own limits do. `harness doctor` checks
  the login.
- `anthropic` calls the Claude API with `ANTHROPIC_API_KEY`, billed per token and capped by
  `budgets`. The Docker image uses it, because it has no Claude Code CLI.
- `scripted` is an offline placeholder model for tests and demos.

A Claude plan covers your own use: keep the Discord allow-list to yourself with `claude-code`
(`doctor` warns when it is open to others).

## Configuration

`config/harness.yaml` holds behavior; secrets only come from the environment
([.env.example](.env.example)). Useful overrides:

| Variable                                                                      | Purpose                                                        |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`                                                           | Claude API key for the `anthropic` provider                    |
| `HARNESS_MODEL`                                                               | Default model (default `claude-opus-5-5`)                      |
| `HARNESS_PROVIDER`                                                            | `claude-code` (default), `anthropic` or `scripted`             |
| `HARNESS_DAILY_BUDGET_USD`, `HARNESS_RUN_BUDGET_USD`                          | API spend caps                                                 |
| `HARNESS_DATA_DIR`                                                            | Runs, state, datasets and workspace                            |
| `HARNESS_KNOWLEDGE_DIR`, `HARNESS_SCRAPERS_DIR`, `HARNESS_LEARNED_SKILLS_DIR` | Writable copies on a data volume (the container sets these)    |
| `DISCORD_*`                                                                   | Bot token, application, guild, channels, allow-lists, webhooks |
| `DASHBOARD_PASSWORD`, `DASHBOARD_PUBLIC_URL`                                  | Basic auth for `/dashboards/` and the base URL for links       |
| `HARNESS_ENVIRONMENT`                                                         | This deployment's column in the domain registry                |

Agents are Markdown files with frontmatter (`agents/*.md`): model, effort, tools, profile,
step and budget limits, and per-agent access to the vault, skills and scraper specs. Scrapers
are YAML files in `config/scrapers/`; see [docs/scrapers.md](docs/scrapers.md).

## Dashboards

Ask for a dashboard in plain words (`/ask task:"Dashboard of PyPI releases by package"`) and the
analyst profiles the data, writes a spec and publishes it with `build_dashboard`; or build one
yourself with `harness dashboard build <spec.yaml>`. Every dataset can get an explorer
(`harness explore <dataset>`, `/dashboard explore`), created automatically on its first scrape
and rebuilt whenever a scrape adds records. Dashboards are single HTML files that work offline,
with tooltips, cross-filtering, facets, brushing, a searchable table, table views, CSV, SVG and
PNG exports, and filters kept in the link. They are served at `/dashboards/` on the web port
(basic auth with `DASHBOARD_PASSWORD`) and attached to Discord replies. See
[docs/dashboards.md](docs/dashboards.md).

## Discord

Create an application, add a bot, invite it with the `bot` and `applications.commands` scopes,
then set `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID` and at least one
allow-list (`DISCORD_ALLOWED_USER_IDS`, `DISCORD_ALLOWED_ROLE_IDS` or `DISCORD_ADMIN_USER_IDS`).
The bot denies everyone by default.

Main commands: `/ask`, `/scrape list|run|status|repair|apply`, `/jobs`, `/runs`, `/run`, `/stop`,
`/feedback`, `/budget`, `/skills list|proposed|approve|reject`, `/dashboard list|get|explore`,
`/knowledge`, `/lessons`, `/learn`, `/profiles`, `/status`, `/help`. Results come with thumbs up and down buttons that train the
bandit, and risky tool calls ask for approval with buttons. Without a bot token the harness
still posts reports and alerts through webhooks. See [docs/discord.md](docs/discord.md).

## Cheap hosting

One container on a small VPS is enough: the harness idles at about 150 MB of memory and all
heavy lifting happens at the API. A 2 GB ARM or x86 instance from a budget provider (a few US
dollars a month; check current prices) leaves room for DuckDB and Python. The bot connects
out to Discord, so no inbound port is needed.

```bash
# on the server
git clone https://github.com/firebit-dev/analyst-harness && cd analyst-harness
cp .env.example .env && $EDITOR .env   # ANTHROPIC_API_KEY: the image calls the Claude API
docker compose up -d
docker compose logs -f
```

The container runs as a non-root user on a read-only root filesystem. Everything it writes
(runs, datasets, learned skills, the live copy of the vault and scraper specs) lives on the
`harness-data` volume, seeded from the image on first start. Back up that volume and you have
backed up the harness. If you only need scrapers and Discord alerts, the
[scheduled scrapes workflow](.github/workflows/scrape-cron.yml) runs them on GitHub Actions for
free. See [docs/deployment.md](docs/deployment.md).

## CI and deployment

| Workflow          | When                                          | What                                                                                                          |
| ----------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `ci.yml`          | Pushes to `main`, pull requests               | Lint, format check, typecheck, Jest with coverage, build, vault lint, Playwright, Docker build and smoke test |
| `deploy.yml`      | Pushes to `main`, `v*` tags                   | Multi-arch image to GHCR; SSH deploy when `DEPLOY_HOST` is set                                                |
| `scrape-cron.yml` | Every 6 hours when `ENABLE_ACTIONS_CRON=true` | Runs enabled scrapers and posts through Discord webhooks                                                      |

Dependabot keeps npm packages, actions and the base image current.

## Repository layout

```
.claude/           SessionStart hook that starts the harness in Claude Code sessions on this repo
agents/            agent definitions (Markdown + frontmatter)
bin/harness        the `harness` command
config/            harness.yaml and scraper specs
docker/            container entrypoint
docs/              architecture, paper mapping, learning, deployment, Discord, security, scrapers
knowledge/         Obsidian vault: raw/ sources, wiki/ articles, index and log (LLM Wiki layout)
scripts/           installer, Claude Code hook scripts, UI bundler
skills/            vendored and harness skills; learned/ and proposed/ appear at runtime
src/app/           runtime wiring, the web port (health check, dashboards) and the daemon manager
src/dashboards/    dashboard spec, validation, data loading, rendering, service; core/ is shared with ui/
ui/                dashboard browser components (bundled into every dashboard)
e2e/               Playwright tests for the dashboard UI
src/core/          agent loop, prompts, planning, context manager, profiles, stuck detection
src/tools/         tool definitions, registry, executor, DuckDB engine
src/safety/        workspace guard, file state, permissions, SSRF guard, env scrubbing
src/sandbox/       command sandbox server and client (the optional sidecar container)
src/net/           domain registry and reachability probes
src/llm/           Claude Code and Anthropic providers, scripted provider, pricing, spend tracking
src/learning/      run store, taxonomy, judge, bandit, reflection, skill synthesis
src/scrapers/      spec schema, polite HTTP client, robots.txt, extractors, runner, registry
src/scheduler/     cron scheduler
src/discord/       commands, router, auth, approvals, notifier, discord.js client
src/knowledge/     vault search (BM25), lint and index tools
tests/             Jest suites
```

## Security model

The harness runs untrusted model output against real systems, so it is locked down by default:
deny-by-default Discord access with a separate admin list, an allow/ask/deny permission layer
for shell commands (unattended runs turn "ask" into "deny"), approvals through Discord buttons,
a workspace guard that blocks path escapes including symlinks, read-before-write checks,
read-only mounts for datasets, the vault and skills, an SSRF guard on every fetch and redirect,
secrets scrubbed from the shell environment, a sandboxed DuckDB connection and daily spend
caps. Learned skills never activate without a human approval. Fetched content is labeled as
untrusted, and the base prompt tells agents never to follow instructions found in it. The main
residual risk is the allow-listed interpreters (`python3`, `duckdb`, `sqlite3`); the hardened
deployment (`docker-compose.sandbox.yml`) runs every shell command in a sidecar container with no
network and no secrets. [docs/security.md](docs/security.md) explains the defaults and how to
harden further.

## The knowledge vault

`knowledge/` is an Obsidian vault on data scraping in the Karpathy LLM Wiki layout: `raw/`
holds immutable sources, `wiki/<topic>/` holds compiled articles, and `wiki/index.md` and
`wiki/log.md` keep it navigable. Topics run from HTTP fundamentals, parsing and crawling to
anti-bot measures, legal and ethical limits, data quality, storage, operations, tools, LLM-based
extraction, a catalog of public sources and the harness itself. Open the folder in Obsidian, or
let the `librarian` agent maintain it with the vendored `karpathy-llm-wiki` skill. The rules
are in [knowledge/AGENTS.md](knowledge/AGENTS.md); `npm run vault:lint` checks them. To raise
accuracy, `npm run cli -- vault status` measures how grounded the vault is, `vault queue` ranks
articles for verification, `vault links` finds dead citations, and `vault verify` (or the opt-in
`vault-verify` job) has the librarian ground articles in captured sources.

## Development

```bash
npm run check          # lint, typecheck, tests
npm run test:coverage  # Jest with coverage thresholds
npm run test:e2e       # dashboard UI in Chromium (npx playwright install chromium first)
npm run format         # Prettier
npm run vault:lint     # vault rules
```

Tests never call the real API, Claude Code or Discord: the scripted provider, a fake CLI runner,
fake fetch and fake cron factories stand in for them. See [CLAUDE.md](CLAUDE.md) for conventions when using a coding
agent on this repository.

## Credits

- Harness design: "An Empirical Study of Harness Design for Coding Agents" (arXiv 2609.20804).
- LLM Wiki pattern: Andrej Karpathy; skill by Astro-Han (MIT), `skills/karpathy-llm-wiki`.
- Karpathy method skills: LearnPrompt (MIT, unofficial), `skills/vendor-karpathy`.
