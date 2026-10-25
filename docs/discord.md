# Discord

The bot reports scraper alerts, digests and run results, and takes commands. It connects out
to the Discord gateway, so it works behind NAT without inbound ports.

## Setup

1. Create an application at the Discord developer portal and add a bot user.
2. Invite it with the `bot` and `applications.commands` scopes and the permissions Send
   Messages, Embed Links, Attach Files and Read Message History.
3. Set the environment:

| Variable                                                    | Required       | Purpose                                                          |
| ----------------------------------------------------------- | -------------- | ---------------------------------------------------------------- |
| `DISCORD_TOKEN`                                             | Yes            | Bot token                                                        |
| `DISCORD_APPLICATION_ID`                                    | Yes            | Registers the slash commands at startup                          |
| `DISCORD_GUILD_ID`                                          | Recommended    | Registers commands on one server (instant) instead of globally   |
| `DISCORD_ALLOWED_USER_IDS`                                  | One allow-list | Comma-separated user ids that may use the bot                    |
| `DISCORD_ALLOWED_ROLE_IDS`                                  | One allow-list | Role ids that may use the bot                                    |
| `DISCORD_ADMIN_USER_IDS`                                    | Recommended    | Users who may run admin commands and approve any run             |
| `DISCORD_ALLOW_EVERYONE`                                    | No             | `true` opens the bot to everyone in the server (not recommended) |
| `DISCORD_REPORTS_CHANNEL_ID`                                | No             | Where digests and new-record reports go                          |
| `DISCORD_ALERTS_CHANNEL_ID`                                 | No             | Where failure alerts go                                          |
| `DISCORD_WEBHOOK_REPORTS_URL`, `DISCORD_WEBHOOK_ALERTS_URL` | No             | Webhook delivery, with or without the bot                        |

Without an allow-list the bot answers nobody. `harness discord commands` prints the command
JSON if you prefer to register commands yourself.

## Commands

| Command                                        | What it does                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------- |
| `/ask task [agent] [profile]`                  | Runs an agent task; progress updates appear as it works          |
| `/scrape list`                                 | Scrapers, schedules and status                                   |
| `/scrape run name [dry_run]`                   | Runs a scraper now                                               |
| `/scrape status name`                          | Recent history, failure streak, last error                       |
| `/scrape repair name`                          | Asks the scraper-engineer agent to diagnose and propose a fix    |
| `/scrape apply name`                           | Admin: applies `proposals/scrapers/<name>.yaml` after validation |
| `/jobs`                                        | Scheduled jobs and next run times                                |
| `/runs [limit]`, `/run id`, `/stop id`         | Recent runs, one run's details, stop a running task              |
| `/feedback id good or bad`                     | Rates a run; feeds the profile bandit                            |
| `/budget`                                      | Today's spend against the daily cap                              |
| `/skills list`, `/skills proposed`             | Active skills and drafts from the learning loop                  |
| `/skills approve name`, `/skills reject name`  | Admin: activate or discard a drafted skill                       |
| `/knowledge query [topic]`, `/lessons [query]` | Search the vault and the lessons                                 |
| `/learn`                                       | Admin: run the learning loop now                                 |
| `/profiles [task_type]`                        | What the bandit learned per model and task type                  |
| `/status`, `/help`                             | Health and the command list                                      |

Results carry thumbs up and down buttons (`feedback:up:<runId>`), which count double in the
bandit. With `discord.prefixCommands: true`, messages such as `!ask ...` work too; that needs
the privileged Message Content intent enabled in the developer portal.

## Approvals

When a run started from Discord wants to do something the permission policy marks "ask" (a
shell command outside the allow-list, a sensitive file, a write when writes need approval),
the bot posts the request with Approve and Deny buttons in the same channel. Only the person
who started the run or an admin can answer. No answer within `discord.approvalTimeoutSec`
(default 300) counts as a denial, and scheduled runs never wait: their "ask" is a "deny".

## Long answers

Replies are split to fit Discord's limits; tables become code blocks and long reports are
attached as Markdown files. Slash command tokens expire after 15 minutes, so long runs finish
with a regular channel message instead of an interaction reply.
