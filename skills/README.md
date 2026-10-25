# Skills library

Skills are folders with a `SKILL.md` (Agent Skills format: YAML frontmatter with `name` and
`description`, then instructions). The harness lists every skill's name and description in the
agent's system prompt and loads the body on demand with the `load_skill` tool. The same folders
work as Claude Code skills when you develop on this repo.

| Folder | Source | Contents |
|---|---|---|
| `karpathy-llm-wiki/` | Vendored, MIT (Astro-Han) | Karpathy LLM Wiki: ingest, query, lint, evidence checker |
| `vendor-karpathy/` | Vendored, MIT (LearnPrompt) | 15 Karpathy-inspired working methods |
| `harness/` | This repo | Skills for the harness's own workflows (scraping, analysis, repair, reporting) |
| `learned/` | Created at runtime | Skills drafted by the learning loop and approved by a human |
| `proposed/` | Created at runtime | Drafts awaiting approval (`/skills approve <name>`); never loaded |

Rules for new skills: lowercase hyphenated `name` (64 characters max), a `description` that says
what the skill does and when to use it (1024 characters max), concrete steps, a verification
section, and no em dash characters in harness-authored skills.
