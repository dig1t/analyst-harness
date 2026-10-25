# Architecture

## Process model

One Node process (`src/index.ts`) runs everything: the scheduler, the Discord bot, the agent
runs and a health endpoint. Agent runs are async tasks inside that process; tool calls spawn
short-lived child processes for the shell. There is no database server: state is JSON and
JSONL files on disk, which keeps the footprint small and backups trivial.

```
src/index.ts
  loadConfig()                      config/harness.yaml + environment
  HarnessRuntime.create()           wires everything below
    provider                        Anthropic (or scripted for offline use)
    SpendTracker                    daily cap, persisted in data/state/spend.json
    RunStore                        data/runs/<runId>/{meta.json,events.jsonl}
    ProfileBandit                   data/state/bandit.json
    KnowledgeVault                  knowledge/ (BM25 search, lint, index)
    SkillRegistry                   skills/ plus the learned skills folder
    ScraperRegistry + ScraperRunner config/scrapers/*.yaml -> data/datasets/<name>/<date>.jsonl
    Scheduler                       croner jobs: scrape:<name>, learning, digest, vault-lint
    LearningService                 judge, bandit updates, reflection, skill proposals
    Notifier                        console, Discord webhooks, the bot
  DiscordBot                        slash commands, buttons, progress messages (optional)
  DashboardService                  specs -> data/dashboards/<slug>/ (HTML, spec, notebook, meta)
  web port                          /healthz, /dashboards/ catalog and pages (src/app/http.ts)
```

## A run, step by step

1. **Request.** `/ask` in Discord, `harness run` in a terminal, a scheduled repair, or a
   delegated sub-task calls `HarnessRuntime.runTask`.
2. **Classification.** `classifyTask` labels the task (scrape, analysis, report, research,
   knowledge, maintenance or general). The label keys the bandit.
3. **Profile.** An explicit request wins, then the agent's own profile, then the bandit (when
   `profiles.selection` is `bandit`), then the default.
4. **Workspace and permissions.** The agent gets a workspace rooted at `data/workspace` with
   mounts for `datasets/` (read-only), `knowledge/`, `skills/` and `scrapers/` as its
   definition allows. The permission manager depends on the source: unattended runs never wait
   for approvals.
5. **System prompt.** Base prompt for the action space, tool rules, the agent's instructions,
   an environment block, the skills index, a vault note and up to a few relevant lessons.
6. **Loop.** `runAgent` alternates model turns and tool batches. The context manager applies
   the profile's tier at the thresholds; the stuck detector watches repeated calls; the budget
   guard stops runs that exceed their cost cap.
7. **Record.** Every model turn, tool call, context event and plan update goes to the run's
   `events.jsonl`. The final result and usage go to `meta.json`.
8. **Learn.** Right after the run (when `learning.immediate` is true) and in the nightly sweep:
   phase labels, judge verdict, bandit update, reflection into lessons, skill proposal.

## Tools and services

Tools are zod-typed definitions (`src/tools/types.ts`) with a model-facing description, a usage
rule for the system prompt, a read-only flag and an executor. The registry selects tools per
agent and profile. Harness tools reach shared services (`ToolServices`): knowledge search,
skills, delegation, scrapers, SQL and fetch. Services are injected, so tests swap them freely.

## Scrapers

A spec (`src/scrapers/spec.ts`) describes the source (JSON, XML, CSV, HTML, RSS/Atom or sitemap), field
rules, a record key, validation thresholds, output mode and alert rules. The runner fetches
politely (robots.txt, per-host intervals, retries with `Retry-After`, conditional requests),
extracts and validates records, compares them with the last run and appends new or changed
records to the dataset. State per scraper (seen keys, validators, failure streak, history)
lives in `data/state/scrapers/<name>.json`. See [scrapers.md](scrapers.md).

## Discord

`src/discord/router.ts` maps commands to the `HarnessOps` interface, which the runtime
implements. The discord.js adapter (`src/discord/client.ts`) only translates between Discord
and the router, so the router is tested without a gateway connection. See
[discord.md](discord.md).

## Files on disk

| Path                                     | Contents                                                                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `data/runs/<runId>/`                     | `meta.json` (result, task type, profile, judge verdict, feedback), `events.jsonl` and `store.jsonl` (full tool results for `recall_event`) |
| `data/state/`                            | `spend.json`, `bandit.json` and scraper state                                                                                              |
| `data/datasets/<dataset>/<date>.jsonl`   | Scraped records, one JSON object per line                                                                                                  |
| `data/workspace/`                        | Agent working directory (reports, scripts, intermediate files)                                                                             |
| `knowledge/wiki/lessons/`                | Lessons written by reflection                                                                                                              |
| `skills/proposed/`, `skills/learned/`    | Skill drafts and approved learned skills                                                                                                   |
| `proposals/scrapers/` (in the workspace) | Spec fixes drafted by the scraper engineer                                                                                                 |
