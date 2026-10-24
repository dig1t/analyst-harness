# Vendored skill: karpathy-llm-wiki

- Upstream: https://github.com/Astro-Han/karpathy-llm-wiki
- Commit: eafcc77001e496cc43499e4923b663aec722c813 (pulled 2026-10-24)
- License: MIT (see LICENSE in this folder)
- Idea: Andrej Karpathy's "LLM Wiki" gist, https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f
- Modifications: none to SKILL.md, references/, scripts/, examples/ or tests/. The upstream README was renamed to UPSTREAM-README.md.

How this harness uses it: the `librarian` agent loads this skill to ingest sources into
`knowledge/raw/`, compile them into `knowledge/wiki/`, answer questions from the wiki and lint
it. Vault-specific paths and formatting rules live in `knowledge/AGENTS.md`, which takes
precedence over the skill where they differ. The evidence checker runs with:

    python3 skills/karpathy-llm-wiki/scripts/check_evidence.py knowledge
