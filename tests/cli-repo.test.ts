import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { printEvent, runCli, terminalApprovals, USAGE } from '../src/cli';
import { walkFiles } from '../src/util/fs';
import { sampleResult } from './helpers';

const ROOT = path.resolve(__dirname, '..');

describe('CLI', () => {
  const capture = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (l: string) => void out.push(l), err: (l: string) => void err.push(l) }, out, err };
  };

  test('help and slash command JSON need no configuration', async () => {
    const c = capture();
    expect(await runCli([], c.io)).toBe(0);
    expect(c.out[0]).toBe(USAGE);
    const d = capture();
    expect(await runCli(['discord', 'commands'], d.io)).toBe(0);
    expect(JSON.parse(d.out[0]!).map((x: { name: string }) => x.name)).toContain('ask');
  });

  test('printEvent renders progress lines', () => {
    const c = capture();
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    printEvent(
      { type: 'run_start', runId: 'r', task: 't', agent: 'a', profile: 'p', model: 'm', depth: 0 },
      c.io,
    );
    printEvent(
      {
        type: 'llm_response',
        step: 2,
        stopReason: 'tool_use',
        usage,
        costUsd: 0,
        model: 'm',
        text: '',
        toolCalls: [{ id: '1', name: 'bash', input: { command: 'ls' } }],
        progress: ['note'],
      },
      c.io,
    );
    printEvent(
      {
        type: 'tool_result',
        step: 2,
        toolCallId: '1',
        name: 'bash',
        input: {},
        isError: true,
        permissionDenied: false,
        durationMs: 1,
        eventId: 1,
        preview: 'exit_code: 1\nboom',
        outputChars: 10,
      },
      c.io,
    );
    printEvent(
      { type: 'context', step: 3, event: { action: 'elide', tokensBefore: 10, tokensAfter: 5, count: 1 } },
      c.io,
    );
    printEvent({ type: 'plan', step: 3, plan: '', done: 1, total: 2 }, c.io);
    printEvent({ type: 'stuck', step: 4, kind: 'repeat_reminder', tool: 'bash', count: 5 }, c.io);
    printEvent({ type: 'run_end', result: sampleResult() }, c.io);
    expect(c.err).toEqual([
      '> run r | agent a | m | profile p',
      '  . note',
      '  [2] bash {"command":"ls"}',
      '      ! exit_code: 1',
      '  ~ context elide: 10 -> 5 tokens',
      '  plan 1/2',
      '  ! stuck detector: repeat_reminder (bash x5)',
    ]);
  });

  test('terminal approvals: --yes approves, non-TTY has no gateway', async () => {
    expect(
      await terminalApprovals(true)!.request(
        { kind: 'bash', tool: 'bash', summary: 's' },
        { runId: 'r', agent: 'a' },
      ),
    ).toBe(true);
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    expect(terminalApprovals(false)).toBeUndefined();
    Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
  });

  test('vault, skills, scrapers and doctor commands run against the repository', async () => {
    const cwd = process.cwd();
    process.chdir(ROOT);
    process.env.HARNESS_DATA_DIR = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-data-')), 'data');
    process.env.LOG_LEVEL = 'silent';
    try {
      const s = { out: [] as string[], err: [] as string[] };
      const io = { out: (l: string) => void s.out.push(l), err: (l: string) => void s.err.push(l) };
      expect(await runCli(['skills', 'list'], io)).toBe(0);
      expect(s.out.join('\n')).toContain('karpathy-llm-wiki:');
      expect(await runCli(['scrapers'], io)).toBe(0);
      expect(s.out.join('\n')).toContain('hn-top-stories');
      expect(await runCli(['vault', 'search', 'robots.txt', 'crawl-delay'], io)).toBe(0);
      expect(await runCli(['doctor'], io)).toBe(0);
      expect(s.out.join('\n')).toMatch(/agents loaded/);
      expect(await runCli(['jobs'], io)).toBe(0);
      expect(s.out.join('\n')).toContain('scrape:hn-top-stories');
      expect(await runCli(['runs'], io)).toBe(0);
      expect(await runCli(['profiles'], io)).toBe(0);
      expect(await runCli(['skills', 'proposed'], io)).toBe(0);
      expect(await runCli(['run'], io)).toBe(2);
      expect(await runCli(['scrape'], io)).toBe(2);
      expect(await runCli(['vault', 'nope'], io)).toBe(2);
      expect(await runCli(['skills', 'approve'], io)).toBe(2);
      expect(await runCli(['bogus'], io)).toBe(2);
    } finally {
      process.chdir(cwd);
      delete process.env.HARNESS_DATA_DIR;
      delete process.env.LOG_LEVEL;
    }
  });
});

/** Files written for this repository (vendored third-party skills are excluded). */
async function authoredFiles(): Promise<string[]> {
  const files = await walkFiles(
    ROOT,
    (rel) =>
      /^(node_modules|dist|coverage|data|\.git)(\/|$)/.test(rel) ||
      rel.startsWith('skills/vendor-karpathy') ||
      rel.startsWith('skills/karpathy-llm-wiki') ||
      rel === 'package-lock.json',
  );
  return files.filter(
    (f) =>
      /\.(ts|js|md|ya?ml|json|txt|example)$|Dockerfile$|\.dockerignore$/.test(f) ||
      f.endsWith('.env.example'),
  );
}

describe('repository hygiene', () => {
  test('no em dash characters in authored files (user preference)', async () => {
    const offenders: string[] = [];
    for (const f of await authoredFiles()) {
      const text = await fsp.readFile(path.join(ROOT, f), 'utf8');
      if (text.includes('\u2014')) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test('every YAML and JSON file parses', async () => {
    for (const f of await authoredFiles()) {
      const text = await fsp.readFile(path.join(ROOT, f), 'utf8');
      if (/\.ya?ml$/.test(f)) expect(() => YAML.parse(text)).not.toThrow();
      if (f.endsWith('.json')) expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  test('vendored skills keep their licenses and provenance notes', async () => {
    for (const dir of ['skills/karpathy-llm-wiki', 'skills/vendor-karpathy']) {
      expect(await fsp.readFile(path.join(ROOT, dir, 'LICENSE'), 'utf8')).toMatch(/MIT License/);
      expect(await fsp.readFile(path.join(ROOT, dir, 'VENDORED.md'), 'utf8')).toMatch(/Commit: [0-9a-f]{40}/);
    }
  });

  test('package scripts used by CI exist', async () => {
    const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
    for (const s of ['build', 'test', 'lint', 'typecheck', 'vault:lint', 'start'])
      expect(pkg.scripts[s]).toBeDefined();
  });
});
