# CLAUDE.md

Guidance for coding agents working on this repository.

## Commands

```bash
npm ci
npm run check          # eslint, tsc (src, tests, ui, e2e), jest
npm run test:e2e       # Playwright: the dashboard UI in Chromium
npm run test:coverage  # coverage thresholds: 80% lines/functions/statements, 70% branches
npm run format         # prettier --write .
npm run vault:lint     # knowledge vault rules (must report 0 errors)
npm run cli -- doctor  # configuration check
npm run cli -- daemon status  # the background harness the session hook keeps running
```

Run `npm run check` and `npm run format:check` before committing.

## Conventions

- TypeScript strict, CommonJS output (`module: nodenext`). Use static imports: dynamic
  `import()` breaks under Jest here. The optional DuckDB package is loaded with `require`
  inside `loadDuckDb`.
- TypeScript stays on 6.x until ts-jest and typescript-eslint support 7.
- Validate external input with zod (config, scraper specs, agent and skill frontmatter, tool
  inputs). Config schemas are strict: a new key needs a schema entry and a default.
- Tools never throw to the model: `executeToolCall` turns errors into error results. Throw
  `ToolError` for model-fixable problems and `PermissionDeniedError` for policy refusals.
- Tests are hermetic: no network, no real API, no Discord. Use `ScriptedProvider`,
  `fakeFetch`, fake cron factories and temporary directories from `tests/helpers.ts`.
- Never write the em dash character (U+2014) in authored files; a test enforces it. Vendored
  skills under `skills/vendor-karpathy` and `skills/karpathy-llm-wiki` are exempt and must stay
  unmodified (see their `VENDORED.md`).
- Secrets only come from the environment (`.env` is loaded into it on start and never overrides
  it). Never add them to `config/harness.yaml`.

## Where things live

- Agent loop and paper components: `src/core/` (see `docs/paper-mapping.md`).
- Tools: `src/tools/`; register new ones in the `ToolRegistry` built in `src/app/runtime.ts`
  and give each a `usageRule`, a precise `readOnly` flag and a `category`.
- Safety layer: `src/safety/`. Changes here need tests for the bypass you are preventing. The
  command sandbox (`src/sandbox/`) runs bash in a sidecar container; keep the permission checks in
  the harness, never in the sandbox.
- Learning loop: `src/learning/`; runtime wiring: `src/app/runtime.ts`.
- Always-on install ([GETTING_STARTED.md](GETTING_STARTED.md)): `scripts/install.sh`,
  `scripts/claude-hook.js` (registers the user-level SessionStart hook),
  `scripts/claude-session-start.js` (the hook; `.claude/settings.json` also runs it for this
  repository) and `src/app/daemon.ts` (`harness daemon`). The hook must never fail a session:
  it reports problems as session context and exits 0. It rebuilds when `src/` or `ui/` changed,
  and `harness daemon start` restarts a daemon still running an older build. `HARNESS_AUTOSTART=0`
  skips the hook.
- Scrapers: `src/scrapers/` and `config/scrapers/*.yaml` (`docs/scrapers.md`).
- Discord: `src/discord/` (router logic is tested; `client.ts` is a thin discord.js adapter).
- Domain registry: `src/net/` and `config/domains.yaml` (`docs/domains.md`). Before relying on a
  new web source, check it with `npm run cli -- domains <host>`; when you probe hosts from a
  sandbox, record them with `HARNESS_ENVIRONMENT=<name> npm run cli -- domains check <host> --save`.
- Dashboards: `src/dashboards/` (spec, validation, loading, rendering, service) with pure cores in
  `src/dashboards/core/` shared by the browser components in `ui/` (`docs/dashboards.md`).
  Browser code must not import Node modules; `npm run test:e2e` runs the UI in Chromium.

## Knowledge vault

`knowledge/` follows `knowledge/AGENTS.md`: relative Markdown links (no wikilinks), the
`> Sources / Raw / Updated` block, a See Also section, no em or en dashes, and an entry in
`wiki/index.md` for every article. Regenerate the index with `npm run cli -- vault index`
only if you accept its generated summaries; otherwise edit the index row by hand.
