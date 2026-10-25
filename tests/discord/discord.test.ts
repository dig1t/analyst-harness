import { isAdmin, isAuthorized, parseIdList, type AuthPolicy } from '../../src/discord/auth';
import { DiscordApprovalGateway, denyAllGateway } from '../../src/discord/approvals';
import { COMMANDS, helpText, isAdminCommand, toDiscordJson } from '../../src/discord/commands';
import { codeTable, fitMessage, formatRunResult, ProgressTracker } from '../../src/discord/format';
import { ConsoleNotifier, MultiNotifier, WebhookNotifier } from '../../src/discord/notifier';
import {
  CommandRouter,
  parsePrefixCommand,
  type HarnessOps,
  type Invocation,
  type Responder,
} from '../../src/discord/router';
import type { CommandReply } from '../../src/discord/format';
import { fakeFetch, sampleResult } from '../helpers';

const policy: AuthPolicy = {
  allowedUserIds: ['111111'],
  allowedRoleIds: ['999999'],
  adminUserIds: ['222222'],
  allowEveryone: false,
};

describe('auth', () => {
  test('deny by default; users, roles and admins are allowed', () => {
    expect(isAuthorized({ id: '333333', roles: [] }, policy)).toBe(false);
    expect(isAuthorized({ id: '111111', roles: [] }, policy)).toBe(true);
    expect(isAuthorized({ id: '333333', roles: ['999999'] }, policy)).toBe(true);
    expect(isAuthorized({ id: '222222', roles: [] }, policy)).toBe(true);
    expect(isAdmin({ id: '111111', roles: [] }, policy)).toBe(false);
    expect(isAuthorized({ id: '1', roles: [] }, { ...policy, allowEveryone: true })).toBe(true);
    expect(parseIdList(' 123456, 7890123 junk 12 ')).toEqual(['123456', '7890123']);
    expect(parseIdList(undefined)).toEqual([]);
  });
});

describe('commands', () => {
  test('slash command JSON follows the Discord schema', () => {
    const json = toDiscordJson();
    const names = json.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    const scrape = json.find((c) => c.name === 'scrape') as {
      options: Array<{ type: number; name: string; options: Array<{ type: number; required: boolean }> }>;
    };
    expect(scrape.options.map((o) => o.type)).toEqual([1, 1, 1, 1, 1]);
    expect(scrape.options.find((o) => o.name === 'run')!.options).toEqual([
      expect.objectContaining({ type: 3, required: true }),
      expect.objectContaining({ type: 5, required: false }),
    ]);
    const feedback = json.find((c) => c.name === 'feedback') as { options: Array<{ choices?: unknown[] }> };
    expect(feedback.options[1]!.choices).toHaveLength(2);
    for (const c of COMMANDS) {
      expect(c.name).toMatch(/^[a-z]{1,32}$/);
      expect(c.description.length).toBeLessThanOrEqual(100);
    }
  });

  test('admin flags and help text', () => {
    expect(isAdminCommand('learn')).toBe(true);
    expect(isAdminCommand('skills', 'approve')).toBe(true);
    expect(isAdminCommand('skills', 'list')).toBe(false);
    expect(isAdminCommand('scrape', 'apply')).toBe(true);
    expect(isAdminCommand('nope')).toBe(false);
    expect(helpText()).toContain('`/scrape run` Run a scraper now');
  });
});

describe('formatting', () => {
  test('fits long answers by attaching the full text', () => {
    expect(fitMessage('H', 'short', 'f.md')).toEqual({ content: 'H\n\nshort' });
    const long = fitMessage('Header', 'x'.repeat(5000), 'f.md');
    expect(long.content.length).toBeLessThanOrEqual(2000);
    expect(long.content).toContain('(full text attached)');
    expect(long.file).toMatchObject({ name: 'f.md' });
  });

  test('run results include outcome, cost and feedback buttons only on completion', () => {
    const ok = formatRunResult(sampleResult({ changedFiles: ['reports/a.md'] }));
    expect(ok.content).toMatch(/\*\*Run\*\* `run_1` completed in 3 steps, 2 tool calls, \$0.05/);
    expect(ok.content).toContain('Files: reports/a.md');
    expect(ok.feedbackRunId).toBe('run_1');
    const bad = formatRunResult(sampleResult({ outcome: 'stuck', error: 'loop', finalText: '' }));
    expect(bad.content).toContain('stopped (stuck in a loop)');
    expect(bad.content).toContain('Reason: loop');
    expect(bad.feedbackRunId).toBeUndefined();
  });

  test('codeTable aligns columns', () => {
    expect(
      codeTable([
        ['a', 'bb'],
        ['ccc', 'd'],
      ]),
    ).toBe('```\na    bb\nccc  d\n```');
    expect(codeTable([])).toBe('(none)');
  });

  test('ProgressTracker throttles updates and summarizes the run', async () => {
    const sent: string[] = [];
    let now = 0;
    const t = new ProgressTracker(
      async (s) => void sent.push(s),
      1000,
      () => now,
    );
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    now = 5000;
    await t.onEvent({
      type: 'llm_response',
      step: 1,
      stopReason: 'tool_use',
      usage,
      costUsd: 0.01,
      model: 'm',
      text: 'Looking',
      toolCalls: [{ id: '1', name: 'read_file', input: {} }],
      progress: [],
    });
    await t.onEvent({ type: 'plan', step: 1, plan: '', done: 1, total: 3 });
    now = 7000;
    await t.onEvent({
      type: 'llm_response',
      step: 2,
      stopReason: 'tool_use',
      usage,
      costUsd: 0.01,
      model: 'm',
      text: '',
      toolCalls: [{ id: '2', name: 'sql_query', input: {} }],
      progress: ['Aggregating by region'],
    });
    await t.onEvent({
      type: 'run_start',
      runId: 'r',
      task: 't',
      agent: 'a',
      profile: 'p',
      model: 'm',
      depth: 0,
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(
      'Working... step 2 | last action: sql_query | plan 1/3 | $0.02\n> Aggregating by region',
    );
  });
});

describe('notifiers', () => {
  test('webhook notifier posts embeds, chunks long bodies and attaches files', async () => {
    const ff = fakeFetch({ 'https://discord.test/hook': { status: 204 } });
    const n = new WebhookNotifier({ reports: 'https://discord.test/hook' }, ff.fetch);
    await n.notify({ channel: 'alerts', title: 'T', body: 'hello', level: 'error' });
    const payload = JSON.parse(String(ff.calls[0]!.init!.body));
    expect(payload).toMatchObject({
      username: 'analyst-harness',
      allowed_mentions: { parse: [] },
      embeds: [{ title: 'T', description: 'hello', color: 0xef4444 }],
    });
    await n.notify({
      channel: 'reports',
      title: 'Long',
      body: 'line\n'.repeat(2000),
      file: { name: 'r.md', content: '# r' },
    });
    expect(ff.calls.length).toBeGreaterThanOrEqual(4);
    expect(ff.calls[ff.calls.length - 1]!.init!.body).toBeInstanceOf(FormData);
    await new WebhookNotifier({}, ff.fetch).notify({ channel: 'reports', title: 'x', body: 'y' });
  });

  test('multi notifier isolates failures', async () => {
    const good = { notify: jest.fn(async () => undefined) };
    const bad = { notify: jest.fn(async () => Promise.reject(new Error('down'))) };
    await new MultiNotifier([bad, good, new ConsoleNotifier()]).notify({
      channel: 'reports',
      title: 't',
      body: 'b',
    });
    expect(good.notify).toHaveBeenCalled();
  });
});

describe('approval gateway', () => {
  test('uses the prompt answer and treats timeouts as denial', async () => {
    const answers: Array<boolean | undefined> = [true, false, undefined];
    const prompts: string[] = [];
    const gw = new DiscordApprovalGateway(
      { ask: async (text) => (prompts.push(text), answers.shift()) },
      () => true,
      1000,
    );
    const req = {
      kind: 'bash' as const,
      tool: 'bash',
      summary: 'run `python3 x.py`',
      command: 'python3 x.py',
    };
    const ctx = { runId: 'run_1', agent: 'analyst' };
    expect(await gw.request(req, ctx)).toBe(true);
    expect(await gw.request(req, ctx)).toBe(false);
    expect(await gw.request(req, ctx)).toBe(false);
    expect(prompts[0]).toContain('**Approval needed** for run `run_1` (agent analyst)');
    expect(prompts[0]).toContain('```sh\npython3 x.py\n```');
    expect(
      DiscordApprovalGateway.describe({ kind: 'write', tool: 'w', summary: 's', path: 'a.md' }, ctx),
    ).toContain('(`a.md`)');
    expect(await denyAllGateway.request(req, ctx)).toBe(false);
  });
});

function fakeOps(overrides: Partial<HarnessOps> = {}): HarnessOps {
  return {
    ask: jest.fn(async (_t, o) => {
      await o.onEvent?.({
        type: 'run_start',
        runId: 'run_1',
        task: 't',
        agent: 'a',
        profile: 'p',
        model: 'm',
        depth: 0,
      });
      return sampleResult();
    }),
    listScrapers: () => [{ name: 'hn', description: 'Hacker News', schedule: '7 * * * *', enabled: true }],
    runScraper: jest.fn(async (name: string) => ({
      name,
      ok: true,
      dryRun: false,
      startedAt: '',
      durationMs: 1000,
      pages: 1,
      fetched: 2,
      valid: 2,
      invalid: 0,
      new: 1,
      changed: 0,
      written: 1,
      notModified: false,
      issues: [],
      invalidSamples: [],
      consecutiveFailures: 0,
      sample: [],
    })),
    scraperStatus: async (name) => `status of ${name}`,
    repairScraper: jest.fn(async () => sampleResult({ runId: 'run_fix' })),
    applyScraper: async (name) => `applied ${name}`,
    jobs: () => [
      {
        name: 'scrape:hn',
        cron: '7 * * * *',
        timezone: 'UTC',
        description: '',
        running: false,
        nextRun: '2026-10-24T18:07:00.000Z',
        lastStatus: 'ok',
        runs: 1,
        failures: 0,
      },
    ],
    runs: async () => [
      { runId: 'run_1', agent: 'analyst', outcome: 'completed', costUsd: 0.1, task: 'task text' },
    ],
    run: async (id) =>
      id === 'run_1'
        ? {
            result: sampleResult(),
            taskType: 'analysis',
            source: 'discord',
            profileSelectedBy: 'bandit',
            phases: 'EMR',
            judge: { score: 0.9, verdict: 'success', reason: 'ok', judgedBy: 'llm' },
            learned: { at: 'x', lessons: ['wiki/lessons/a.md'] },
          }
        : undefined,
    stop: (id) => id === 'run_live',
    feedback: async (id) => id === 'run_1',
    budget: () => ({ todayUsd: 1.5, capUsd: 10, history: [{ date: '2026-10-24', usd: 1.5 }] }),
    skills: () => [{ name: 'build-scraper', description: 'Build a scraper' }],
    proposedSkills: async () => [{ name: 'count-rows', description: 'Count rows', runId: 'run_1' }],
    approveSkill: jest.fn(async () => undefined),
    rejectSkill: jest.fn(async () => undefined),
    searchKnowledge: async (q) =>
      q === 'none'
        ? []
        : [
            {
              path: 'knowledge/wiki/crawling/robots-txt.md',
              title: 'robots.txt',
              score: 3,
              snippet: 'longest match wins',
            },
          ],
    learn: async () => 2,
    profiles: () => [
      {
        context: 'claude-opus-5-5|analysis',
        profileId: 't4-plan-tools-128k',
        mean: 0.75,
        pulls: 4,
        avgCostUsd: 0.2,
      },
    ],
    status: () => ({ uptime: '5 min', 'active runs': 0 }),
    dashboards: async () => [dashboardInfo],
    dashboard: async (slug) => (slug === 'sales' ? { ...dashboardInfo, html: '<!doctype html>' } : undefined),
    exploreDataset: jest.fn(async (dataset: string) => ({
      ...dashboardInfo,
      slug: `explore-${dataset}`,
      title: `${dataset} explorer`,
      warnings: ['facets: dropped id (all values distinct)'],
    })),
    ...overrides,
  };
}

const dashboardInfo = {
  slug: 'sales',
  title: 'Sales',
  builtAt: '2026-10-25T08:00:00.000Z',
  url: 'https://harness.example/dashboards/sales/',
  bytes: 4096,
  rows: 1234,
};

function responder() {
  const log: Array<{ kind: string; value?: unknown }> = [];
  const r: Responder & { replies: CommandReply[]; log: typeof log } = {
    replies: [],
    log,
    defer: async (e) => void log.push({ kind: 'defer', value: e }),
    progress: async (t) => void log.push({ kind: 'progress', value: t }),
    finish: async (reply) => {
      log.push({ kind: 'finish' });
      r.replies.push(reply);
    },
  };
  return r;
}

const user = { id: '111111', name: 'javi', roles: [] };
const admin = { id: '222222', name: 'root', roles: [] };
const inv = (
  command: string,
  options: Invocation['options'] = {},
  subcommand?: string,
  who: Invocation['user'] = user,
): Invocation => ({ command, subcommand, options, user: who, channelId: 'c1' });

describe('CommandRouter', () => {
  test('help is public; everything else needs authorization; admin commands need admins', async () => {
    const router = new CommandRouter(fakeOps(), policy);
    const r1 = responder();
    await router.dispatch(inv('help', {}, undefined, { id: '1', roles: [] }), r1);
    expect(r1.replies[0]!.content).toContain('analyst-harness commands');
    const r2 = responder();
    await router.dispatch(inv('budget', {}, undefined, { id: '1', roles: [] }), r2);
    expect(r2.replies[0]).toMatchObject({
      ephemeral: true,
      content: expect.stringContaining('not authorized'),
    });
    const r3 = responder();
    await router.dispatch(inv('learn'), r3);
    expect(r3.replies[0]!.content).toMatch(/restricted to admins/);
    const r4 = responder();
    await router.dispatch(inv('learn', {}, undefined, admin), r4);
    expect(r4.log.map((l) => l.kind)).toEqual(['defer', 'finish']);
    expect(r4.replies[0]!.content).toBe('Learning loop processed 2 runs.');
  });

  test('/ask defers, streams progress, passes approvals and attaches feedback buttons', async () => {
    const ops = fakeOps();
    const approvals = { request: async () => true };
    const router = new CommandRouter(ops, policy, { approvalsFor: () => approvals });
    const r = responder();
    await router.dispatch(inv('ask', { task: 'Total sales', profile: 't4-plan-bash-128k' }), r);
    expect(ops.ask).toHaveBeenCalledWith(
      'Total sales',
      expect.objectContaining({
        profile: 't4-plan-bash-128k',
        requestedBy: 'javi',
        approvals,
        source: 'discord',
      }),
    );
    expect(r.log[0]).toEqual({ kind: 'defer', value: undefined });
    expect(r.replies[0]!.feedbackRunId).toBe('run_1');
    const empty = responder();
    await router.dispatch(inv('ask', { task: '  ' }), empty);
    expect(empty.replies[0]!.content).toMatch(/Usage/);
  });

  test('scraper subcommands', async () => {
    const ops = fakeOps();
    const router = new CommandRouter(ops, policy);
    const call = async (sub: string, options: Invocation['options'] = {}, who: Invocation['user'] = user) => {
      const r = responder();
      await router.dispatch(inv('scrape', options, sub, who), r);
      return r.replies[0]!.content;
    };
    expect(await call('list')).toContain('hn');
    expect(await call('run', { name: 'hn', dry_run: true })).toMatch(/^OK scraper hn/);
    expect(ops.runScraper).toHaveBeenCalledWith('hn', true);
    expect(await call('status', { name: 'hn' })).toBe('status of hn');
    expect(await call('repair', { name: 'hn' })).toContain('run_fix');
    expect(await call('apply', { name: 'hn' }, admin)).toBe('applied hn');
    expect(await call('apply', { name: 'hn' })).toMatch(/restricted to admins/);
    expect(await call('run')).toMatch(/Usage/);
    expect(await call('status')).toMatch(/Usage/);
    expect(await call('repair')).toMatch(/Usage/);
    expect(await call('apply', {}, admin)).toMatch(/Usage/);
    expect(await call('bogus')).toMatch(/Usage: \/scrape/);
  });

  test('runs, run details, stop, feedback, budget, jobs, profiles and status', async () => {
    const router = new CommandRouter(fakeOps(), policy);
    const call = async (command: string, options: Invocation['options'] = {}) => {
      const r = responder();
      await router.dispatch(inv(command, options), r);
      return r.replies[0]!.content;
    };
    expect(await call('runs', { limit: 5 })).toContain('run_1');
    expect(await call('run', { id: 'run_1' })).toMatch(/judge: success \(0.90\)/);
    expect(await call('run', { id: 'run_x' })).toMatch(/No run/);
    expect(await call('stop', { id: 'run_live' })).toBe('Stopping run run_live.');
    expect(await call('stop', { id: 'run_1' })).toMatch(/not running/);
    expect(await call('feedback', { id: 'run_1', value: 'down' })).toMatch(/recorded bad/);
    expect(await call('feedback', { id: 'zzz', value: 'up' })).toMatch(/No run/);
    expect(await call('budget')).toMatch(/Today: \$1.50 of \$10.00/);
    expect(await call('jobs')).toContain('scrape:hn');
    expect(await call('profiles')).toContain('t4-plan-tools-128k');
    expect(await call('status')).toContain('**uptime**: 5 min');
    expect(await call('mystery')).toMatch(/Unknown command/);
  });

  test('skills, knowledge and lessons', async () => {
    const ops = fakeOps();
    const router = new CommandRouter(ops, policy);
    const call = async (
      command: string,
      sub?: string,
      options: Invocation['options'] = {},
      who: Invocation['user'] = user,
    ) => {
      const r = responder();
      await router.dispatch(inv(command, options, sub, who), r);
      return r.replies[0]!.content;
    };
    expect(await call('skills', 'list')).toContain('build-scraper');
    expect(await call('skills', 'proposed')).toContain('count-rows');
    expect(await call('skills', 'approve', { name: 'count-rows' }, admin)).toMatch(
      /Approved skill count-rows/,
    );
    expect(await call('skills', 'reject', { name: 'count-rows' }, admin)).toMatch(/Rejected/);
    expect(await call('skills', 'approve', {}, admin)).toMatch(/Usage/);
    expect(await call('skills', 'reject', {}, admin)).toMatch(/Usage/);
    expect(await call('skills', 'zzz')).toMatch(/Usage/);
    expect(await call('knowledge', undefined, { query: 'robots' })).toContain('longest match wins');
    expect(await call('knowledge', undefined, { query: 'none' })).toMatch(/Nothing found/);
    expect(await call('knowledge')).toMatch(/Usage/);
    expect(await call('lessons')).toContain('Vault results');
  });

  test('empty states and errors', async () => {
    const router = new CommandRouter(
      fakeOps({
        jobs: () => [],
        runs: async () => [],
        listScrapers: () => [],
        proposedSkills: async () => [],
        profiles: () => [],
        budget: () => ({ todayUsd: 0, capUsd: 0, history: [] }),
        runScraper: async () => Promise.reject(new Error('unknown scraper zz')),
      }),
      policy,
    );
    const call = async (command: string, sub?: string, options: Invocation['options'] = {}) => {
      const r = responder();
      await router.dispatch(inv(command, options, sub), r);
      return r.replies[0]!;
    };
    expect((await call('jobs')).content).toBe('No scheduled jobs.');
    expect((await call('runs')).content).toBe('No runs yet.');
    expect((await call('scrape', 'list')).content).toBe('No scrapers registered.');
    expect((await call('skills', 'proposed')).content).toBe('No skill proposals waiting.');
    expect((await call('profiles')).content).toMatch(/no data yet/);
    expect((await call('budget')).content).toContain('no cap');
    expect(await call('scrape', 'run', { name: 'zz' })).toMatchObject({
      ephemeral: true,
      content: 'Error: unknown scraper zz',
    });
  });

  test('dashboard list, get (with the HTML attached) and explore', async () => {
    const ops = fakeOps();
    const router = new CommandRouter(ops, policy);
    let r = responder();
    await router.dispatch(inv('dashboard', {}, 'list'), r);
    expect(r.replies[0]!.content).toContain('**1 dashboard**');
    expect(r.replies[0]!.content).toContain('<https://harness.example/dashboards/sales/>');
    expect(r.replies[0]!.content).toContain('1,234 rows');
    r = responder();
    await router.dispatch(inv('dashboard', { name: 'sales' }, 'get'), r);
    expect(r.replies[0]!.file).toEqual({ name: 'sales.html', content: '<!doctype html>' });
    r = responder();
    await router.dispatch(inv('dashboard', { name: 'nope' }, 'get'), r);
    expect(r.replies[0]).toMatchObject({ ephemeral: true });
    expect(r.replies[0]!.content).toContain('No dashboard nope');
    r = responder();
    await router.dispatch(inv('dashboard', { dataset: 'hn' }, 'explore'), r);
    expect(r.log[0]).toEqual({ kind: 'defer', value: undefined });
    expect(ops.exploreDataset).toHaveBeenCalledWith('hn');
    expect(r.replies[0]!.content).toContain('**hn explorer** `explore-hn`');
    expect(r.replies[0]!.content).toContain('Warnings: facets: dropped id');
    expect(r.replies[0]!.content).toContain('too large to attach');
    r = responder();
    await router.dispatch(inv('dashboard', {}, 'explore'), r);
    expect(r.replies[0]!.content).toContain('Usage: /dashboard explore');
    r = responder();
    await new CommandRouter(fakeOps({ dashboards: async () => [] }), policy).dispatch(
      inv('dashboard', {}, 'list'),
      r,
    );
    expect(r.replies[0]!.content).toContain('No dashboards yet');
    expect(parsePrefixCommand('!dashboard get sales')).toEqual({
      command: 'dashboard',
      subcommand: 'get',
      options: { name: 'sales', dataset: 'sales' },
    });
  });

  test('prefix commands parse into invocations', () => {
    expect(parsePrefixCommand('hello')).toBeUndefined();
    expect(parsePrefixCommand('!')).toBeUndefined();
    expect(parsePrefixCommand('!ask how many rows?')).toEqual({
      command: 'ask',
      options: { task: 'how many rows?' },
    });
    expect(parsePrefixCommand('!scrape run hn --dry-run')).toEqual({
      command: 'scrape',
      subcommand: 'run',
      options: { name: 'hn', dry_run: true },
    });
    expect(parsePrefixCommand('!feedback run_1 bad')).toEqual({
      command: 'feedback',
      options: { id: 'run_1', value: 'down' },
    });
    expect(parsePrefixCommand('!runs 5')).toEqual({ command: 'runs', options: { limit: 5 } });
    expect(parsePrefixCommand('!stop run_1')).toEqual({ command: 'stop', options: { id: 'run_1' } });
    expect(parsePrefixCommand('!knowledge robots')).toEqual({
      command: 'knowledge',
      options: { query: 'robots' },
    });
    expect(parsePrefixCommand('!lessons')).toEqual({ command: 'lessons', options: { query: undefined } });
    expect(parsePrefixCommand('!budget')).toEqual({ command: 'budget', options: {} });
    expect(parsePrefixCommand('?help', '?')).toEqual({ command: 'help', options: {} });
  });
});
