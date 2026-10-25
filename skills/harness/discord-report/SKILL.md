---
name: discord-report
description: Write a short, skimmable report or digest for a Discord channel from analysis results. Use when the output will be read in Discord.
---

# Discord report

- Lead with a one-sentence answer.
- Then at most five bullet points, each a finding with its figure and time range.
- A small table only if it is clearer than bullets (Discord renders code blocks, not Markdown tables:
  wrap tables in triple backticks).
- End with caveats (data freshness, coverage gaps) and what was verified.
- Stay under 1,800 characters. Put longer material in `reports/<name>.md` and mention the path.
- No hype words, no emoji walls, no em dash characters.
