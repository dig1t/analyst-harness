import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentEvent } from '../../src/core/agent-loop';
import { KnowledgeVault } from '../../src/knowledge/vault';
import { ProfileBandit, sampleBeta, seededRandom } from '../../src/learning/bandit';
import { heuristicVerdict, RunJudge, trajectoryDigest } from '../../src/learning/judge';
import { Reflector } from '../../src/learning/reflection';
import { RunStore, type RunMeta } from '../../src/learning/run-store';
import { LearningService } from '../../src/learning/service';
import { SkillSynthesizer } from '../../src/learning/skill-synthesis';
import { classifyTask } from '../../src/learning/task-classifier';
import { labelTrajectory, phaseHistogram, phaseOfCall } from '../../src/learning/taxonomy';
import { ScriptedProvider } from '../../src/llm/scripted';
import { sampleResult, tmpDir, writeFiles } from '../helpers';

const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const resp = (step: number, toolCalls: Array<{ name: string; input: unknown }>, text = ''): AgentEvent => ({
  type: 'llm_response',
  step,
  stopReason: toolCalls.length ? 'tool_use' : 'end_turn',
  usage,
  costUsd: 0,
  model: 'm',
  text,
  toolCalls: toolCalls.map((c, i) => ({ id: `c${step}_${i}`, ...c })),
  progress: [],
});

describe('task classifier', () => {
  test.each([
    ['Scrape the job listings from this site every day', 'scrape'],
    ['What is the median order value by month in sales.csv?', 'analysis'],
    ['Write a weekly report on the HN dataset', 'report'],
    ['The arxiv scraper is broken, fix the selectors', 'maintenance'],
    ['Ingest this article into the wiki', 'knowledge'],
    ['hello there', 'general'],
  ])('%s -> %s', (text, type) => {
    expect(classifyTask(text)).toBe(type);
  });
});

describe('trajectory taxonomy', () => {
  test('maps tool calls to data-analysis phases', () => {
    expect(phaseOfCall('web_fetch', {})).toBe('A');
    expect(phaseOfCall('read_file', {})).toBe('E');
    expect(phaseOfCall('write_file', { path: 'scratch/clean.py' })).toBe('T');
    expect(phaseOfCall('write_file', { path: 'reports/summary.md' })).toBe('R');
    expect(phaseOfCall('edit_file', { path: 'tests/test_x.py' })).toBe('V');
    expect(phaseOfCall('sql_query', { query: 'SELECT region, sum(x) FROM t GROUP BY region' })).toBe('M');
    expect(phaseOfCall('sql_query', { query: 'SUMMARIZE SELECT * FROM t' })).toBe('E');
    expect(phaseOfCall('bash', { command: 'pytest -q' })).toBe('V');
    expect(phaseOfCall('bash', { command: 'curl -s https://x' })).toBe('A');
    expect(phaseOfCall('bash', { command: 'head -5 data.csv' })).toBe('E');
    expect(phaseOfCall('bash', { command: 'python3 analyze.py' })).toBe('M');
    expect(phaseOfCall('bash', { command: 'mkdir out' })).toBe('O');
    expect(phaseOfCall('update_plan', {})).toBe('O');
  });

  test('labels turns by priority and the final answer as Report', () => {
    const events = [
      resp(1, [{ name: 'update_plan', input: {} }]),
      resp(2, [
        { name: 'read_file', input: {} },
        { name: 'write_file', input: { path: 'x.py' } },
      ]),
      resp(3, [
        { name: 'sql_query', input: { query: 'select 1' } },
        { name: 'bash', input: { command: 'pytest' } },
      ]),
      resp(4, [], 'Answer'),
      resp(5, [], ''),
    ];
    const phases = labelTrajectory(events);
    expect(phases.join('')).toBe('OTMRO');
    expect(phaseHistogram(phases)).toMatchObject({ O: 2, T: 1, M: 1, R: 1, A: 0 });
  });
});

describe('judge', () => {
  const events: AgentEvent[] = [
    resp(1, [{ name: 'sql_query', input: { query: 'select count(*) from t' } }], 'Counting rows'),
    {
      type: 'tool_result',
      step: 1,
      toolCallId: 'c1_0',
      name: 'sql_query',
      input: {},
      isError: false,
      permissionDenied: false,
      durationMs: 1,
      eventId: 1,
      preview: '| 42 |',
      outputChars: 6,
    },
    { type: 'context', step: 2, event: { action: 'elide', tokensBefore: 100, tokensAfter: 50, count: 1 } },
    { type: 'stuck', step: 3, kind: 'repeat_reminder', tool: 'bash', count: 5 },
  ];

  test('digest summarizes the trajectory', () => {
    const d = trajectoryDigest(events);
    expect(d).toContain('[step 1 call sql_query]');
    expect(d).toContain('[step 1 result sql_query] | 42 |');
    expect(d).toContain('context elide');
    expect(d).toContain('stuck repeat_reminder');
  });

  test('heuristic verdicts', () => {
    expect(heuristicVerdict(sampleResult({ outcome: 'stuck' }), ['E'])).toMatchObject({
      verdict: 'failure',
      score: 0,
    });
    expect(heuristicVerdict(sampleResult({ outcome: 'max_steps' }), ['M'])).toMatchObject({
      score: 0.1,
      failureStage: 'verification',
    });
    expect(heuristicVerdict(sampleResult({ outcome: 'aborted', toolCalls: 0 }), [])).toMatchObject({
      failureStage: 'data_acquisition',
    });
    expect(heuristicVerdict(sampleResult({ finalText: ' ' }), ['R'])).toMatchObject({
      failureStage: 'reporting',
    });
    expect(heuristicVerdict(sampleResult(), ['M', 'V', 'R'])).toMatchObject({
      score: 0.7,
      judgedBy: 'heuristic',
    });
    expect(heuristicVerdict(sampleResult(), ['M', 'R'])).toMatchObject({
      score: 0.55,
      failureStage: 'verification',
    });
  });

  test('LLM judge parses JSON and falls back on bad output or errors', async () => {
    const good = new RunJudge({
      provider: new ScriptedProvider([
        {
          text: '{"score": 0.95, "verdict": "success", "failure_stage": null, "reason": "Backed by the query."}',
        },
      ]),
      model: 'm',
    });
    expect((await good.judge(sampleResult(), events, ['M', 'R'])).verdict).toEqual({
      score: 0.95,
      verdict: 'success',
      failureStage: undefined,
      reason: 'Backed by the query.',
      judgedBy: 'llm',
    });
    const partial = new RunJudge({
      provider: new ScriptedProvider([{ text: '{"score": 0.5, "failure_stage": "verification"}' }]),
      model: 'm',
    });
    expect((await partial.judge(sampleResult(), events, ['M'])).verdict).toMatchObject({
      verdict: 'partial',
      failureStage: 'verification',
    });
    const junk = new RunJudge({
      provider: new ScriptedProvider([{ text: 'I think it went well' }]),
      model: 'm',
    });
    expect((await junk.judge(sampleResult(), events, ['M', 'V'])).verdict.judgedBy).toBe('heuristic');
    const broken = new RunJudge({
      provider: {
        name: 'x',
        capabilities: () => ({ bindsThinkingToPrefix: false, contextWindow: 1 }),
        complete: async () => Promise.reject(new Error('down')),
      },
      model: 'm',
    });
    expect((await broken.judge(sampleResult(), events, [])).verdict.judgedBy).toBe('heuristic');
  });
});

describe('ProfileBandit', () => {
  test('beta samples have the right mean and the PRNG is deterministic', () => {
    const rand = seededRandom(7);
    const n = 4000;
    let sum = 0;
    for (let i = 0; i < n; i++) sum += sampleBeta(8, 2, rand);
    expect(sum / n).toBeGreaterThan(0.76);
    expect(sum / n).toBeLessThan(0.84);
    expect(seededRandom(1)()).toBe(seededRandom(1)());
    const small = sampleBeta(0.5, 0.5, seededRandom(3));
    expect(small).toBeGreaterThanOrEqual(0);
    expect(small).toBeLessThanOrEqual(1);
  });

  test('learns to prefer the profile that succeeds, and cost breaks ties', async () => {
    const bandit = new ProfileBandit(undefined, { costWeight: 0.5, costScaleUsd: 1, priors: {} });
    const ctx = ProfileBandit.contextKey('claude-opus-5-5', 'analysis');
    for (let i = 0; i < 30; i++) {
      await bandit.update(ctx, 'good', 1, 0.1);
      await bandit.update(ctx, 'bad', 0, 0.1);
    }
    const rand = seededRandom(42);
    const picks = Array.from({ length: 50 }, () => bandit.select(ctx, ['good', 'bad'], rand).profileId);
    expect(picks.filter((p) => p === 'good').length).toBeGreaterThan(45);

    const cheap = new ProfileBandit(undefined, { costWeight: 0.5, costScaleUsd: 1, priors: {} });
    for (let i = 0; i < 40; i++) {
      await cheap.update(ctx, 'cheap', 0.8, 0.05);
      await cheap.update(ctx, 'pricey', 0.8, 1.5);
    }
    const r2 = seededRandom(9);
    const p2 = Array.from({ length: 50 }, () => cheap.select(ctx, ['cheap', 'pricey'], r2).profileId);
    expect(p2.filter((p) => p === 'cheap').length).toBeGreaterThan(40);
  });

  test('priors, feedback, summary and persistence', async () => {
    const file = path.join(await tmpDir(), 'bandit.json');
    const bandit = new ProfileBandit(file, {
      costWeight: 0,
      costScaleUsd: 1,
      priors: { base: { alpha: 5, beta: 1 } },
    });
    expect(bandit.arm('c', 'base')).toMatchObject({ alpha: 5, beta: 1, pulls: 0 });
    await bandit.update('c', 'base', 2, -1);
    await bandit.feedback('c', 'base', false);
    await bandit.flush();
    expect(bandit.arm('c', 'base')).toMatchObject({
      alpha: 6,
      beta: 3,
      pulls: 1,
      totalCostUsd: 0,
      totalReward: 1,
    });
    expect(bandit.summary('c')[0]).toMatchObject({ profileId: 'base', pulls: 1 });
    const loaded = await new ProfileBandit(file).load();
    expect(loaded.snapshot.contexts.c!.base!.alpha).toBe(6);
    expect(() => bandit.select('c', [])).toThrow();
  });
});

describe('RunStore', () => {
  test('records events, finishes runs and finds unlearned ones', async () => {
    const store = new RunStore(await tmpDir());
    const rec = store.recorder('run_1');
    await rec({
      type: 'run_start',
      runId: 'run_1',
      task: 't',
      agent: 'a',
      profile: 'p',
      model: 'm',
      depth: 0,
    });
    await rec({ type: 'run_end', result: sampleResult() });
    const events = await store.events('run_1');
    expect(events.map((e) => e.type)).toEqual(['run_start', 'run_end']);
    expect(events[0]!.at).toMatch(/^20/);
    const meta: RunMeta = {
      result: sampleResult(),
      taskType: 'analysis',
      source: 'cli',
      profileSelectedBy: 'bandit',
    };
    await store.finish(meta);
    await store.finish({ ...meta, result: sampleResult({ runId: 'run_2' }) });
    expect((await store.list(10)).map((r) => r.runId)).toEqual(['run_2', 'run_1']);
    expect((await store.unlearned()).map((m) => m.result.runId)).toEqual(['run_2', 'run_1']);
    await store.updateMeta('run_1', (m) => ({ ...m, learned: { at: 'now', lessons: [] } }));
    expect((await store.unlearned()).map((m) => m.result.runId)).toEqual(['run_2']);
    expect(await store.exists('run_1')).toBe(true);
    expect(await store.updateMeta('run_missing', (m) => m)).toBeUndefined();
    expect(() => store.runDir('../evil')).toThrow();
  });
});

describe('Reflector and SkillSynthesizer', () => {
  test('writes lessons, merges near-duplicates and retrieves them for new tasks', async () => {
    const dir = await tmpDir();
    await writeFiles(dir, { 'wiki/index.md': '# Knowledge Base Index\n', 'wiki/log.md': '# Wiki Log\n' });
    const vault = new KnowledgeVault(dir);
    const lessons = {
      lessons: [
        {
          title: 'Use the HN Firebase API for item details',
          context: 'HN scraping',
          lesson: 'Fetch /v0/item/{id}.json per story.',
          evidence: 'step 3',
          tags: ['apis'],
        },
      ],
    };
    const reflector = new Reflector(
      new ScriptedProvider([
        { text: JSON.stringify(lessons) },
        {
          text: JSON.stringify({
            lessons: [{ ...lessons.lessons[0], title: 'Use the HN Firebase API for item detail' }],
          }),
        },
      ]),
      'm',
      vault,
    );
    const r1 = await reflector.reflect(sampleResult({ outcome: 'max_steps' }), []);
    expect(r1.lessons).toEqual(['wiki/lessons/use-the-hn-firebase-api-for-item-details.md']);
    const r2 = await reflector.reflect(sampleResult({ runId: 'run_9' }), []);
    expect(r2.lessons).toEqual(r1.lessons);
    const body = await fsp.readFile(path.join(dir, r1.lessons[0]!), 'utf8');
    expect(body).toContain('Confirmed again by run run_9');
    expect(await fsp.readFile(path.join(dir, 'wiki/index.md'), 'utf8')).toContain(
      'lessons/use-the-hn-firebase-api-for-item-details.md',
    );
    expect(await fsp.readFile(path.join(dir, 'wiki/log.md'), 'utf8')).toContain(
      'lessons | 1 lesson from run run_1',
    );
    expect(await reflector.relevantLessons('scrape hacker news items with the firebase api')).toContain(
      '# Lessons from past runs',
    );
    expect(await reflector.relevantLessons('zzzz qqqq')).toBe('');
    const quiet = new Reflector(new ScriptedProvider([{ text: 'nothing to learn' }]), 'm', vault);
    expect((await quiet.reflect(sampleResult(), [])).lessons).toEqual([]);
  });

  test('proposes skills for approval and never loads them until approved', async () => {
    const root = await tmpDir();
    const skill =
      '---\nname: count-rows\ndescription: Count rows in a dataset. Use when asked how many records exist.\n---\n\n# Count rows\n\n1. Run SQL \u2014 count.\n';
    const synth = new SkillSynthesizer(
      root,
      new ScriptedProvider([
        { text: '```markdown\n' + skill + '```' },
        { text: skill },
        { text: 'no frontmatter at all' },
      ]),
      'm',
    );
    const res = await synth.propose(sampleResult(), []);
    expect(res.proposal).toMatchObject({ name: 'count-rows', runId: 'run_1' });
    const written = await fsp.readFile(path.join(root, 'proposed/count-rows/SKILL.md'), 'utf8');
    expect(written).not.toContain('\u2014');
    expect((await synth.propose(sampleResult(), [])).error).toMatch(/already exists/);
    expect((await synth.propose(sampleResult(), [])).error).toMatch(/invalid skill frontmatter/);
    expect((await synth.list()).map((p) => p.name)).toEqual(['count-rows']);
    expect(await synth.approve('count-rows')).toBe(path.join(root, 'learned/count-rows'));
    expect(await synth.list()).toEqual([]);
    await expect(synth.approve('../escape')).rejects.toThrow(/invalid skill name/);
    await synth.reject('count-rows');
    expect((await new SkillSynthesizer(root).propose(sampleResult(), [])).error).toMatch(/no model/);
  });
});

describe('LearningService', () => {
  async function setup(judgeText: string, steps = 8) {
    const runs = new RunStore(await tmpDir());
    const bandit = new ProfileBandit(undefined, { costWeight: 0, costScaleUsd: 1, priors: {} });
    const vaultDir = await tmpDir();
    await writeFiles(vaultDir, {
      'wiki/index.md': '# Knowledge Base Index\n',
      'wiki/log.md': '# Wiki Log\n',
    });
    const vault = new KnowledgeVault(vaultDir);
    const provider = new ScriptedProvider((req) => {
      if (req.purpose === 'judge') return { text: judgeText };
      if (req.purpose === 'reflect')
        return {
          text: '{"lessons": [{"title": "Check row counts before reporting", "context": "x", "lesson": "Run count(*) first.", "evidence": "step 2"}]}',
        };
      return {
        text: '---\nname: sales-totals\ndescription: Total sales by region. Use for regional sales questions.\n---\n\nSteps',
      };
    });
    const service = new LearningService({
      runs,
      bandit,
      judge: new RunJudge({ provider, model: 'm' }),
      reflector: new Reflector(provider, 'm', vault),
      synthesizer: new SkillSynthesizer(await tmpDir(), provider, 'm'),
      config: { judge: true, reflect: 'failures', proposeSkills: true, minStepsForSkill: 6 },
    });
    const meta: RunMeta = {
      result: sampleResult({ steps }),
      taskType: 'analysis',
      source: 'cli',
      profileSelectedBy: 'bandit',
    };
    await runs.finish(meta);
    return { service, bandit, runs, meta };
  }

  test('a successful multi-step run updates the bandit and proposes a skill but writes no lessons', async () => {
    const { service, bandit, meta } = await setup('{"score": 0.9, "verdict": "success", "reason": "ok"}');
    const out = await service.process(meta);
    expect(out.judge).toMatchObject({ verdict: 'success', judgedBy: 'llm' });
    expect(out.learned).toMatchObject({ lessons: [], banditReward: 0.9, skillProposal: 'sales-totals' });
    expect(bandit.arm('claude-opus-5-5|analysis', 't4-plan-tools-128k')).toMatchObject({
      alpha: 1.9,
      pulls: 1,
    });
  });

  test('a failed run reflects into lessons and skips skill synthesis', async () => {
    const { service, meta } = await setup(
      '{"score": 0.2, "verdict": "failure", "failure_stage": "verification", "reason": "unchecked"}',
      3,
    );
    const out = await service.process(meta);
    expect(out.learned!.lessons).toEqual(['wiki/lessons/check-row-counts-before-reporting.md']);
    expect(out.learned!.skillProposal).toBeUndefined();
    expect(out.judge!.failureStage).toBe('verification');
  });

  test('human feedback overrides the judge in later updates and moves the bandit', async () => {
    const { service, bandit, runs, meta } = await setup('{"score": 0.9, "verdict": "success"}');
    await service.feedback(meta.result.runId, 'down', 'javi');
    expect(bandit.arm('claude-opus-5-5|analysis', 't4-plan-tools-128k').beta).toBe(3);
    const reloaded = (await runs.getMeta(meta.result.runId))!;
    expect(reloaded.feedback).toMatchObject({ value: 'down', by: 'javi' });
    const processed = await service.process(reloaded);
    expect(processed.learned!.banditReward).toBe(0);
    expect(await service.feedback('run_missing', 'up')).toBeUndefined();
  });

  test('processPending handles every unlearned run and respects budgets', async () => {
    const { service } = await setup('{"score": 0.9, "verdict": "success"}');
    expect(await service.processPending()).toBe(1);
    expect(await service.processPending()).toBe(0);

    const runs = new RunStore(await tmpDir());
    const judge = { judge: jest.fn() } as unknown as RunJudge;
    const broke = new LearningService({
      runs,
      bandit: new ProfileBandit(),
      judge,
      config: { judge: true, reflect: 'always', proposeSkills: false, minStepsForSkill: 1 },
      budget: { exceeded: () => 'cap', record: () => undefined },
    });
    const meta: RunMeta = {
      result: sampleResult(),
      taskType: 'general',
      source: 'cli',
      profileSelectedBy: 'default',
    };
    await runs.finish(meta);
    const out = await broke.process(meta);
    expect(judge.judge as jest.Mock).not.toHaveBeenCalled();
    expect(out.judge!.judgedBy).toBe('heuristic');
    expect(broke.bandit).toBeInstanceOf(ProfileBandit);
  });
});
