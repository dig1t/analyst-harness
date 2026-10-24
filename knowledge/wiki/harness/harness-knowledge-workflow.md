---
tags: [scraping, harness, llm-wiki, self-learning]
aliases: [vault workflow, knowledge workflow, LLM wiki workflow, lessons]
---

# How the Agents Use and Grow This Vault

> Sources: analyst-harness source code: src/knowledge/vault.ts, src/knowledge/bm25.ts, src/learning/reflection.ts, agents/librarian.md (https://github.com/firebit-dev/analyst-harness); Andrej Karpathy, LLM Wiki gist (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f); karpathy-llm-wiki skill by Astro-Han (https://github.com/Astro-Han/karpathy-llm-wiki)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

This vault is both a reference for people (open `knowledge/` in Obsidian) and working memory for the harness's agents. Agents read it through the `search_knowledge` tool before they design or repair a scraper, the `librarian` agent grows it with the Karpathy LLM Wiki workflow (raw sources compiled into articles), and the learning loop writes lessons from real runs into `wiki/lessons/`, which later runs read back. A linter keeps the structure honest. Nothing here is hidden state: every change is a Markdown file and a line in `wiki/log.md`.

## Reading: search_knowledge

Every agent with vault access gets a note in its system prompt telling it to search the vault before designing or repairing a scraper and to cite what it used. The `search_knowledge` tool runs BM25 over every article, weighting the title highest, then aliases and tags, then the body, and returns ranked hits with a snippet and a path such as `knowledge/wiki/crawling/robots-txt.md`. An optional topic filter narrows the search to one folder. The agent then opens the article with `read_file`. People get the same search through `/knowledge` in Discord and `npm run cli -- vault search "<query>"`.

The vault is mounted read-only for every agent except the librarian, so a scraping run cannot rewrite the reference material it is reading.

## Growing: the librarian and the LLM Wiki workflow

The `librarian` agent (`agents/librarian.md`) loads the vendored `karpathy-llm-wiki` skill and follows the vault schema in `knowledge/AGENTS.md`:

1. **Ingest.** Save the source verbatim into `raw/<topic>/` (never edited afterwards), then decide which articles it supports or contradicts.
2. **Compile.** Write or update `wiki/<topic>/<article>.md`, locating every number, date and quote in the raw file before writing it, and replace the seed marker with a Raw link once an article is grounded.
3. **Index and log.** Update the article's row in `wiki/index.md` and append an `ingest` entry to `wiki/log.md`.
4. **Query.** Answer questions from the wiki with citations, and archive valuable answers as articles.
5. **Lint.** Check structure and evidence, then fix or report.

Articles written at bootstrap carry `> Raw: none yet (seed article)`: they cite external references but have no captured source yet, so ingest work naturally starts there.

## Learning: lessons from runs

After a run, the reflection step can turn what happened into a few concrete lessons, each with a context, the lesson and the evidence (the run id and the step). They are written to `wiki/lessons/<slug>.md`; a lesson whose title closely matches an existing one reinforces it instead of creating a duplicate, and each batch is logged. Before every run, the lessons most relevant to the task are retrieved with BM25 and added to the system prompt, so a mistake made once (for example a selector that broke on a site redesign) informs the next similar task. Lessons are advisory; a lesson confirmed several times should be promoted into a topic article during lint and linked from it.

## Keeping it healthy: lint and index

`npm run vault:lint` (and a weekly `vault-lint` job that alerts on errors) checks:

| Check | Severity |
|---|---|
| Broken relative links, double-bracket wiki links, em dashes | Error |
| Missing H1 or missing `Sources`, `Raw` or `Updated` lines | Error |
| Articles missing from `wiki/index.md`, index rows pointing at missing files, nested topic folders | Error |
| En dashes, non-kebab-case file names, malformed `Updated` dates, extra frontmatter keys, missing See Also | Warning |
| Orphans (no inbound links; lessons are exempt) | Warning |

`npm run cli -- vault index` regenerates the index from each article's first sentence. The evidence checker shipped with the skill (`python3 skills/karpathy-llm-wiki/scripts/check_evidence.py knowledge`) lists seed articles as evidence errors by design.

## The vault in production

In the container, the vault the agents read and write lives on the data volume (`/app/data/knowledge`), seeded from the image on first start; edits and lessons stay on the server. To bring good changes back into git, copy the changed files out of the volume (for example `docker compose cp harness:/app/data/knowledge/wiki ./knowledge/`), review the diff and commit. New articles in the image appear on the volume after an upgrade without overwriting local edits.

## Pitfalls

- **Treating seed articles as ground truth.** They were written from expert knowledge and may contain small errors; prefer a raw-grounded claim and mark older text as outdated.
- **Letting lessons pile up.** Hundreds of near-duplicate lessons dilute retrieval. Promote, merge or delete them during lint.
- **Editing `raw/` files.** Raw captures are evidence; fix the article, not the source.
- **Absolute or wiki-style links.** They break on GitHub and in the linter; use relative Markdown links.

## Checklist

- [ ] New knowledge enters through `raw/` and is compiled into an article with citations.
- [ ] Every new article has the metadata block, See Also links and an index row.
- [ ] `npm run vault:lint` reports zero errors before a commit.
- [ ] Lessons are reviewed during lint: promoted, merged or deleted.

## See Also

- [Declarative Scraper Specs in This Harness](harness-scraper-spec.md)
- [Runbook: From Request to Scheduled Scraper](scraping-runbook.md)
- [Learning Path: Zero to Production](../fundamentals/learning-path.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Validating LLM Extractions](../llm-scraping/validating-llm-output.md)
