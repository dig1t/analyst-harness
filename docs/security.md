# Security

An agent that runs shell commands and fetches URLs on a server, steered from a chat app, is
a remote code execution service by design. Every layer below assumes the model can be wrong or
manipulated (for example by text in a scraped page) and limits what that can cost.

## Who can drive it

- Discord access is deny by default: only listed user ids or role ids get answers, and admin
  commands (`/scrape apply`, `/skills approve`, `/skills reject`, `/learn`) need an admin id.
- Approval prompts can only be answered by the requester or an admin, and expire as denials.
- The CLI is for whoever has a shell on the server.

## What a run can touch

- **Workspace guard** (`src/safety/workspace.ts`): every path resolves inside a mount. `..`,
  absolute paths outside mounts and symlinks that leave a mount are rejected.
- **Mount modes**: datasets are always read-only; the vault, skills and scraper specs are
  read-only unless the agent definition grants `rw` (only the librarian writes the vault).
  Learned skills are always read-only to agents.
- **Read before write** (`src/safety/file-state.ts`): overwriting or editing a file requires a
  full read first, and fails if the file changed on disk since then.
- **Sensitive files** (`.env`, keys, credentials) need explicit approval to read.

## Shell commands

`src/safety/permissions.ts` classifies each command:

- **deny**: recursive force deletes, `sudo`, `git push` and history-destroying git commands,
  recursive `chmod` and `chown`, disk formatting and raw device writes, shutdown and
  `systemctl`, fork bombs, piping a download into a shell, plus `permissions.bashDenyExtra`.
- **allow**: read-only inspection commands (`ls`, `cat`, `grep`, `jq`, `find` without
  `-exec` or `-delete`, read-only git and similar) and `permissions.bashAllowExtra`, as long as
  the command has no command substitution and no output redirection.
- **ask**: everything else. Interactive runs ask a human; unattended runs deny.

Commands run with a scrubbed environment: variables that look like secrets (keys, tokens,
passwords) are removed unless listed in `tools.bashPassEnv`. Each command has a timeout and
its whole process group is killed on timeout or abort.

**Residual risk: interpreters.** The default config allows `python3`, `duckdb` and `sqlite3`
without asking, because analysis needs them. In the single-container deployment an interpreter
runs with the harness user's rights: it can open the network and read files the workspace guard
does not cover, including the harness process's environment (the API key and the bot token)
through `/proc`. A prompt injection in fetched content could use that. Unattended runs (scraper
repairs), which read untrusted pages with nobody watching, do not get `bashAllowExtra` unless you
set `permissions.cronAllowExtra: true`.

### The command sandbox

The hardened deployment moves every shell command into a second container:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d
```

The `sandbox` container runs `dist/sandbox/main.js`, a small server on a Unix socket shared
with the harness. It has no network (`network_mode: none`), no secrets and no harness
environment, a separate PID namespace (so `/proc` shows nothing of the harness), a read-only
root filesystem, dropped capabilities and its own memory, CPU and process limits. It mounts only
the workspace (read-write) and the datasets and dashboards (read-only); runs, state, the vault
and the skills stay out of reach. The harness keeps every decision: the permission layer still
classifies each command and asks for approval before anything is sent, and only the variables
listed in `tools.bashPassEnv` travel with a command. Timeouts and aborts kill the command's
whole process group in the sandbox.

`HARNESS_SANDBOX_SOCKET` (or `tools.sandboxSocket`) switches the bash tool to the sandbox. If
the sandbox is down, commands fail with a clear error instead of falling back to local
execution. Analysis scripts that need packages get them from the image, not from `pip install`
at run time. Volume subpaths need Docker Engine 26 or newer; without them, keep the
single-container deployment and the other measures below.

## Untrusted content

Fetched pages, API responses and scraped records can carry instructions aimed at the model. The
base prompt tells agents to treat outside content as data and to report, not follow,
instructions found in it, and every `web_fetch` result is labeled as untrusted external content.
Labels lower the odds; the sandbox and the permission layer limit the damage when they fail.

## Further hardening

- Remove the interpreters from `bashAllowExtra` so every script needs an approval.
- Use an Anthropic API key with a spend limit, used only by this deployment, and a Discord bot
  invited with the smallest set of permissions.
- Restrict the harness container's outbound traffic to the hosts it needs, with an egress
  proxy or host firewall rules (the domain registry, `config/domains.yaml`, lists them).
- Run the sandbox under a stronger container runtime such as gVisor (`runtime: runsc`).
- Reach dashboards through an SSH tunnel or a private network rather than a public port.
- Rotate the API key and the bot token on a schedule, and whenever a run did something you
  cannot explain.
- Pin the image by digest in production and verify it before deploying.

## Network

- `src/safety/net-guard.ts` resolves every host and refuses private, loopback, link-local,
  metadata and other reserved addresses, on the first request and on every redirect hop
  (manual redirects). `tools.allowPrivateNetwork: true` turns this off for local testing only.
- Scrapers honor robots.txt by default, send an identifying User-Agent, keep per-host
  intervals and back off on 429 and 503 with `Retry-After`.

## SQL

`sql_query` runs DuckDB on a fresh connection per run with external access disabled, file
access limited to the workspace and datasets (`allowed_directories`), `ATTACH` and URLs
rejected, writes (`COPY ... TO`) refused on read-only mounts and the configuration locked
before the query runs.

## Dashboards

Dashboards are static files with a strict Content Security Policy (`default-src 'none'`,
`connect-src 'none'`): they cannot load or send anything. Values are inserted as text, the
embedded JSON escapes `<`, `>`, `&`, U+2028 and U+2029, and markdown notes are rendered on the
server to a safe subset. The web server answers GET and HEAD for four whitelisted files per
dashboard, sets `nosniff`, `no-referrer` and the CSP as headers, and checks basic auth
(`DASHBOARD_PASSWORD`) in constant time. Publishing is a write, so read-only runs cannot do it.
A dashboard embeds its data: share it like the data. See [dashboards.md](dashboards.md).

## Money

A daily cap (`budgets.dailyUsd`) and a per-run cap (`budgets.runUsd` or the agent's
`budget_usd`) stop runs before they exceed their budget. Judge and reflection calls count too.

## Learning cannot escalate

Lessons are text in the vault. Skill drafts sit in `proposed/` and never load until an admin
approves them. Scraper fixes are proposals until an admin applies them, and the applied spec is
validated against the schema first.

## Container

Non-root user, read-only root filesystem, all capabilities dropped, `no-new-privileges`,
memory and process limits, the web port bound to loopback, and secrets only in `.env` (never in
`config/harness.yaml` or the image). The optional sandbox container adds no network and no
secrets for shell commands (see above).

## Reporting a problem

Open a private security advisory on the GitHub repository rather than a public issue.
