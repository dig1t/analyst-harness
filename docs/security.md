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
without asking, because analysis needs them. An interpreter runs with the harness user's
rights: it can open the network and read files the workspace guard does not cover, including
the harness process's environment through `/proc`. A prompt injection in fetched content could
use that. The defaults limit the exposure: unattended runs (scraper repairs), which read
untrusted pages with nobody watching, do not get `bashAllowExtra` unless you set
`permissions.cronAllowExtra: true`. To harden further:

- Remove the interpreters from `bashAllowExtra` so every script needs an approval.
- Use an API key with a spend limit and a bot token that can only reach your server.
- Restrict the container's outbound traffic to the hosts it needs, with a host firewall or
  an egress proxy.
- Running tool commands in a separate sandbox container without secrets is the natural next
  step and is not implemented yet.

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
memory and process limits, the health endpoint bound to loopback, and secrets only in `.env`
(never in `config/harness.yaml` or the image).

## Reporting a problem

Open a private security advisory on the GitHub repository rather than a public issue.
