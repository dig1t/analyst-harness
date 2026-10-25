# Getting started

analyst-harness is a data analyst agent that lives on your machine. Once it is installed:

- it is always running in the background: scheduled scrapers, the learning loop, the Discord
  bot if you set one up, and dashboards at <http://127.0.0.1:8080/dashboards/>;
- every Claude Code session on the machine (terminal, IDE or desktop app, in any project)
  checks that it is running, starts it if it is not, and is told how to use it;
- the `harness` command works in your terminal and in Claude Code's shell.

This page covers installing, using and removing it. [README.md](README.md) describes what is
inside.

## 1. Requirements

- macOS or Linux. On Windows, use WSL 2 and do everything inside the Linux distribution.
- Node.js 22 or newer with npm (`node --version`). The installer from nodejs.org,
  [nvm](https://github.com/nvm-sh/nvm) and Homebrew all work.
- git and [Claude Code](https://code.claude.com/docs).
- An Anthropic API key for agent runs (`harness run`, `/ask` in Discord). Scrapers, dashboards
  and the knowledge vault work without one.
- Optional: Python 3 for the analysis scripts agents write, and Docker for a 24/7 server or the
  command sandbox.

## 2. Install

Pick a permanent folder, because the session hook points at it.

```bash
git clone https://github.com/firebit-dev/analyst-harness ~/analyst-harness
cd ~/analyst-harness
bash scripts/install.sh
```

The installer:

1. installs the npm dependencies and builds the harness;
2. creates `.env` from `.env.example`, readable only by you;
3. puts a `harness` command in `~/.local/bin` (set `HARNESS_BIN_DIR` to pick another folder)
   and tells you if that folder is not on your `PATH`;
4. adds a SessionStart hook to your Claude Code user settings, `~/.claude/settings.json` (or
   `$CLAUDE_CONFIG_DIR/settings.json`), keeping everything else in the file and saving the
   previous version as `settings.json.bak`;
5. starts the harness in the background and runs `harness doctor`.

Running it again is safe: it updates the install in place. `bash scripts/install.sh --no-hook`
installs without the Claude Code hook.

## 3. Add your keys

Open `.env` in the harness folder and set at least:

```bash
ANTHROPIC_API_KEY=sk-ant-...
```

Then run `harness daemon restart` so the running harness reads it.

The harness reads `.env` every time it starts. A variable that is already set in the
environment wins over the file, so a key exported in your shell profile (or in Claude Code's
environment) is the one used. Secrets belong in `.env` or the environment, never in
`config/harness.yaml`.

Other settings you may want:

| Variable                                                                                  | What it does                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, `DISCORD_GUILD_ID`, `DISCORD_ALLOWED_USER_IDS` | Turn on the Discord bot ([docs/discord.md](docs/discord.md))                                                  |
| `DISCORD_WEBHOOK_REPORTS_URL`, `DISCORD_WEBHOOK_ALERTS_URL`                               | Reports and alerts in Discord without a bot                                                                   |
| `DASHBOARD_PASSWORD`                                                                      | Password for the dashboards (user `harness`)                                                                  |
| `PORT`                                                                                    | Web port, `8080` by default                                                                                   |
| `HOST`                                                                                    | `127.0.0.1` by default (this machine only); `0.0.0.0` opens the dashboards to your network, so set a password |
| `HARNESS_DAILY_BUDGET_USD`, `HARNESS_RUN_BUDGET_USD`                                      | Spend caps for model calls                                                                                    |

`harness doctor` checks the result.

## 4. Always running: how it works

Every Claude Code session runs the hook when it starts, resumes, clears or compacts. The hook:

- rebuilds the harness when its code changed (after a `git pull`, for example) and restarts it;
- starts it when it is not running. There is one copy per machine, shared by all sessions, and
  it keeps running after the session ends;
- adds a short note to the session, so Claude knows the harness is running, where the
  dashboards are and which `harness` commands to use. You can simply ask Claude to "scrape the
  ECB exchange rates with the harness and build a dashboard";
- puts `harness` on the `PATH` of the session's shell.

A normal check takes under a second and a rebuild about 15 seconds. A problem never stops a
session: if the harness cannot start, the session starts anyway and the note says what went
wrong and how to fix it.

After a reboot or a crash, the next Claude Code session starts the harness again. To keep
scrapers running around the clock without any session, run it on a server as well
([section 7](#7-run-it-247-on-a-server)).

Control it from any terminal:

```bash
harness daemon status      # running? pid, URL and log file (exit code 3 when stopped)
harness daemon logs        # the last 60 log lines (--lines 200 for more)
harness daemon restart     # after editing .env or config/
harness daemon stop        # stopped until the next session or `harness daemon start`
node ~/analyst-harness/scripts/claude-hook.js status    # is the hook registered?
```

In Claude Code, `/hooks` lists the hook. To skip it for one session, start Claude Code with
`HARNESS_AUTOSTART=0 claude`.

### Cloud sessions (Claude Code on the web)

This repository registers the same hook in `.claude/settings.json`, so a cloud session opened
on it installs, builds and starts the harness by itself (about 15 seconds on the first start).
Add `ANTHROPIC_API_KEY` as an environment variable in the cloud environment's settings (the
environment menu in the session's title bar, then Edit); new sessions pick it up. The hook on
your own machine does not reach cloud sessions of other repositories.

## 5. Use it

| Command                                                           | What it does                                                                        |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `harness run "Summarize the latest Hacker News stories by score"` | Give the analyst agent a task                                                       |
| `harness scrapers`                                                | List the scrapers with their schedules                                              |
| `harness scrape hn-top-stories` (add `--dry-run` to preview)      | Run a scraper now; datasets land in `data/datasets/`                                |
| `harness explore hn-top-stories`                                  | Build an explorer dashboard for a dataset                                           |
| `harness dashboard list`                                          | List dashboards; open them at <http://127.0.0.1:8080/dashboards/>                   |
| `harness dashboard build my-spec.yaml`                            | Build a dashboard from a spec ([docs/dashboards.md](docs/dashboards.md))            |
| `harness vault search "rate limits"`                              | Search the scraping knowledge vault                                                 |
| `harness domains example.com`                                     | Check whether a site answers from this machine ([docs/domains.md](docs/domains.md)) |
| `harness runs`, `harness learn`, `harness profiles`               | Past runs and what the learning loop picked up                                      |
| `harness doctor`                                                  | Check the configuration                                                             |

`harness` on its own prints every command. To add a scraper, put a YAML spec in
`config/scrapers/` ([docs/scrapers.md](docs/scrapers.md)) and run `harness daemon restart` to
schedule it.

## 6. Update

```bash
cd ~/analyst-harness && git pull
```

The next Claude Code session rebuilds and restarts it. To do it right away, run
`bash scripts/install.sh`.

## 7. Run it 24/7 on a server

For scrapers and the Discord bot around the clock, run the Docker image on a small VPS
([docs/deployment.md](docs/deployment.md)). When a harness already answers on the port (a
container on the same machine, for example), sessions use it and do not start a second copy.

## Troubleshooting

| Symptom                                                | Fix                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| The session note says the harness could not be started | Run `bash scripts/install.sh` in the harness folder, then read `harness daemon logs`                                      |
| `port 8080 is already in use`                          | Another program has the port: set `PORT=8090` in `.env`, then `harness daemon start`                                      |
| `harness: command not found`                           | Add `~/.local/bin` to your `PATH` (the installer prints the line), or call `~/analyst-harness/bin/harness`                |
| You moved or renamed the folder                        | Run `bash scripts/install.sh` from the new place; it replaces the old hook                                                |
| The hook does not run                                  | Check `node scripts/claude-hook.js status` and `/hooks`; the installer refuses to edit a `settings.json` that is not JSON |
| Agent runs fail with an authentication error           | Set `ANTHROPIC_API_KEY` in `.env`, then `harness daemon restart`                                                          |

Logs are in `data/logs/harness.log` (rotated at 10 MB). Runs, datasets, dashboards and state are
under `data/`.

## Uninstall

```bash
bash ~/analyst-harness/scripts/install.sh --uninstall
```

This stops the harness and removes the hook and the `harness` command. Your data, `.env` and
configuration stay in the folder; delete the folder to remove everything.
