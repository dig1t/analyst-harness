# Domain registry

Agents waste time and tokens when they try sources that cannot answer: a host that is down,
one that a sandbox's allow-list blocks, or one that resolves nowhere. The harness keeps two
records of which hosts answer, and uses them to skip dead ends.

| Record                    | Where                     | Written by                                   |
| ------------------------- | ------------------------- | -------------------------------------------- |
| The registry (checked in) | `config/domains.yaml`     | `harness domains check ... --save`           |
| Live observations         | `data/state/domains.json` | every `web_fetch`, scraper request and probe |

The registry has one column per environment (`server`, `claude-code-cloud`, or any name you
give with `HARNESS_ENVIRONMENT`) and one line per host, with an optional note such as an API's
base path:

```yaml
hosts:
  pypi.org:
    { claude-code-cloud: ok, note: 'JSON API, no key: /pypi/<package>/json (releases, files, upload times)' }
  www.ecb.europa.eu: { claude-code-cloud: unreachable, note: 'Euro reference rates as XML: ...' }
```

Statuses: `ok`, `http-<code>` (the host answers, with an error), `unreachable` (DNS, refused
connection or TLS failure), `timeout`, `blocked` (a proxy refused the tunnel).

## What agents get

- `web_fetch` refuses a host at once, without a request, when it failed at the network level
  3 times in a row in the last 6 hours (`domains.failFastAfter`, `domains.failFastHours`), or
  when the registry lists it as unreachable from this environment and it never answered here.
  The refusal says why and suggests `domain_status`; `force: true` retries anyway. Any answer,
  even an HTTP error, clears the refusal.
- `domain_status` reports, for given hosts, what was observed here and what the registry says
  for every environment; with no hosts, a summary of this environment.

## Checking hosts

```bash
npm run cli -- domains                                  # summary for this environment
npm run cli -- domains pypi.org www.ecb.europa.eu       # what is known about two hosts
npm run cli -- domains check --vault --scrapers         # probe every vault citation and scraper source
HARNESS_ENVIRONMENT=claude-code-cloud npm run cli -- domains check --vault --scrapers --save
```

`--save` writes this environment's results into `config/domains.yaml` (from a checkout; the
container image's copy is read-only). Probes are one GET per host with redirects checked by the
SSRF guard, eight at a time. Commit the file so every deployment and every coding agent starts
with the same map.

The shipped registry was probed on 2026-10-25 from the Claude Code cloud sandbox, which reaches
only an allow-list of hosts: of the 310 hosts the vault and the scrapers cite, about a dozen
answered there. The `server` column fills in when you run the check on your server.
