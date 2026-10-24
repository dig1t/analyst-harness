# Paper mapping

How the findings of "An Empirical Study of Harness Design for Coding Agents" (arXiv
2609.20804) are implemented, and where the harness departs from the paper for data analysis
work or for the Claude API.

## Components

| Paper component                                                                                      | Implementation                                                             | Notes                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ReAct loop with a step limit (300)                                                                   | `src/core/agent-loop.ts` (`runAgent`)                                      | Outcomes: completed, max_steps, stuck, context_overflow, budget_exceeded, refusal, aborted, provider_error                                                                            |
| Base prompt for the tool set and for bash only                                                       | `src/core/prompts.ts`                                                      | Rewritten for analysis: evidence, verification and reporting instead of patches                                                                                                       |
| Planning tool, exactly one item in progress, plan re-injected each turn                              | `src/core/planning/plan.ts`, `update_plan` in `src/tools/harness-tools.ts` | The reminder is appended to history for providers that bind thinking to the prefix (see below)                                                                                        |
| Action space: full tool set versus bash only                                                         | `src/core/profiles.ts`, `src/tools/bash-tool.ts`                           | Bash only drops the file, fetch and SQL tools, keeps the harness tools (plan, recall, skills, knowledge, scrapers, delegation) and swaps in a shell description written for that mode |
| Tool results truncated to 24k characters                                                             | `toolResultMaxChars` in `src/core/profiles.ts`, `src/tools/executor.ts`    | Middle truncation keeps both ends                                                                                                                                                     |
| Up to 8 read-only tool calls in parallel                                                             | `src/tools/executor.ts`                                                    | Calls with side effects act as barriers and run in order                                                                                                                              |
| Context tiers T0 to T4                                                                               | `src/core/context/manager.ts`                                              | T0 none, T1 elision, T2 elision and recall, T3 summarization, T4 all three                                                                                                            |
| M1 elision stubs                                                                                     | `ContextManager.elide`                                                     | Old tool results become stubs that name their event id                                                                                                                                |
| M2 external store with `recall_event`                                                                | `src/core/context/external-store.ts`, `recall_event` tool                  | Stubs can be expanded on demand                                                                                                                                                       |
| M3 LLM summarization                                                                                 | `ContextManager.prepare`, `SUMMARIZER_PROMPT`                              | Middle turns are summarized; the preamble and recent turns stay verbatim                                                                                                              |
| Thresholds B1 = 0.6 and B2 = 0.85 of the window, recent window 0.3 (at least 2 turns)                | `DEFAULT_CONTEXT_CONFIG`                                                   | T4 elides from B1; summarization starts at B2; emergency elision when still over                                                                                                      |
| Window budgets (32k to 128k)                                                                         | Profile ids such as `t4-plan-tools-128k`                                   | Parsed by `parseProfileId`                                                                                                                                                            |
| Stuck detection: reminder at 5 identical calls or 5 identical failures, stop at 8 identical failures | `src/core/stuck-detector.ts`                                               | Permission denials do not count as failures                                                                                                                                           |
| Workspace guard, including symlinks                                                                  | `src/safety/workspace.ts`                                                  | Mounts with aliases and read-only modes                                                                                                                                               |
| Read before write, with content hashes                                                               | `src/safety/file-state.ts`                                                 | Writes fail when the file changed on disk since the last full read                                                                                                                    |
| Permission policy: allow, ask, deny                                                                  | `src/safety/permissions.ts`                                                | Approvals through the terminal or Discord buttons                                                                                                                                     |
| Post-edit diagnostics                                                                                | `src/diagnostics/post-edit.ts`                                             | JSON, YAML, Python (ruff or a syntax check) and JavaScript                                                                                                                            |
| LLM judge with phase taxonomy and failure-stage attribution                                          | `src/learning/judge.ts`, `src/learning/taxonomy.ts`                        | Phases: Acquire, Explore, Transform, Model, Verify, Report, Other. Failure stages: data acquisition, data understanding, analysis implementation, verification, reporting             |

## The main finding, made operational

The paper finds that no single configuration wins: the best context tier, planning choice,
action space and window depend on the model, the task type and the budget. The harness treats
that as a learning problem instead of a fixed setting:

- A **profile** is one point in the paper's design space, written as
  `t<tier>-<plan|noplan>-<tools|bash>-<window>k`.
- `src/learning/bandit.ts` runs Thompson sampling per `model|taskType` context over the
  configured candidates, with a cost penalty and an informative prior on the paper's baseline
  (`t4-plan-tools-128k`).
- Rewards come from the judge's score, human feedback from Discord (weighted double) and the
  run's cost. See [self-learning.md](self-learning.md).

## Departures for the Claude API

- **Preserved thinking.** Claude validates thinking blocks against the exact conversation
  prefix that produced them, while the paper's context management edits history. The harness
  batches every history edit at the B1 and B2 thresholds, strips all thinking blocks at those
  boundaries, sends `prefix_mismatch_behavior: drop_block` as a safety net and appends plan
  reminders to history instead of injecting them per turn. A test checks that each request's
  messages are a prefix of the next one between compactions.
- **Adaptive thinking and effort.** The model decides how much to think; the profile does not
  set a thinking budget. Effort is explicit per agent (default `medium`).
- **Server-side fallback.** Refusals fall back to the provider's default routing when enabled.
- **Prompt caching.** Tool definitions and the system prompt end in a cache breakpoint, and
  top-level automatic caching moves a second breakpoint along the conversation, so each turn
  reads the previous prefix from cache.
- **Eager input streaming.** Tool inputs stream as they are generated and are validated with
  zod before any tool runs; a `max_tokens` stop with pending tool calls never executes them.

## Departures for data analysis

- Planning prompts and the judge rubric talk about data sources, joins, sanity checks and
  claims backed by queries rather than tests and patches.
- Extra tools: `sql_query` (sandboxed DuckDB), `web_fetch` (SSRF-guarded), `run_scraper`,
  `search_knowledge`, `load_skill` and `delegate_task` (depth 2).
- Datasets, the vault and skills are mounted read-only into the workspace; agents write their
  outputs in the workspace and propose changes to specs and skills for human review.
