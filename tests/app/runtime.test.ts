import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { HarnessRuntime } from '../../src/app/runtime';
import { loadConfig } from '../../src/config/load';
import type { ToolResultBlock } from '../../src/core/types';
import type { CompletionRequest } from '../../src/llm/provider';
import { ScriptedProvider, type ScriptedTurn } from '../../src/llm/scripted';
import type { Notification } from '../../src/discord/notifier';
import { fakeFetch, tmpDir, writeFiles } from '../helpers';

async function makeRuntime(
  responder: (req: CompletionRequest, i: number) => ScriptedTurn,
  files: Record<string, string> = {},
  routes: Parameters<typeof fakeFetch>[0] = {},
) {
  const root = await tmpDir('harness-rt-');
  await writeFiles(root, {
    'config/harness.yaml': [
      'budgets: { dailyUsd: 5, runUsd: 1 }',
      // Thompson sampling is random, so keep every candidate on the full tool set.
      'profiles: { candidates: [t4-plan-tools-128k, t2-plan-tools-128k, t4-noplan-tools-64k] }',
      'learning: { enabled: true, immediate: false, judge: true, reflect: always, proposeSkills: true, minStepsForSkill: 2 }',
      'tools: { allowPrivateNetwork: true, postEditDiagnostics: false }',
      'scrapers: { userAgent: "test-bot/1.0", autoRepair: false }',
      'logging: { level: silent }',
    ].join('\n'),
    'agents/analyst.md':
      '---\nname: analyst\ndescription: Test analyst\nprofile: auto\n---\nAnswer with evidence.',
    'agents/scraper-engineer.md':
      '---\nname: scraper-engineer\ndescription: Fixes scrapers\nscrapers: ro\n---\nFix scrapers.',
    'skills/demo/SKILL.md': '---\nname: demo-skill\ndescription: A demo skill.\n---\nSteps.',
    'knowledge/wiki/index.md': '# Knowledge Base Index\n',
    'knowledge/wiki/log.md': '# Wiki Log\n',
    'knowledge/wiki/crawling/robots-txt.md':
      '---\ntags: [scraping]\n---\n\n# robots.txt (RFC 9309)\n\n> Sources: RFC 9309\n> Raw: none yet (seed article)\n> Updated: 2026-10-24\n\n## Overview\n\nLongest match wins.\n\n## See Also\n',
    'config/scrapers/items.yaml':
      'name: items\ndescription: Test items\nschedule: "5 * * * *"\nsource: { type: json, url: "https://api.test/items" }\nfields: { id: { path: id, type: integer, required: true } }\nkey: id\nfetch: { respectRobots: false, minIntervalMs: 0 }\nnotify: { onNew: true, onFailure: true, alertAfterFailures: 1 }\n',
    ...files,
  });
  const config = await loadConfig({ root, env: {} });
  const provider = new ScriptedProvider(responder);
  const ff = fakeFetch(routes);
  const rt = await HarnessRuntime.create({
    config,
    env: { PATH: process.env.PATH },
    provider,
    fetch: ff.fetch,
    disableSql: true,
  });
  const notes: Notification[] = [];
  rt.attachNotifier({ notify: async (n) => void notes.push(n) });
  return { rt, root, provider, notes, calls: ff.calls };
}

describe('HarnessRuntime', () => {
  test('runs a task end to end: tools, trajectory, learning, bandit and lessons', async () => {
    const { rt, root, provider } = await makeRuntime((req, i) => {
      if (req.purpose === 'judge')
        return {
          text: '{"score": 0.4, "verdict": "partial", "failure_stage": "verification", "reason": "not verified"}',
        };
      if (req.purpose === 'reflect')
        return {
          text: '{"lessons": [{"title": "Verify totals with a second query", "context": "totals", "lesson": "Re-run the sum another way.", "evidence": "step 2", "tags": ["analysis"]}]}',
        };
      if (i === 0) return { toolCalls: [{ name: 'search_knowledge', input: { query: 'robots match' } }] };
      if (i === 1)
        return { toolCalls: [{ name: 'write_file', input: { path: 'reports/answer.md', content: '42\n' } }] };
      return { text: 'The answer is 42.' };
    });
    const events: string[] = [];
    const result = await rt.runTask({
      task: 'What is the answer? Analyze the dataset.',
      source: 'cli',
      onEvent: (e) => void events.push(e.type),
    });
    expect(result).toMatchObject({ outcome: 'completed', finalText: 'The answer is 42.', agent: 'analyst' });
    expect(await fsp.readFile(path.join(root, 'data/workspace/reports/answer.md'), 'utf8')).toBe('42\n');
    expect(events[0]).toBe('run_start');
    const sys = provider.requests[0]!.system;
    expect(sys).toContain('- demo-skill: A demo skill.');
    expect(sys).toContain('# Knowledge vault');
    expect(sys).toContain('knowledge/ (read-only)');
    expect(JSON.stringify(provider.requests[1]!.messages)).toContain('robots.txt (RFC 9309)');

    const meta = (await rt.runs.getMeta(result.runId))!;
    expect(meta).toMatchObject({ taskType: 'analysis', source: 'cli', profileSelectedBy: 'bandit' });
    expect((await rt.runs.events(result.runId)).length).toBeGreaterThan(3);

    expect(await rt.learning.processPending()).toBe(1);
    const learned = (await rt.runs.getMeta(result.runId))!;
    expect(learned.judge).toMatchObject({ verdict: 'partial', failureStage: 'verification' });
    expect(learned.learned!.lessons).toEqual(['wiki/lessons/verify-totals-with-a-second-query.md']);
    const lesson = await fsp.readFile(path.join(root, 'knowledge', learned.learned!.lessons[0]!), 'utf8');
    expect(lesson).toContain('# Lesson: Verify totals with a second query');
    expect(rt.bandit.summary().some((r) => r.profileId === result.profileId && r.pulls === 1)).toBe(true);

    // The lesson is retrieved for the next similar task.
    await rt.runTask({ task: 'Verify the totals for the sales dataset', source: 'cli' });
    expect(provider.requests.at(-1)!.system).toContain('# Lessons from past runs');
    await rt.shutdown();
  });

  test('profile selection: request, agent, bandit and fixed', async () => {
    const { rt } = await makeRuntime(() => ({ text: 'ok' }), {
      'agents/verifier.md': '---\nname: verifier\ndescription: v\nprofile: t1-noplan-bash-64k\n---\nCheck.',
    });
    const analyst = rt.agent('analyst');
    expect(rt.chooseProfile(analyst, 'm', 'analysis', 't3-plan-tools-32k')).toMatchObject({
      selectedBy: 'request',
      profile: { id: 't3-plan-tools-32k' },
    });
    expect(rt.chooseProfile(rt.agent('verifier'), 'm', 'analysis')).toMatchObject({
      selectedBy: 'agent',
      profile: { id: 't1-noplan-bash-64k' },
    });
    const picked = rt.chooseProfile(analyst, 'm', 'analysis', 'auto');
    expect(picked.selectedBy).toBe('bandit');
    expect(rt.config.profiles.candidates).toContain(picked.profile.id);
    (rt.config.profiles as { selection: string }).selection = 'fixed';
    expect(rt.chooseProfile(analyst, 'm', 'analysis')).toMatchObject({
      selectedBy: 'default',
      profile: { id: 't4-plan-tools-128k' },
    });
    expect(() => rt.agent('ghost')).toThrow(/Unknown agent "ghost"/);
    expect(rt.agentList().map((a) => a.name)).toContain('verifier');
  });

  test('workspaces mount datasets, dashboards, knowledge, skills and scrapers per agent', async () => {
    const { rt } = await makeRuntime(() => ({ text: 'ok' }), {
      'agents/librarian.md':
        '---\nname: librarian\ndescription: l\nknowledge: rw\nscrapers: none\nskills: none\n---\nx',
    });
    const aliases = (name: string) =>
      rt
        .workspaceFor(rt.agent(name))
        .allMounts.map((m) => `${m.alias || '.'}:${m.mode}`)
        .sort();
    expect(aliases('analyst')).toEqual([
      '.:rw',
      'dashboards:ro',
      'datasets:ro',
      'knowledge:ro',
      'scrapers:ro',
      'skills:ro',
    ]);
    expect(aliases('librarian')).toEqual(['.:rw', 'dashboards:ro', 'datasets:ro', 'knowledge:rw']);
    const cron = rt.permissionsFor('cron');
    expect(cron.policy.askFallback).toBe('deny');
    expect(cron.classifyBash('ls -la')).toBe('allow');
    expect(cron.classifyBash('python3 x.py')).toBe('ask');
    expect(
      (
        await cron.check(
          { kind: 'bash', tool: 'bash', summary: 'python', command: 'python3 x.py' },
          { runId: 'r', agent: 'a' },
        )
      ).allowed,
    ).toBe(false);
    expect(rt.permissionsFor('discord').policy.mode).toBe('default');
  });

  test('unattended runs skip bashAllowExtra unless cronAllowExtra is set', async () => {
    const yaml = (extra: string) =>
      `permissions: { bashAllowExtra: ['^python3\\b']${extra} }\nlogging: { level: silent }\n`;
    const { rt } = await makeRuntime(() => ({ text: 'ok' }), { 'config/harness.yaml': yaml('') });
    expect(rt.permissionsFor('discord').classifyBash('python3 x.py')).toBe('allow');
    expect(rt.permissionsFor('cron').classifyBash('python3 x.py')).toBe('ask');
    const opted = await makeRuntime(() => ({ text: 'ok' }), {
      'config/harness.yaml': yaml(', cronAllowExtra: true'),
    });
    expect(opted.rt.permissionsFor('cron').classifyBash('python3 x.py')).toBe('allow');
  });

  test('a separate learned-skills folder is loaded, mounted read-only and receives proposals', async () => {
    const { rt, root } = await makeRuntime(() => ({ text: 'ok' }), {
      'config/harness.yaml': 'paths: { learnedSkills: ./data/learned }\nlogging: { level: silent }\n',
      'data/learned/learned/gamma/SKILL.md': '---\nname: gamma\ndescription: Learned gamma.\n---\nG',
    });
    expect(
      rt
        .ops()
        .skills()
        .map((s) => s.name),
    ).toEqual(['demo-skill', 'gamma']);
    const mounts = rt.workspaceFor(rt.agent('analyst')).allMounts;
    expect(mounts.find((m) => m.alias === 'learned-skills')).toMatchObject({
      dir: path.join(root, 'data', 'learned'),
      mode: 'ro',
    });
    expect(rt.synthesizer.proposedDir).toBe(path.join(root, 'data', 'learned', 'proposed'));
  });

  test('scheduled scrapes write datasets and notify on new records and failures', async () => {
    let status = 200;
    const { rt, notes, root } = await makeRuntime(
      () => ({ text: 'ok' }),
      {},
      { 'https://api.test/items': () => ({ status, body: [{ id: 1 }, { id: 2 }] }) },
    );
    rt.registerScraperJobs();
    rt.registerSystemJobs();
    expect(
      rt.scheduler
        .list()
        .map((j) => j.name)
        .sort(),
    ).toEqual(['digest', 'learning', 'scrape:items', 'vault-lint']);
    // The first data for a dataset also creates its explorer dashboard.
    expect(await rt.scheduledScrape('items')).toBe('ok: 2 new, 0 changed; rebuilt explore-items');
    expect(notes.at(-1)).toMatchObject({
      channel: 'reports',
      title: 'items: 2 new records',
      level: 'success',
    });
    const files = await fsp.readdir(path.join(root, 'data/datasets/items'));
    expect(files).toHaveLength(1);
    status = 500;
    expect(await rt.scheduledScrape('items')).toMatch(/^problem/);
    expect(notes.at(-1)).toMatchObject({
      channel: 'alerts',
      title: 'Scraper items is failing (1 in a row)',
      level: 'error',
    });
    await expect(rt.scheduledScrape('ghost')).rejects.toThrow(/unknown scraper/);
    const digest = await rt.digest();
    expect(digest).toContain('- items: 2 runs, 2 new records, 1 failed (failing 1 in a row)');
    expect(digest).toContain('**Spend today**');
    const lint = await rt.scheduler.runNow('vault-lint');
    expect(lint.lastStatus).toBe('ok');
  });

  test('spec dry runs, applying proposals and repair runs', async () => {
    const { rt, root, provider } = await makeRuntime(
      () => ({ text: 'Root cause: the API moved.' }),
      {},
      { 'https://api.test/v2/items': { body: [{ id: 7 }] } },
    );
    expect(await rt.dryRunSpec('name: [bad')).toMatch(/Invalid YAML/);
    expect(await rt.dryRunSpec('name: Bad Name')).toMatch(/Invalid scraper spec/);
    const good =
      'name: items\ndescription: v2\nschedule: "5 * * * *"\nsource: { type: json, url: "https://api.test/v2/items" }\nfetch: { respectRobots: false }\n';
    expect(await rt.dryRunSpec(good)).toMatch(/^OK scraper items \(dry run\): 1 fetched/);
    await writeFiles(path.join(root, 'data/workspace'), { 'proposals/scrapers/items.yaml': good });
    expect(await rt.applyScraperProposal('items')).toMatch(/Applied/);
    expect(rt.scrapers.get('items')!.source).toMatchObject({ url: 'https://api.test/v2/items' });
    await expect(rt.applyScraperProposal('../x')).rejects.toThrow(/invalid scraper name/);
    await writeFiles(path.join(root, 'data/workspace'), {
      'proposals/scrapers/other.yaml': good,
    });
    await expect(rt.applyScraperProposal('other')).rejects.toThrow(/proposal names "items"/);
    const repair = await rt.repairScraper('items', 'tester');
    expect(repair.agent).toBe('scraper-engineer');
    expect(JSON.stringify(provider.requests.at(-1)!.messages[0])).toContain('proposals/scrapers/items.yaml');
  });

  test('ops() exposes the bot surface', async () => {
    const { rt } = await makeRuntime(
      () => ({ text: 'done' }),
      {},
      { 'https://api.test/items': { body: [{ id: 1 }] } },
    );
    const ops = rt.ops();
    const res = await ops.ask('Count the items', { requestedBy: 'javi', source: 'discord' });
    expect(res.outcome).toBe('completed');
    expect((await ops.runs(5))[0]!.runId).toBe(res.runId);
    expect((await ops.run(res.runId))!.requestedBy).toBe('javi');
    expect(await ops.feedback(res.runId, 'up', 'javi')).toBe(true);
    expect(await ops.feedback('run_missing', 'up', 'javi')).toBe(false);
    expect(ops.stop('run_missing')).toBe(false);
    expect(ops.listScrapers()[0]!.name).toBe('items');
    expect((await ops.runScraper('items', true)).dryRun).toBe(true);
    await expect(ops.runScraper('ghost', false)).rejects.toThrow();
    expect(await ops.scraperStatus('items')).toContain('**items** (json');
    expect(await ops.scraperStatus('ghost')).toMatch(/No scraper/);
    expect(ops.budget()).toMatchObject({ capUsd: 5 });
    expect(ops.skills()[0]!.name).toBe('demo-skill');
    expect(await ops.proposedSkills()).toEqual([]);
    expect((await ops.searchKnowledge('robots longest match'))[0]!.title).toBe('robots.txt (RFC 9309)');
    expect(ops.profiles()).toEqual(expect.any(Array));
    expect(ops.status()).toMatchObject({ provider: 'scripted', scrapers: 1, skills: 1 });
    expect(ops.jobs()).toEqual([]);
    expect(await ops.learn()).toBeGreaterThanOrEqual(1);
  });

  test('dashboards: agents build them, scrapes refresh them, the bot lists and attaches them', async () => {
    let items = [{ id: 1 }, { id: 2 }];
    const spec = {
      title: 'Item board',
      data: { items: { dataset: 'items' } },
      items: [
        { type: 'kpi', title: 'Items', value: 'count' },
        { type: 'table', columns: ['id'] },
      ],
    };
    const { rt, provider } = await makeRuntime(
      (req, i) => {
        if (req.purpose !== 'agent') return { text: '{}' };
        if (i === 0) return { toolCalls: [{ name: 'profile_data', input: { dataset: 'items' } }] };
        if (i === 1) return { toolCalls: [{ name: 'build_dashboard', input: { spec } }] };
        return { text: 'Built the item board.' };
      },
      { 'config/harness.yaml.extra': '' },
      { 'https://api.test/items': () => ({ body: items }) },
    );
    expect(await rt.scheduledScrape('items')).toContain('rebuilt explore-items');
    const result = await rt.runTask({ task: 'Make a dashboard of the items', source: 'cli' });
    expect(result.outcome).toBe('completed');
    const toolResults = provider.requests
      .flatMap((r) => r.messages)
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is ToolResultBlock => b.type === 'tool_result')
      .map((b) => b.content);
    expect(toolResults.join('\n')).toContain('Dataset items: 2 rows, 5 columns');
    expect(toolResults.join('\n')).toContain('_scraped_at is when each row was scraped');
    expect(toolResults.join('\n')).not.toContain('measures: _key');
    expect(toolResults.join('\n')).toContain('Built dashboard "Item board" (item-board)');
    const board = await rt.dashboards.get('item-board');
    expect(board).toMatchObject({ runId: result.runId, source: 'agent', dependsOn: ['items'] });

    // New records rebuild every on-new-data dashboard that reads the dataset.
    items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(await rt.scheduledScrape('items')).toBe('ok: 1 new, 0 changed; rebuilt item-board, explore-items');
    expect((await rt.dashboards.get('item-board'))!.datasets[0]!.rows).toBe(3);
    // Nothing new, nothing rebuilt.
    expect(await rt.scheduledScrape('items')).toBe('ok: 0 new, 0 changed');

    const ops = rt.ops();
    expect((await ops.dashboards()).map((d) => d.slug).sort()).toEqual(['explore-items', 'item-board']);
    const got = await ops.dashboard('item-board');
    expect(got).toMatchObject({ title: 'Item board', rows: 3 });
    expect(got!.html).toContain('<title>Item board</title>');
    expect(await ops.dashboard('nope')).toBeUndefined();
    const ex = await ops.exploreDataset('items');
    expect(ex).toMatchObject({ slug: 'explore-items', title: 'items explorer' });
    await expect(ops.exploreDataset('ghost')).rejects.toThrow('no dataset "ghost"');
  });

  test('runs can be stopped while in flight', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { rt } = await makeRuntime((_req, i) =>
      i === 0 ? { toolCalls: [{ name: 'list_files', input: {} }] } : { text: 'never reached' },
    );
    const original = rt.provider.complete.bind(rt.provider);
    (rt.provider as { complete: typeof original }).complete = async (req) => {
      const res = await original(req);
      await gate;
      return res;
    };
    const running = rt.runTask({ task: 'long task', source: 'cli' });
    await new Promise((r) => setTimeout(r, 20));
    expect(rt.activeRuns).toHaveLength(1);
    expect(rt.stop(rt.activeRuns[0]!)).toBe(true);
    release();
    expect((await running).outcome).toBe('aborted');
    expect(rt.activeRuns).toHaveLength(0);
  });
});
