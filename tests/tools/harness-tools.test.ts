import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  delegateTaskTool,
  loadSkillTool,
  recallEventTool,
  runScraperTool,
  searchKnowledgeTool,
  sqlQueryTool,
  updatePlanTool,
} from '../../src/tools/harness-tools';
import { executeToolCall, executeToolCalls } from '../../src/tools/executor';
import { ToolRegistry, toInputSchema } from '../../src/tools/registry';
import { fileTools } from '../../src/tools/fs-tools';
import { bashTool } from '../../src/tools/bash-tool';
import { harnessTools } from '../../src/tools/harness-tools';
import { webFetchTool } from '../../src/tools/web-fetch';
import { DuckDbSqlService, rewriteSqlPaths } from '../../src/tools/sql-engine';
import { defineTool, type ToolDefinition } from '../../src/tools/types';
import { ToolError } from '../../src/util/errors';
import { makeToolContext, makeWorkspace, tmpDir, writeFiles } from '../helpers';

const allTools = () =>
  new ToolRegistry([...fileTools, bashTool, webFetchTool, ...harnessTools] as Array<ToolDefinition<never>>);

describe('auxiliary tools', () => {
  test('update_plan replaces the plan and rejects invalid ones', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace);
    const out = await updatePlanTool.execute(
      { plan: [{ content: 'Load', status: 'in_progress', activeForm: 'Loading' }] },
      ctx,
    );
    expect(out.content).toContain('Plan updated (0/1 completed)');
    await expect(
      updatePlanTool.execute(
        {
          plan: [
            { content: 'a', status: 'in_progress', activeForm: 'a' },
            { content: 'b', status: 'in_progress', activeForm: 'b' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/Exactly ONE/);
  });

  test('recall_event returns stored observations', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace);
    const id = ctx.store.allocateId();
    await ctx.store.put({
      id,
      toolName: 'bash',
      toolCallId: 'c',
      input: {},
      content: 'full output',
      isError: false,
      step: 3,
    });
    expect((await recallEventTool.execute({ id }, ctx)).content).toBe('[event 1: bash, step 3]\nfull output');
    await expect(recallEventTool.execute({ id: 9 }, ctx)).rejects.toThrow(/Valid ids are 1 to 1/);
  });

  test('load_skill and search_knowledge use their services', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace, {
      services: {
        skills: {
          list: () => [{ name: 's1', description: 'd' }],
          get: (n) =>
            n === 's1'
              ? { name: 's1', description: 'd', body: 'Do X', files: ['skills/s1/ref.md'] }
              : undefined,
        },
        knowledge: {
          search: async (q) =>
            q === 'none' ? [] : [{ path: 'knowledge/wiki/a.md', title: 'A', score: 1.5, snippet: 'snip' }],
        },
      },
    });
    expect((await loadSkillTool.execute({ name: 's1' }, ctx)).content).toContain('skills/s1/ref.md');
    await expect(loadSkillTool.execute({ name: 'nope' }, ctx)).rejects.toThrow(/Available skills: s1/);
    expect((await searchKnowledgeTool.execute({ query: 'robots' }, ctx)).content).toContain(
      'A (knowledge/wiki/a.md, score 1.50)',
    );
    expect((await searchKnowledgeTool.execute({ query: 'none' }, ctx)).content).toMatch(/No vault articles/);
    const bare = makeToolContext(workspace);
    await expect(loadSkillTool.execute({ name: 's1' }, bare)).rejects.toThrow(/No skills/);
    await expect(searchKnowledgeTool.execute({ query: 'x y' }, bare)).rejects.toThrow(/not configured/);
  });

  test('delegate_task validates agents and depth', async () => {
    const { workspace } = await makeWorkspace();
    const run = jest.fn(async () => ({
      runId: 'run_child',
      outcome: 'completed',
      finalText: 'child answer',
      costUsd: 0.01,
    }));
    const ctx = makeToolContext(workspace, {
      services: { delegate: { run, agents: () => [{ name: 'verifier', description: 'v' }] } },
    });
    const out = await delegateTaskTool.execute({ agent: 'verifier', task: 'check the total please' }, ctx);
    expect(out.content).toContain('child answer');
    expect(out.isError).toBe(false);
    await expect(
      delegateTaskTool.execute({ agent: 'ghost', task: 'check the total please' }, ctx),
    ).rejects.toThrow(/Available agents: verifier/);
    const deep = { ...ctx, depth: 2 };
    await expect(
      delegateTaskTool.execute({ agent: 'verifier', task: 'check the total please' }, deep),
    ).rejects.toThrow(/depth/);
  });

  test('run_scraper runs registered scrapers or dry-runs a spec file', async () => {
    const { root, workspace } = await makeWorkspace();
    await writeFiles(root, { 'proposals/scrapers/x.yaml': 'name: x' });
    const services = {
      scrapers: {
        list: () => [{ name: 'hn', description: '' }],
        run: async (n: string, o?: { dryRun?: boolean }) => `ran ${n} dry=${o?.dryRun}`,
        dryRunSpec: async (yaml: string) => `tested ${yaml}`,
      },
    };
    const ctx = makeToolContext(workspace, { services });
    expect((await runScraperTool.execute({ name: 'hn', dry_run: true }, ctx)).content).toBe(
      'ran hn dry=true',
    );
    expect((await runScraperTool.execute({ spec_path: 'proposals/scrapers/x.yaml' }, ctx)).content).toBe(
      'tested name: x',
    );
    await expect(runScraperTool.execute({ name: 'zzz' }, ctx)).rejects.toThrow(/Registered scrapers: hn/);
    await expect(runScraperTool.execute({}, ctx)).rejects.toThrow(/Pass name/);
    await expect(runScraperTool.execute({ spec_path: 'missing.yaml' }, ctx)).rejects.toThrow(/Cannot read/);
  });

  test('sql_query explains when DuckDB is unavailable', async () => {
    const { workspace } = await makeWorkspace();
    await expect(sqlQueryTool.execute({ query: 'select 1' }, makeToolContext(workspace))).rejects.toThrow(
      /not available/,
    );
  });
});

describe('ToolRegistry', () => {
  test('rejects duplicate and invalid names', () => {
    const reg = allTools();
    expect(() => reg.register(bashTool as ToolDefinition<never>)).toThrow(/Duplicate/);
    expect(() =>
      new ToolRegistry().register({ ...bashTool, name: 'bad name' } as ToolDefinition<never>),
    ).toThrow(/Invalid tool name/);
  });

  test('select() reproduces the paper action-space ablation', () => {
    const reg = allTools();
    const full = reg.select({ actionSpace: 'tools', planning: true, recall: true });
    expect(full.names()).toEqual(
      expect.arrayContaining([
        'read_file',
        'write_file',
        'edit_file',
        'list_files',
        'glob_files',
        'grep_text',
        'bash',
        'web_fetch',
        'update_plan',
        'recall_event',
      ]),
    );
    const bashOnly = reg.select({ actionSpace: 'bash', planning: true, recall: true });
    expect(bashOnly.names().sort()).toEqual([
      'bash',
      'delegate_task',
      'domain_status',
      'load_skill',
      'recall_event',
      'run_scraper',
      'search_knowledge',
      'update_plan',
    ]);
    const noAux = reg.select({ actionSpace: 'tools', planning: false, recall: false });
    expect(noAux.has('update_plan')).toBe(false);
    expect(noAux.has('recall_event')).toBe(false);
    expect(
      reg.select({ actionSpace: 'tools', planning: true, recall: true, allow: ['read_file'] }).names(),
    ).toEqual(['read_file']);
  });

  test('schemas are deterministic JSON Schema objects', () => {
    const schemas = allTools().schemas();
    expect(schemas.map((s) => s.name)).toEqual([...schemas.map((s) => s.name)].sort());
    const read = schemas.find((s) => s.name === 'read_file')!;
    expect(read.inputSchema).toMatchObject({
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    });
    expect(read.inputSchema).not.toHaveProperty('$schema');
    expect(() => toInputSchema(z.string())).toThrow(/must be zod objects/);
  });

  test('usage rules are generated from the active registry', () => {
    const rules = allTools().select({ actionSpace: 'bash', planning: true, recall: false }).usageRules();
    expect(rules).toContain('# Tool Usage Rules');
    expect(rules).toContain('- update_plan: your live todo list');
    expect(rules).not.toContain('- edit_file:');
    expect(rules).toContain('FIX THE INPUT');
  });
});

describe('executor', () => {
  const slow = (name: string, readOnly: boolean, log: string[]) =>
    defineTool({
      name,
      description: name,
      category: 'workspace',
      readOnly,
      schema: z.object({ id: z.number() }),
      async execute({ id }) {
        log.push(`start ${name}${id}`);
        await new Promise((r) => setTimeout(r, 20));
        log.push(`end ${name}${id}`);
        return { content: `${name}${id}` };
      },
    });

  test('turns every failure into an observation', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace);
    const reg = new ToolRegistry([
      defineTool({
        name: 'boom',
        description: '',
        category: 'workspace',
        readOnly: true,
        schema: z.object({}),
        execute: async () => Promise.reject(new Error('kaput')),
      }),
      defineTool({
        name: 'tool_err',
        description: '',
        category: 'workspace',
        readOnly: true,
        schema: z.object({}),
        execute: async () => Promise.reject(new ToolError('fix input')),
      }),
    ] as Array<ToolDefinition<never>>);
    const opts = { maxResultChars: 24_000, maxParallelReadOnly: 8 };
    expect(
      await executeToolCall({ type: 'tool_call', id: '1', name: 'nope', input: {} }, reg, ctx, opts),
    ).toMatchObject({ isError: true, content: expect.stringMatching(/Unknown tool `nope`.*boom, tool_err/) });
    expect(
      (await executeToolCall({ type: 'tool_call', id: '2', name: 'boom', input: {} }, reg, ctx, opts))
        .content,
    ).toMatch(/Internal error in `boom`: kaput/);
    expect(
      (await executeToolCall({ type: 'tool_call', id: '3', name: 'tool_err', input: {} }, reg, ctx, opts))
        .content,
    ).toBe('fix input');
    const invalid = await executeToolCall(
      { type: 'tool_call', id: '4', name: 'read_file', input: { path: 3 } },
      allTools(),
      ctx,
      opts,
    );
    expect(invalid.content).toMatch(/Invalid input for `read_file`:\n- path:/);
    const denied = await executeToolCall(
      { type: 'tool_call', id: '5', name: 'bash', input: { command: 'sudo rm x' } },
      allTools(),
      ctx,
      opts,
    );
    expect(denied).toMatchObject({ isError: true, permissionDenied: true });
    const aborted = new AbortController();
    aborted.abort();
    expect(
      (
        await executeToolCall(
          { type: 'tool_call', id: '6', name: 'boom', input: {} },
          reg,
          { ...ctx, signal: aborted.signal },
          opts,
        )
      ).content,
    ).toMatch(/cancelled/);
  });

  test('truncates large results', async () => {
    const { workspace } = await makeWorkspace();
    const reg = new ToolRegistry([
      defineTool({
        name: 'big',
        description: '',
        category: 'workspace',
        readOnly: true,
        schema: z.object({}),
        execute: async () => ({ content: 'y'.repeat(50_000) }),
      }),
    ] as Array<ToolDefinition<never>>);
    const res = await executeToolCall(
      { type: 'tool_call', id: '1', name: 'big', input: {} },
      reg,
      makeToolContext(workspace),
      { maxResultChars: 24_000, maxParallelReadOnly: 8 },
    );
    expect(res.content.length).toBeLessThanOrEqual(24_000);
  });

  test('read-only calls run in parallel; mutating calls are barriers; order is preserved', async () => {
    const { workspace } = await makeWorkspace();
    const log: string[] = [];
    const reg = new ToolRegistry([slow('r', true, log), slow('w', false, log)] as Array<
      ToolDefinition<never>
    >);
    const calls = [
      { type: 'tool_call' as const, id: 'a', name: 'r', input: { id: 1 } },
      { type: 'tool_call' as const, id: 'b', name: 'r', input: { id: 2 } },
      { type: 'tool_call' as const, id: 'c', name: 'w', input: { id: 3 } },
      { type: 'tool_call' as const, id: 'd', name: 'r', input: { id: 4 } },
    ];
    const out = await executeToolCalls(calls, reg, makeToolContext(workspace), {
      maxResultChars: 1000,
      maxParallelReadOnly: 8,
    });
    expect(out.map((o) => o.content)).toEqual(['r1', 'r2', 'w3', 'r4']);
    expect(log.slice(0, 2)).toEqual(['start r1', 'start r2']);
    expect(log.indexOf('start w3')).toBeGreaterThan(log.indexOf('end r2'));
    expect(log.indexOf('start r4')).toBeGreaterThan(log.indexOf('end w3'));
  });

  test('parallelism is capped', async () => {
    const { workspace } = await makeWorkspace();
    const log: string[] = [];
    const reg = new ToolRegistry([slow('r', true, log)] as Array<ToolDefinition<never>>);
    const calls = [1, 2, 3].map((id) => ({
      type: 'tool_call' as const,
      id: String(id),
      name: 'r',
      input: { id },
    }));
    await executeToolCalls(calls, reg, makeToolContext(workspace), {
      maxResultChars: 1000,
      maxParallelReadOnly: 2,
    });
    expect(log.indexOf('start r3')).toBeGreaterThan(log.indexOf('end r1'));
  });
});

describe('SQL engine', () => {
  test('rewrites file literals to absolute workspace paths and enforces mounts', async () => {
    const kb = await tmpDir();
    const { root, workspace } = await makeWorkspace([{ alias: 'datasets', dir: kb, mode: 'ro' }]);
    const r = rewriteSqlPaths(
      "SELECT * FROM read_csv_auto('data/x.csv') JOIN 'other.parquet' USING (id) WHERE note = 'a/b.csv'",
      workspace,
    );
    expect(r.sql).toContain(`read_csv_auto('${root}/data/x.csv')`);
    expect(r.sql).toContain(`JOIN '${root}/other.parquet'`);
    expect(r.sql).toContain("note = 'a/b.csv'");
    expect(
      rewriteSqlPaths("SELECT * FROM read_json_auto(['datasets/a.jsonl', 'datasets/b.jsonl'])", workspace)
        .sql,
    ).toContain(`'${kb}/a.jsonl', '${kb}/b.jsonl'`);
    expect(rewriteSqlPaths("COPY t TO 'out.csv'", workspace).writes).toEqual(['out.csv']);
    expect(() => rewriteSqlPaths("COPY t TO 'datasets/evil.csv'", workspace)).toThrow(/read-only/);
    expect(() => rewriteSqlPaths("SELECT * FROM read_csv('https://x.test/a.csv')", workspace)).toThrow(
      /Remote URLs/,
    );
    expect(() => rewriteSqlPaths("ATTACH 'db.duckdb'", workspace)).toThrow(/ATTACH/);
    expect(() => rewriteSqlPaths("SELECT * FROM read_csv('/etc/passwd')", workspace)).toThrow(
      /outside the workspace/,
    );
  });

  test('queries CSV and JSONL inside the sandbox and keeps tables for the run', async () => {
    if (!(await DuckDbSqlService.isAvailable())) return;
    const { root, workspace } = await makeWorkspace();
    await writeFiles(root, {
      'data/sales.csv': 'region,amount\nnorth,10\nsouth,20\nnorth,5\n',
      'data/e.jsonl': '{"k":1}\n{"k":2}\n',
    });
    const sql = new DuckDbSqlService();
    const ctx = makeToolContext(workspace, { services: { sql } });
    const out = (
      await sqlQueryTool.execute(
        {
          query:
            "SELECT region, sum(amount) AS total FROM read_csv_auto('data/sales.csv') GROUP BY region ORDER BY region",
        },
        ctx,
      )
    ).content;
    expect(out).toContain('| region | total |');
    expect(out).toContain('| north | 15 |');
    expect(out).toContain('(2 rows)');
    await sqlQueryTool.execute(
      { query: "CREATE TABLE ev AS SELECT * FROM read_json_auto('data/e.jsonl')" },
      ctx,
    );
    expect((await sqlQueryTool.execute({ query: 'SELECT count(*) AS n FROM ev' }, ctx)).content).toContain(
      '| 2 |',
    );
    expect(
      (await sqlQueryTool.execute({ query: 'SELECT * FROM range(10)', max_rows: 3 }, ctx)).content,
    ).toContain('10 rows total, showing the first 3');
    await expect(sqlQueryTool.execute({ query: 'SELEC 1' }, ctx)).rejects.toThrow(/DuckDB error/);
    // Even a path DuckDB sees directly is blocked by the sandbox settings.
    await expect(sql.query("SELECT * FROM read_csv_auto('/etc/hostname')", 5, ctx)).rejects.toThrow();
    const written = await sqlQueryTool
      .execute({ query: "COPY (SELECT 1 AS x) TO 'out/x.csv'" }, { ...ctx, runId: 'run_other' })
      .catch((e: Error) => ({ content: e.message }));
    expect(written.content).toMatch(/Wrote: out\/x.csv|DuckDB error/);
    sql.release('run_test');
    sql.release('run_other');
    await fsp.rm(path.join(root, 'out'), { recursive: true, force: true });
  });
});
