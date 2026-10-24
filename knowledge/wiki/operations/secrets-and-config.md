---
tags: [scraping, operations, secrets, configuration, security]
aliases: [secrets management, environment variables, dotenv, API keys, credential rotation, config validation]
---

# Secrets and Configuration

> Sources: The Twelve-Factor App, III. Config (https://12factor.net/config); OWASP Secrets Management Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html); GitHub Docs, Using secrets in GitHub Actions (https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets) and Secrets reference (https://docs.github.com/en/actions/reference/security/secrets); GitHub Docs, Push protection (https://docs.github.com/en/code-security/concepts/secret-security/push-protection); Docker docs, Secrets in Compose (https://docs.docker.com/compose/how-tos/use-secrets/); Node.js CLI, --env-file (https://nodejs.org/api/cli.html#--env-filefile); pydantic-settings (https://docs.pydantic.dev/latest/concepts/pydantic_settings/); SOPS (https://github.com/getsops/sops); gitleaks (https://github.com/gitleaks/gitleaks)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scrapers accumulate credentials: API keys, proxy passwords, webhook URLs, database URLs, LLM keys, and session cookies from logged-in browsers. Treat all of them as secrets that never enter git, container images, logs or prompts. Keep ordinary configuration (start URLs, limits, schedules) in version control, inject secrets at runtime from the environment or a secret store, validate both at startup so a bad deploy fails in the first second instead of at 03:00, and plan rotation before you need it.

## Config versus secrets

| Kind | Examples | Where it lives |
|---|---|---|
| Configuration | Start URLs, selectors, concurrency, schedule, feature flags | In git (for example a scraper spec, see [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md)) |
| Secrets | API keys, tokens, passwords, proxy credentials, webhook URLs, session cookies, private keys | Environment variables or files injected at runtime, a secret store, or encrypted files |
| Derived state | Cookies jars, Playwright `storageState`, OAuth refresh tokens | Treated as secrets; stored encrypted with short lifetimes |

The Twelve-Factor test applies: could the code be published right now without compromising any credential? If not, something secret is in the repository.

## Where secrets live

| Environment | Mechanism | Notes |
|---|---|---|
| Local development | `.env` file in `.gitignore` | Load with pydantic-settings or python-dotenv, or `node --env-file=.env` (added in Node 20.6, stable since 22.21) |
| VPS with Compose | `env_file:` with `chmod 600`, or Compose `secrets:` | Compose mounts each secret as a file at `/run/secrets/<name>` (Linux containers only), which keeps it out of `docker inspect` and child-process environments |
| systemd | `EnvironmentFile=` (mode 0600, owned by root) | systemd reads the file as root before starting the service, so the file can stay root-only; the values reach only that service's environment |
| GitHub Actions | Repository, organization or environment secrets | Up to 100 repository secrets, 48 KB each; not passed to workflows triggered from forks (except `GITHUB_TOKEN`); environments can require a reviewer |
| Cloud runtimes | AWS Secrets Manager or SSM Parameter Store, Google Secret Manager (Cloud Run `--set-secrets`), Azure Key Vault | IAM decides which workload reads which secret |
| Self-hosted store | HashiCorp Vault or OpenBao, or a team password manager CLI | Dynamic, short-lived credentials where supported |
| Encrypted in git | SOPS with age or a cloud KMS | Values encrypted, keys readable; reviewable diffs |

GitHub notes that redaction of secrets in workflow logs is not guaranteed when a value is transformed (encoded, split, embedded in JSON), and that secrets passed on a command line can be visible to other processes. Prefer environment variables or stdin.

## Encrypting a .env with SOPS and age

Tested with sops 3.13 and age:

```bash
age-keygen -o ~/.config/sops/age/keys.txt           # prints the public key (age1...)
sops encrypt --age age1yourpublickey... .env > secrets.enc.env   # commit this file, not .env
export SOPS_AGE_KEY_FILE=~/.config/sops/age/keys.txt
sops exec-env secrets.enc.env 'python -m scraper.main --once'      # secrets exist only in that process
```

Keep the `.env` suffix on the encrypted file: SOPS picks the format from the extension, so a name like `secrets.env.enc` is not read as dotenv and decryption fails unless you add `--input-type dotenv`.

## Validate configuration at startup

Python with pydantic-settings: typed fields, defaults, and `SecretStr` so secrets print as asterisks.

```python
from pydantic import Field, HttpUrl, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SCRAPER_", env_file=".env", extra="ignore")

    start_url: HttpUrl
    user_agent: str = "acme-research-bot/1.0 (+https://acme.example/bot)"
    concurrency: int = Field(default=4, ge=1, le=32)
    request_timeout_s: float = 20.0
    api_token: SecretStr
    discord_webhook_url: SecretStr | None = None


settings = Settings()        # raises a ValidationError listing every bad or missing field
print(settings.api_token)    # **********
token = settings.api_token.get_secret_value()  # only where it is actually used
```

TypeScript with zod 4: parse `process.env` once and export the typed result.

```typescript
import { z } from "zod";

const Env = z.object({
  START_URL: z.url(),
  USER_AGENT: z.string().min(10).default("acme-research-bot/1.0 (+https://acme.example/bot)"),
  CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  API_TOKEN: z.string().min(1),
  DISCORD_WEBHOOK_URL: z.url().optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  // name the broken variables, never print their values
  console.error("invalid configuration:", parsed.error.issues.map((i) => i.path.join(".")).join(", "));
  process.exit(1);
}
export const env = parsed.data;
```

## Keep secrets out of git and images

- `.gitignore` from day one: `.env`, `*.pem`, `*.key`, cookie jars, Playwright `storageState` files, `*.har`, local databases.
- Scan before pushing: `gitleaks git` (history) and `gitleaks dir` (working tree), ideally as a pre-commit hook and in CI. GitHub push protection for users is enabled by default and blocks pushes of recognized secret formats to public repositories, but it only knows token patterns, not your proxy password.
- Never bake secrets into images: no `ENV API_TOKEN=...` and no `COPY .env` in a Dockerfile, because image layers keep them. Pass them at run time; for build-time needs (a private package index), use BuildKit secret mounts (`RUN --mount=type=secret,id=...`).
- If a secret leaks, **revoke and rotate first**. Rewriting history afterwards (for example with `git filter-repo`) does not help against copies already fetched, forked or cached.

## Scraper-specific secrets

- **Session cookies and browser storage state** from logged-in sessions usually grant full account access. Store them encrypted, give them short lifetimes, and only automate logins where the site's terms allow it (see [Authentication Patterns](../http/authentication-patterns.md) and [Cookies, Sessions and State](../http/cookies-and-sessions.md)).
- **HAR files** exported from DevTools contain cookies and tokens unless sanitized, and even "sanitized" exports keep tokens in URLs and bodies (see [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)).
- **Proxy URLs** embed credentials (`http://user:pass@host:port`); redact them in logs and error messages.
- **Webhook URLs** for Discord and Slack are bearer credentials for posting to a channel.
- **LLM and paid API keys** should have per-key spending caps and a separate key per scraper, so one runaway loop can be cut off without stopping everything (see [Cost Control](cost-control.md)).
- **Agents.** Never paste secrets into prompts, specs or knowledge articles. Tools should read them from the environment at execution time, and logs and transcripts should show only the variable name.

## Rotation

Keep an inventory: secret name, owner, where it is used, how to rotate it, expiry date. Rotate on a schedule and immediately when a person leaves or a leak is suspected. Design for overlap: accept two valid keys during a rollover (old and new) so rotation needs no downtime. Prefer short-lived credentials (OIDC from CI to the cloud, dynamic database users) over long-lived static keys where the platform supports them, which is also the OWASP cheat sheet's direction.

## Pitfalls

- `print(settings)` or an exception message that includes the full config, secrets included.
- Tokens in query strings, which end up in access logs, proxies and `Referer` headers.
- One API key shared by every scraper and every environment, so rotation breaks everything at once.
- A `.env` committed once and deleted in the next commit: still in history.
- Secrets readable by every user on a shared VPS (`chmod 644` environment files).
- Exporting secrets in a CI step and then running untrusted code (third-party actions, pull requests from forks) in the same job.

## Checklist

- [ ] Configuration in git, secrets injected at runtime
- [ ] Config validated at startup with typed fields and secret types
- [ ] `.gitignore` covers env files, keys, cookie jars, storage state, HAR files
- [ ] Secret scanning in pre-commit and CI
- [ ] No secrets in images, logs, URLs or prompts
- [ ] Separate, least-privilege keys per scraper and environment
- [ ] Inventory with owners and a rotation procedure

## See Also

- [Authentication Patterns](../http/authentication-patterns.md)
- [Logging and Observability](logging-and-observability.md)
- [Cheap Hosting for Scrapers](cheap-hosting.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [Cookies, Sessions and State](../http/cookies-and-sessions.md)
- [Declarative Scraper Specs in This Harness](../harness/harness-scraper-spec.md)
