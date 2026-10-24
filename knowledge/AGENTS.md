# Vault Schema (read this before editing the vault)

This folder is an Obsidian vault and an LLM Wiki in the style described by Andrej Karpathy
(raw sources, compiled wiki, schema). The workflow rules come from the vendored
`karpathy-llm-wiki` skill (`skills/karpathy-llm-wiki/SKILL.md`). This file adds the
conventions that are specific to this vault. When the two disagree, this file wins for
paths and formatting; the skill wins for the ingest, query and lint workflow.

## Layout

```
knowledge/
  README.md          Vault home page (open this first in Obsidian)
  AGENTS.md          This schema
  raw/<topic>/       Immutable source captures (never edit after saving)
  wiki/index.md      Global index: one row per article, grouped by topic
  wiki/log.md        Append-only operation log
  wiki/<topic>/      Compiled articles, exactly one level of topic folders
  wiki/lessons/      Lessons the harness learned from its own runs (machine written)
  .obsidian/         Shared Obsidian settings (workspace files are git-ignored)
```

Topic folders: `fundamentals`, `http`, `parsing`, `browser-automation`, `crawling`, `apis`,
`anti-bot`, `legal-ethics`, `data-quality`, `storage`, `operations`, `tools`, `llm-scraping`,
`sources`, `harness`, `lessons`. Do not create nested folders inside a topic.

## Article format

Every article is a Markdown file named in kebab-case after its concept
(`css-selectors.md`, not `notes-2.md`). Structure:

```markdown
---
tags: [scraping, parsing]
aliases: [CSS selector, selectors]
---

# CSS Selectors for Extraction

> Sources: MDN Web Docs, CSS selectors reference (https://developer.mozilla.org/...); W3C Selectors Level 4
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

One paragraph that states the key points.

## ...body sections...

## Pitfalls

## Checklist

## See Also

- [XPath for Extraction](xpath.md)
- [Robust Selectors](../parsing/robust-selectors.md)
```

Rules:

1. **Frontmatter** holds only `tags` and `aliases`. Never put dates or numbers in
   frontmatter; the evidence checker reads it as body text.
2. **Metadata block** is the contiguous blockquote right after the H1. `Sources`, `Raw`
   and `Updated` are required. `Updated` changes only when the knowledge changes.
3. **Links are relative Markdown links**, never `[[wikilinks]]`. Same topic:
   `[Title](file.md)`. Other topic: `[Title](../topic/file.md)`. This keeps the vault
   readable on GitHub, in Obsidian (configured for Markdown links) and by the lint tools.
4. **No em dash characters.** Use commas, colons, parentheses or a plain hyphen.
5. Code samples use fenced blocks with a language tag. Prefer short, runnable snippets
   in Python or TypeScript.
6. Every article ends with `## See Also` linking two to six related articles.
7. Tags: always `scraping`, plus the topic name, plus up to three specific tags.

## Seed articles

The articles present at bootstrap were authored from expert knowledge and cite external
references in `Sources`, but they have no captured raw source. They carry
`> Raw: none yet (seed article)`. Consequences:

- `scripts/check_evidence.py` from the vendored skill lists them under "Evidence errors".
  That is expected. The harness linter (`npm run vault:lint`) understands the seed marker.
- When an ingest captures a source that supports a seed article, add the Raw link, verify
  the load-bearing facts against it (locate before you write) and remove the seed marker.
- Seed articles may contain small inaccuracies. Prefer a newer raw-grounded claim and mark
  the older text with a `Status: Outdated` or `Status: Disputed` block, as the skill says.

## Lessons (self-learning)

`wiki/lessons/` is written by the harness reflection step after runs. Each lesson file:

```markdown
---
tags: [scraping, lessons]
---

# Lesson: <short imperative title>

> Sources: harness run <run id>
> Raw: none yet (harness lesson)
> Updated: YYYY-MM-DD

## Context
## Lesson
## Evidence
## See Also
```

Lessons are advisory. A lesson that is confirmed several times can be promoted into a
topic article during lint (move the knowledge, link the lesson from the article).

## Operations log

Append one entry per ingest, query archive, lint or lesson batch to `wiki/log.md`, using
the heading formats from the skill:

```
## [YYYY-MM-DD] ingest | <primary article title>
## [YYYY-MM-DD] lint | <N> issues found, <M> auto-fixed
## [YYYY-MM-DD] lessons | <N> lessons from run <run id>
```

## Safety and ethics

This vault documents scraping so that agents do it lawfully and politely. Articles about
bot defenses explain how they work and how to respond responsibly (slow down, identify
yourself, ask for access, use an official API or a licensed dataset). They do not provide
recipes for defeating access controls, solving CAPTCHAs at scale or hiding a bot's
identity from a site that has asked bots to stay out.
