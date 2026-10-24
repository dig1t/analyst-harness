# CLAUDE.md

Guidance for coding agents working on this repository.

## Commands

```bash
npm ci
npm run check          # eslint, tsc --noEmit, jest
npm run test:coverage  # coverage thresholds: 80% lines/functions/statements, 70% branches
npm run format         # prettier --write .
npm run vault:lint     # knowledge vault rules (must report 0 errors)
npm run cli -- doctor  # configuration check
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
- Secrets only come from the environment. Never add them to `config/harness.yaml`.

## Where things live

- Agent loop and paper components: `src/core/` (see `docs/paper-mapping.md`).
- Tools: `src/tools/`; register new ones in the `ToolRegistry` built in `src/app/runtime.ts`
  and give each a `usageRule`, a precise `readOnly` flag and a `category`.
- Safety layer: `src/safety/`. Changes here need tests for the bypass you are preventing.
- Learning loop: `src/learning/`; runtime wiring: `src/app/runtime.ts`.
- Scrapers: `src/scrapers/` and `config/scrapers/*.yaml` (`docs/scrapers.md`).
- Discord: `src/discord/` (router logic is tested; `client.ts` is a thin discord.js adapter).

## Knowledge vault

`knowledge/` follows `knowledge/AGENTS.md`: relative Markdown links (no wikilinks), the
`> Sources / Raw / Updated` block, a See Also section, no em or en dashes, and an entry in
`wiki/index.md` for every article. Regenerate the index with `npm run cli -- vault index`
only if you accept its generated summaries; otherwise edit the index row by hand.
