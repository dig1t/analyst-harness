import path from 'node:path';
import { loadConfig } from '../../src/config/load';
import { Scheduler, validateCron, type CronFactory } from '../../src/scheduler/scheduler';
import { ConfigError } from '../../src/util/errors';
import { tmpDir, writeFiles } from '../helpers';

function fakeCron() {
  const ticks = new Map<string, () => void>();
  const stopped: string[] = [];
  const factory: CronFactory = (pattern, _tz, tick) => {
    ticks.set(pattern, tick);
    return { nextRun: () => new Date('2026-10-24T18:00:00Z'), stop: () => void stopped.push(pattern) };
  };
  return { factory, ticks, stopped };
}

describe('Scheduler', () => {
  test('validates cron expressions', () => {
    expect(validateCron('*/5 * * * *')).toMatchObject({ ok: true });
    expect(validateCron('0 0 * * 1-5', 'Europe/Madrid').ok).toBe(true);
    expect(validateCron('not a cron')).toMatchObject({ ok: false });
    expect(validateCron('61 * * * *').ok).toBe(false);
  });

  test('runs jobs on ticks, records status and next run', async () => {
    const { factory, ticks, stopped } = fakeCron();
    const s = new Scheduler(factory);
    const run = jest.fn(async () => 'all good');
    s.add({ name: 'a', cron: '*/5 * * * *', run, description: 'demo' });
    expect(() => s.add({ name: 'a', cron: '* * * * *', run })).toThrow(/duplicate/);
    expect(() => s.add({ name: 'b', cron: 'bad', run })).toThrow(/invalid cron/);
    expect(s.list()[0]!.nextRun).toBeUndefined();
    s.start();
    s.start();
    expect(s.list()[0]).toMatchObject({
      name: 'a',
      nextRun: '2026-10-24T18:00:00.000Z',
      description: 'demo',
    });
    ticks.get('*/5 * * * *')!();
    await new Promise((r) => setImmediate(r));
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.list()[0]).toMatchObject({ lastStatus: 'ok', lastMessage: 'all good', runs: 1 });
    s.add({ name: 'late', cron: '0 * * * *', run: async () => undefined });
    expect(ticks.has('0 * * * *')).toBe(true);
    s.remove('late');
    expect(s.has('late')).toBe(false);
    s.stop();
    expect(stopped).toEqual(expect.arrayContaining(['*/5 * * * *', '0 * * * *']));
  });

  test('skips overlapping runs and reports failures', async () => {
    const onError = jest.fn();
    const s = new Scheduler(fakeCron().factory, undefined, onError);
    let release: () => void = () => undefined;
    s.add({ name: 'slow', cron: '* * * * *', run: () => new Promise<void>((r) => (release = r)) });
    s.add({ name: 'boom', cron: '* * * * *', run: async () => Promise.reject(new Error('scrape failed')) });
    const first = s.runNow('slow');
    expect((await s.runNow('slow')).lastStatus).toBe('skipped');
    release();
    expect((await first).lastStatus).toBe('ok');
    const failed = await s.runNow('boom');
    expect(failed).toMatchObject({ lastStatus: 'error', lastMessage: 'scrape failed', failures: 1 });
    expect(onError).toHaveBeenCalledWith('boom', 'scrape failed');
    await expect(s.runNow('ghost')).rejects.toThrow(/unknown job/);
  });
});

describe('config', () => {
  test('defaults apply without a config file and paths resolve against the root', async () => {
    const root = await tmpDir();
    const cfg = await loadConfig({ root, env: {} });
    expect(cfg.models).toMatchObject({ default: 'claude-opus-5-5', effort: 'medium' });
    expect(cfg.provider).toBe('claude-code');
    expect(cfg.claudeCode).toEqual({ command: 'claude' });
    expect(cfg.resolved.workspace).toBe(path.join(root, 'data', 'workspace'));
    expect(cfg.resolved.knowledge).toBe(path.join(root, 'knowledge'));
    expect(cfg.resolved.learnedSkills).toBe(cfg.resolved.skills);
    expect(cfg.profiles.candidates).toContain('t4-plan-tools-128k');
    expect(cfg.discordEnv).toMatchObject({ allowedUserIds: [], allowEveryone: false });
  });

  test('environment overrides and Discord settings', async () => {
    const root = await tmpDir();
    const cfg = await loadConfig({
      root,
      env: {
        HARNESS_DATA_DIR: '/srv/data',
        HARNESS_LEARNED_SKILLS_DIR: '/srv/skills',
        HARNESS_SCRAPERS_DIR: '/srv/scrapers',
        HARNESS_AGENTS_DIR: '/srv/agents',
        HARNESS_MODEL: 'claude-sonnet-5-5',
        HARNESS_PROVIDER: 'scripted',
        HARNESS_DAILY_BUDGET_USD: '3.5',
        HARNESS_RUN_BUDGET_USD: 'junk',
        LOG_LEVEL: 'debug',
        LOG_FORMAT: 'pretty',
        DISCORD_TOKEN: 'tok',
        DISCORD_ALLOWED_USER_IDS: '123456,234567',
        DISCORD_ALLOW_EVERYONE: 'true',
        DISCORD_WEBHOOK_ALERTS_URL: 'https://discord.test/hook',
      },
    });
    expect(cfg.resolved.data).toBe('/srv/data');
    expect(cfg.resolved.learnedSkills).toBe('/srv/skills');
    expect(cfg.resolved.scrapers).toBe('/srv/scrapers');
    expect(cfg.resolved.agents).toBe('/srv/agents');
    expect(cfg.models.default).toBe('claude-sonnet-5-5');
    expect(cfg.provider).toBe('scripted');
    expect(cfg.budgets).toEqual({ dailyUsd: 3.5, runUsd: 2 });
    expect(cfg.logging).toEqual({ level: 'debug', format: 'pretty' });
    expect(cfg.discordEnv).toMatchObject({
      token: 'tok',
      allowedUserIds: ['123456', '234567'],
      allowEveryone: true,
      webhookAlerts: 'https://discord.test/hook',
    });
  });

  test('invalid files are rejected with useful messages', async () => {
    const root = await tmpDir();
    await writeFiles(root, { 'config/harness.yaml': 'models:\n  effort: extreme\n' });
    await expect(loadConfig({ root, env: {} })).rejects.toThrow(/models.effort/);
    await writeFiles(root, { 'config/harness.yaml': 'unknownKey: 1\n' });
    await expect(loadConfig({ root, env: {} })).rejects.toBeInstanceOf(ConfigError);
    await writeFiles(root, { 'config/harness.yaml': 'models: [unclosed\n' });
    await expect(loadConfig({ root, env: {} })).rejects.toThrow(/Cannot read/);
  });

  test('the repository config/harness.yaml is valid', async () => {
    const root = path.resolve(__dirname, '../..');
    const cfg = await loadConfig({ root, env: {} });
    expect(cfg.provider).toBe('claude-code');
    expect(cfg.permissions.bashAllowExtra).toEqual(['^(python3|duckdb|sqlite3)\\b']);
    expect(cfg.resolved.scrapers).toBe(path.join(root, 'config', 'scrapers'));
  });
});
