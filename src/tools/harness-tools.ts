import { promises as fsp } from 'node:fs';
import { z } from 'zod';
import { PlanItemSchema } from '../core/planning/plan';
import { ToolError } from '../util/errors';
import { defineTool, type ToolDefinition } from './types';

export const updatePlanTool = defineTool({
  name: 'update_plan',
  category: 'auxiliary',
  readOnly: false,
  usageRule:
    'your live todo list. Re-send the COMPLETE list on every call (it replaces the previous one); keep exactly ONE task `in_progress`.',
  description: `Create or update your task plan (a todo list). The harness shows this plan back to you before every turn so you stay on track and don't lose steps.
When: for any non-trivial task (about 3+ steps), call this FIRST to lay out the steps, then keep it updated as you work. Skip only for a single trivial step or a purely informational request.
Protocol: pass the COMPLETE updated list every time; it fully replaces the previous list (no incremental edits). Each item has content (imperative, e.g. 'Load the orders table'), status (pending | in_progress | completed), and activeForm (present-continuous, e.g. 'Loading the orders table'). Keep EXACTLY ONE task in_progress at a time; mark a task completed the moment it is actually done (do not batch completions); add new tasks as you discover them.
Side effects: updates the in-memory plan only; it touches no files and is not written to disk.`,
  schema: z.object({ plan: z.array(PlanItemSchema).min(1) }),
  async execute({ plan }, ctx) {
    const result = ctx.plan.replace(plan);
    if (!result.ok) throw new ToolError(result.error ?? 'Invalid plan.');
    const { done, total } = ctx.plan.progress();
    return { content: `Plan updated (${done}/${total} completed):\n${ctx.plan.render()}` };
  },
});

export const recallEventTool = defineTool({
  name: 'recall_event',
  category: 'auxiliary',
  readOnly: true,
  usageRule:
    'fetch the verbatim output of an elided or summarized event; often re-reading or re-running is simpler.',
  description: `Fetch the full original content of a past tool observation (event) by its id. When the conversation has been compacted, old tool outputs are replaced by stubs like '[tool output elided ... Use recall_event(41) ...]' and the oldest turns may be folded into a summary; call this with the event id to get the verbatim output back. Often you can instead just re-read the file or re-run the command: use recall_event when the output isn't easily reproducible (for example a past API response or a long query result). Read-only; returns an error for an unknown id.`,
  schema: z.object({ id: z.number().int().min(1) }),
  async execute({ id }, ctx) {
    const ev = ctx.store.recall(id);
    if (!ev) throw new ToolError(`No event with id ${id}. Valid ids are 1 to ${ctx.store.lastId}.`);
    return {
      content: `[event ${id}: ${ev.toolName}${ev.isError ? ', error' : ''}, step ${ev.step}]\n${ev.content}`,
    };
  },
});

export const loadSkillTool = defineTool({
  name: 'load_skill',
  category: 'auxiliary',
  readOnly: true,
  usageRule: 'load a skill from the Skills list before following it.',
  description: `Load the full instructions of a skill listed under "Skills" in your system prompt. Returns the SKILL.md body and the paths of its bundled files (references, templates, scripts), which you can read with read_file.
When: as soon as a task matches a skill's description, load it before acting, then follow it.
Error modes: unknown skill names return an error listing the available skills.
Side effects: none.`,
  schema: z.object({ name: z.string().min(1) }),
  async execute({ name }, ctx) {
    const skills = ctx.services.skills;
    if (!skills) throw new ToolError('No skills are configured in this harness.');
    const skill = skills.get(name);
    if (!skill) {
      const names = skills.list().map((s) => s.name);
      throw new ToolError(`Unknown skill "${name}". Available skills: ${names.join(', ') || '(none)'}.`);
    }
    const files = skill.files.length
      ? `\n\nBundled files (read with read_file):\n${skill.files.map((f) => `- ${f}`).join('\n')}`
      : '';
    return { content: `# Skill: ${skill.name}\n\n${skill.body.trim()}${files}` };
  },
});

export const searchKnowledgeTool = defineTool({
  name: 'search_knowledge',
  category: 'auxiliary',
  readOnly: true,
  usageRule:
    'search the knowledge vault (scraping know-how and lessons from past runs) before designing a scraper or analysis.',
  description: `Search the knowledge vault: an Obsidian/LLM-wiki knowledge base covering everything about data scraping (HTTP, parsing, crawling, APIs, legal and ethical rules, storage, operations, source playbooks) plus lessons the harness learned from its own past runs. Returns the best-matching articles with paths and snippets; read an article with read_file using the returned path.
When: before building or repairing a scraper, when you hit an unfamiliar site pattern, or when the task touches legal or ethical questions. Cite the article paths you relied on.
Protocol: full-text BM25 search. Use specific terms ("cursor pagination", "robots.txt crawl-delay"). Optional topic restricts the search to one topic folder (for example http, parsing, legal-ethics, lessons).
Side effects: none.`,
  schema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(20).optional(),
    topic: z.string().optional(),
  }),
  async execute({ query, limit = 5, topic }, ctx) {
    const kb = ctx.services.knowledge;
    if (!kb) throw new ToolError('The knowledge vault is not configured.');
    const hits = await kb.search(query, { limit, topic });
    if (hits.length === 0)
      return { content: `No vault articles match "${query}"${topic ? ` in topic ${topic}` : ''}.` };
    return {
      content: hits
        .map((h, i) => `${i + 1}. ${h.title} (${h.path}, score ${h.score.toFixed(2)})\n   ${h.snippet}`)
        .join('\n'),
    };
  },
});

export const delegateTaskTool = defineTool({
  name: 'delegate_task',
  category: 'auxiliary',
  readOnly: false,
  usageRule:
    'hand a self-contained sub-task to a specialist agent with a fresh context; you get back its final answer.',
  description: `Delegate a self-contained sub-task to another agent (for example scraper-engineer, verifier, librarian). The sub-agent starts with a fresh context, works in the same workspace and returns its final answer, outcome and cost.
When: for work that would flood your context (reading many sources), for an independent check of your result (verifier), or for specialist work (building a scraper spec, updating the knowledge vault). Give the sub-agent everything it needs in the task text: it cannot see your conversation.
Error modes: unknown agent names return an error listing the available agents; delegation depth is limited.
Side effects: whatever the sub-agent does.`,
  schema: z.object({ agent: z.string().min(1), task: z.string().min(10) }),
  async execute({ agent, task }, ctx) {
    const delegate = ctx.services.delegate;
    if (!delegate) throw new ToolError('Delegation is not configured.');
    if (ctx.depth >= 2)
      throw new ToolError('Maximum delegation depth reached; finish this sub-task yourself.');
    const known = delegate.agents().map((a) => a.name);
    if (!known.includes(agent))
      throw new ToolError(`Unknown agent "${agent}". Available agents: ${known.join(', ')}.`);
    const res = await delegate.run(agent, task, ctx);
    return {
      content: `[sub-agent ${agent}, run ${res.runId}, outcome ${res.outcome}, cost $${res.costUsd.toFixed(4)}]\n${res.finalText}`,
      isError: res.outcome !== 'completed',
    };
  },
});

export const runScraperTool = defineTool({
  name: 'run_scraper',
  category: 'auxiliary',
  readOnly: false,
  usageRule: 'run a registered scraper now (dry_run=true to test), or test a spec file with spec_path.',
  description: `Run one of the harness's registered scrapers now and return a summary (records fetched, valid, invalid, new, changed, written, dataset path), or test a scraper spec YAML file from the workspace with spec_path (always a dry run: nothing is written).
When: to refresh a dataset before analysis, to test a new or repaired spec before proposing it, or to reproduce a scraper failure.
Protocol: pass name for a registered scraper (dry_run=true runs without writing to its dataset), or spec_path for a spec file (for example proposals/scrapers/x.yaml or scrapers/x.yaml).
Error modes: unknown scraper names return an error listing the registered scrapers; invalid specs return the validation errors.
Side effects: network requests to the scraper's source (rate-limited, robots.txt honored) and, for a registered scraper without dry_run, appends to its dataset.`,
  schema: z.object({
    name: z.string().min(1).optional(),
    dry_run: z.boolean().optional(),
    spec_path: z.string().optional(),
  }),
  async execute({ name, dry_run = false, spec_path }, ctx) {
    const scrapers = ctx.services.scrapers;
    if (!scrapers) throw new ToolError('Scrapers are not configured.');
    if (spec_path) {
      if (!scrapers.dryRunSpec) throw new ToolError('Testing spec files is not supported here.');
      const r = await ctx.workspace.resolve(spec_path, 'read');
      const yaml = await fsp.readFile(r.abs, 'utf8').catch(() => {
        throw new ToolError(`Cannot read spec file ${r.display}.`);
      });
      return { content: await scrapers.dryRunSpec(yaml) };
    }
    if (!name) throw new ToolError('Pass name (a registered scraper) or spec_path (a spec file to test).');
    const names = scrapers.list().map((s) => s.name);
    if (!names.includes(name))
      throw new ToolError(`Unknown scraper "${name}". Registered scrapers: ${names.join(', ') || '(none)'}.`);
    return { content: await scrapers.run(name, { dryRun: dry_run }) };
  },
});

export const sqlQueryTool = defineTool({
  name: 'sql_query',
  category: 'workspace',
  readOnly: false,
  usageRule:
    'DuckDB SQL over workspace files: read_csv_auto, read_json_auto, read_parquet. Results are capped; aggregate in SQL.',
  description: `Run a DuckDB SQL query against files in the workspace and return the result as a Markdown table. DuckDB reads CSV, JSON/JSONL and Parquet directly: SELECT * FROM read_csv_auto('datasets/sales.csv'), read_json_auto('datasets/hn-top/*.jsonl'), read_parquet('x.parquet'). Tables you CREATE persist for the rest of this run.
When: for any tabular analysis: profiling columns (SUMMARIZE SELECT ...), aggregations, joins, window functions, deduplication checks. Prefer aggregating in SQL over pulling raw rows into the conversation.
Protocol: one or more statements; the result of the last statement is returned, capped at max_rows (default 200) with the total row count. Paths are relative to the workspace root. Only workspace files are accessible.
Error modes: SQL errors are returned as error observations with DuckDB's message: fix the query rather than retrying it unchanged.
Side effects: CREATE/INSERT affect only this run's in-memory database; COPY ... TO can write files inside the workspace.`,
  schema: z.object({ query: z.string().min(1), max_rows: z.number().int().min(1).max(5000).optional() }),
  async execute({ query, max_rows = 200 }, ctx) {
    const sql = ctx.services.sql;
    if (!sql)
      throw new ToolError(
        'SQL is not available (the optional @duckdb/node-api dependency is not installed).',
      );
    return { content: await sql.query(query, max_rows, ctx) };
  },
});

export const harnessTools: Array<ToolDefinition<never>> = [
  updatePlanTool,
  recallEventTool,
  loadSkillTool,
  searchKnowledgeTool,
  delegateTaskTool,
  runScraperTool,
  sqlQueryTool,
] as Array<ToolDefinition<never>>;
