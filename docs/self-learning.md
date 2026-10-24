# Self-learning

The harness improves in four ways, all of them inspectable and reversible: it learns which
harness profile works for each model and task type, it writes lessons that later runs read, it
drafts skills that a human approves, and it proposes scraper fixes that a human applies.

## 1. Trajectories

Every run stores its full event log (`data/runs/<runId>/events.jsonl`) and a summary
(`meta.json`). `src/learning/taxonomy.ts` labels each turn with a phase (Acquire, Explore,
Transform, Model, Verify, Report, Other) from the tools it used, which gives a phase histogram
per run: for example, a run with no Verify phase before Report is a warning sign.

## 2. Judge

`src/learning/judge.ts` sends a compact digest of the trajectory (task, plan, tool calls with
truncated results, final answer) to the judge model and asks for a score from 0 to 1, a
verdict (success, partial, failure), the earliest failed stage and a reason. If the judge is
disabled or fails, a heuristic verdict based on the outcome and the evidence of verification
stands in.

## 3. Profile bandit

`src/learning/bandit.ts` keeps Beta posteriors per `model|taskType` and profile. Selection
samples each candidate's success rate and subtracts a cost penalty (`costWeight` times the
arm's average cost divided by `costScaleUsd`); the highest score wins. Updates:

| Signal                       | Effect                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| Judge score `s`              | alpha += s, beta += 1 - s                                                            |
| Thumbs up or down in Discord | alpha += 2 or beta += 2                                                              |
| Run cost                     | Added to the arm's total; the average cost per pull drives the penalty (capped at 1) |

Priors favor the paper's baseline (`t4-plan-tools-128k`), so new contexts start from a sensible
default and explore from there. `harness profiles` and `/profiles` show what it learned; set
`profiles.selection: fixed` to turn exploration off.

## 4. Lessons

When reflection is enabled (`learning.reflect: always | failures | never`), the reflector asks
the model for at most a few concrete lessons from the run, each with a context, the lesson
itself and the evidence. Lessons are written to `knowledge/wiki/lessons/<slug>.md`, deduplicated
by title similarity (a repeated lesson is reinforced instead of duplicated) and logged in
`wiki/log.md`. Before each run, the lessons most relevant to the task text are retrieved with
BM25 and added to the system prompt. Lessons are plain Markdown: edit or delete them freely.

## 5. Skill proposals

When the judge rates a run a success and it took at least `learning.minStepsForSkill` steps,
the synthesizer may draft a reusable skill (`SKILL.md` with frontmatter, steps and a
verification section) into `skills/proposed/<name>/`. Proposals are never loaded. A human reviews them with
`/skills proposed`, then `/skills approve <name>` moves the folder to `skills/learned/` and
reloads the registry, or `/skills reject <name>` deletes it. In the container, learned and
proposed skills live on the data volume (`HARNESS_LEARNED_SKILLS_DIR`).

## 6. Scraper repair

When a scraper keeps failing and `scrapers.autoRepair` is on (or someone runs
`/scrape repair <name>`), the `scraper-engineer` agent investigates with read-only access to
the spec and writes a corrected spec to `proposals/scrapers/<name>.yaml` in the workspace,
after a dry run. `/scrape apply <name>` (admin only) validates and applies it.

## Running the loop

- Immediately after each run when `learning.immediate` is true.
- In a nightly sweep (`learning.schedule`) for anything missed.
- On demand: `harness learn` or `/learn`.

Judge and reflection calls count toward the daily spend cap.
