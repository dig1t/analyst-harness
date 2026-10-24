import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mapConcurrent, Semaphore } from '../../src/util/concurrency';
import { unifiedDiff } from '../../src/util/diff';
import { ConfigError, errorMessage, PermissionDeniedError, ToolError } from '../../src/util/errors';
import { parseFrontmatter, stringifyFrontmatter } from '../../src/util/frontmatter';
import {
  appendJsonl,
  ensureDir,
  pathExists,
  readJson,
  readJsonl,
  walkFiles,
  writeJsonAtomic,
  writeTextAtomic,
} from '../../src/util/fs';
import { globToRegExp, isIgnoredPath } from '../../src/util/glob';
import { hashRecord, sha256, stableStringify } from '../../src/util/hash';
import { newId, todayUtc } from '../../src/util/ids';
import { createLogger, redact } from '../../src/util/logger';
import { computeBackoff, parseRetryAfter, retry } from '../../src/util/retry';
import {
  chunkText,
  countLines,
  formatUsd,
  markdownTable,
  slugify,
  truncateMiddle,
} from '../../src/util/text';
import { tmpDir } from '../helpers';

describe('text', () => {
  test('countLines ignores a trailing newline', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('a\nb')).toBe(2);
  });

  test('truncateMiddle keeps head and tail and reports the cut', () => {
    const text = 'H'.repeat(1000) + 'T'.repeat(1000);
    const out = truncateMiddle(text, 500);
    expect(out.length).toBeLessThanOrEqual(500);
    expect(out.startsWith('HHH')).toBe(true);
    expect(out.endsWith('TTT')).toBe(true);
    expect(out).toMatch(/characters truncated/);
    expect(truncateMiddle('short', 100)).toBe('short');
  });

  test('slugify produces kebab-case ascii', () => {
    expect(slugify('Hello, World! Ünïcode')).toBe('hello-world-unicode');
    expect(slugify('   ')).toBe('untitled');
    expect(slugify('a'.repeat(100), 10)).toHaveLength(10);
  });

  test('chunkText splits on line boundaries within the size', () => {
    const chunks = chunkText('aaaa\nbbbb\ncccc', 9);
    expect(chunks).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(chunkText('', 5)).toEqual(['']);
    expect(chunkText('x'.repeat(12), 5)).toEqual(['xxxxx', 'xxxxx', 'xx']);
    expect(() => chunkText('a', 0)).toThrow();
  });

  test('markdownTable escapes pipes and newlines', () => {
    expect(markdownTable(['a', 'b'], [['x|y', 'line\nbreak']])).toBe(
      '| a | b |\n| --- | --- |\n| x\\|y | line break |',
    );
  });

  test('formatUsd shows more precision for tiny amounts', () => {
    expect(formatUsd(1.234)).toBe('$1.23');
    expect(formatUsd(0.0012)).toBe('$0.0012');
    expect(formatUsd(0)).toBe('$0.00');
  });
});

describe('retry', () => {
  test('computeBackoff stays within the exponential ceiling', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const d = computeBackoff(attempt, { baseMs: 100, maxMs: 2000 }, () => 0.999);
      expect(d).toBeLessThanOrEqual(Math.min(2000, 100 * 2 ** attempt));
    }
    expect(computeBackoff(3, { baseMs: 100, maxMs: 2000 }, () => 0)).toBe(0);
  });

  test('retries until success and reports each retry', async () => {
    let n = 0;
    const onRetry = jest.fn();
    const out = await retry(
      async () => {
        if (++n < 3) throw new Error('flaky');
        return 'ok';
      },
      { retries: 5, baseMs: 1, maxMs: 2, sleep: async () => undefined, onRetry },
    );
    expect(out).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test('stops when shouldRetry rejects or retries run out', async () => {
    await expect(
      retry(async () => Promise.reject(new Error('fatal')), {
        retries: 3,
        baseMs: 1,
        maxMs: 1,
        shouldRetry: () => false,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow('fatal');
    let calls = 0;
    await expect(
      retry(
        async () => {
          calls++;
          throw new Error('x');
        },
        { retries: 2, baseMs: 1, maxMs: 1, sleep: async () => undefined },
      ),
    ).rejects.toThrow('x');
    expect(calls).toBe(3);
  });

  test('delayFor overrides the computed delay', async () => {
    const sleeps: number[] = [];
    let n = 0;
    await retry(
      async () => {
        if (n++ === 0) throw new Error('later');
        return 1;
      },
      { retries: 1, baseMs: 1, maxMs: 1, delayFor: () => 1234, sleep: async (ms) => void sleeps.push(ms) },
    );
    expect(sleeps).toEqual([1234]);
  });

  test('parseRetryAfter handles seconds, dates and junk', () => {
    expect(parseRetryAfter('120')).toBe(120_000);
    const now = new Date('2026-10-24T00:00:00Z');
    expect(parseRetryAfter('Sat, 24 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe('concurrency', () => {
  test('Semaphore bounds in-flight work', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        sem.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(sem.inFlight).toBe(0);
    expect(() => new Semaphore(0)).toThrow();
  });

  test('mapConcurrent keeps input order', async () => {
    const out = await mapConcurrent([30, 10, 20], 3, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms));
      return i;
    });
    expect(out).toEqual([0, 1, 2]);
  });
});

describe('hash', () => {
  test('stableStringify sorts keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] }, u: undefined })).toBe(
      '{"a":{"c":[3,{"e":0,"f":1}],"d":2},"b":1}',
    );
  });
  test('hashRecord ignores key order', () => {
    expect(hashRecord({ a: 1, b: 2 })).toBe(hashRecord({ b: 2, a: 1 }));
    expect(hashRecord({ a: 1 })).not.toBe(hashRecord({ a: 2 }));
    expect(sha256('abc')).toMatch(/^ba7816bf/);
  });
});

describe('diff', () => {
  test('shows changed lines with context', () => {
    const d = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f.txt');
    expect(d).toContain('--- a/f.txt');
    expect(d).toContain('-b');
    expect(d).toContain('+B');
    expect(d).toMatch(/@@ -1,3 \+1,3 @@/);
  });
  test('handles new files, no change and large inputs', () => {
    expect(unifiedDiff('', 'x\ny\n', 'n.txt')).toContain('+x\n+y');
    expect(unifiedDiff('same', 'same', 'f')).toBe('(no changes)');
    const big = Array.from({ length: 10 }, (_, i) => String(i)).join('\n');
    expect(unifiedDiff(big, big + '\nz', 'f', 3, 5)).toContain('too large');
  });
  test('separate hunks for distant changes', () => {
    const a = Array.from({ length: 30 }, (_, i) => `l${i}`);
    const b = [...a];
    b[2] = 'X';
    b[25] = 'Y';
    const d = unifiedDiff(a.join('\n'), b.join('\n'), 'f');
    expect(d.match(/^@@/gm)).toHaveLength(2);
  });
});

describe('glob', () => {
  test.each([
    ['**/*.csv', 'a/b/c.csv', true],
    ['**/*.csv', 'c.csv', true],
    ['*.csv', 'a/c.csv', false],
    ['data/*.json{,l}', 'data/x.jsonl', true],
    ['data/*.json{,l}', 'data/x.json', true],
    ['file?.txt', 'file1.txt', true],
    ['file[!0-9].txt', 'file1.txt', false],
    ['file[a-c].txt', 'fileb.txt', true],
    ['src/**', 'src/a/b.ts', true],
    ['a.b', 'axb', false],
  ])('%s matches %s: %s', (glob, p, expected) => {
    expect(globToRegExp(glob).test(p)).toBe(expected);
  });
  test('ignored segments', () => {
    expect(isIgnoredPath('a/node_modules/x.js')).toBe(true);
    expect(isIgnoredPath('a/b.js')).toBe(false);
  });
});

describe('fs helpers', () => {
  test('json and jsonl round trips, tolerating a torn last line', async () => {
    const dir = await tmpDir();
    const f = path.join(dir, 'sub', 'x.json');
    expect(await readJson(f, { d: 1 })).toEqual({ d: 1 });
    await writeJsonAtomic(f, { a: 1 });
    expect(await readJson(f, {})).toEqual({ a: 1 });
    const l = path.join(dir, 'x.jsonl');
    await appendJsonl(l, { n: 1 });
    await appendJsonl(l, { n: 2 });
    await fsp.appendFile(l, '{"n": 3');
    expect(await readJsonl(l)).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await readJsonl(path.join(dir, 'missing.jsonl'))).toEqual([]);
    await writeTextAtomic(path.join(dir, 't.txt'), 'hi');
    expect(await pathExists(path.join(dir, 't.txt'))).toBe(true);
    expect(await pathExists(path.join(dir, 'nope'))).toBe(false);
  });

  test('readJson rethrows parse errors', async () => {
    const dir = await tmpDir();
    await fsp.writeFile(path.join(dir, 'bad.json'), '{oops');
    await expect(readJson(path.join(dir, 'bad.json'), {})).rejects.toThrow();
  });

  test('walkFiles lists files sorted and honors the ignore filter', async () => {
    const dir = await tmpDir();
    await ensureDir(path.join(dir, 'b', '.git'));
    await fsp.writeFile(path.join(dir, 'b', 'x.txt'), '');
    await fsp.writeFile(path.join(dir, 'a.txt'), '');
    await fsp.writeFile(path.join(dir, 'b', '.git', 'HEAD'), '');
    expect(await walkFiles(dir, (rel) => rel.includes('.git'))).toEqual(['a.txt', 'b/x.txt']);
    expect(await walkFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('frontmatter', () => {
  test('parses and stringifies', () => {
    const doc = parseFrontmatter<{ name: string }>('---\nname: x\n---\n\nBody');
    expect(doc.hasFrontmatter).toBe(true);
    expect(doc.data.name).toBe('x');
    expect(doc.body.trim()).toBe('Body');
    expect(parseFrontmatter('no fm').hasFrontmatter).toBe(false);
    expect(stringifyFrontmatter({ a: 1 }, '\n\nhello')).toBe('---\na: 1\n---\n\nhello');
  });
  test('invalid YAML throws', () => {
    expect(() => parseFrontmatter('---\na: [unclosed\n---\nbody')).toThrow();
  });
});

describe('ids, errors and logger', () => {
  test('newId is sortable and prefixed', () => {
    const id = newId('run', new Date('2026-10-24T17:05:01.123Z'));
    expect(id).toMatch(/^run_20261024T170501Z_[0-9a-f]{6}$/);
    expect(todayUtc(new Date('2026-10-24T23:59:59Z'))).toBe('2026-10-24');
  });

  test('error helpers', () => {
    expect(new ToolError('x').code).toBe('tool_error');
    expect(new PermissionDeniedError('no')).toBeInstanceOf(ToolError);
    expect(new ConfigError('c').name).toBe('ConfigError');
    expect(errorMessage(new Error('e'))).toBe('e');
    expect(errorMessage('s')).toBe('s');
    expect(errorMessage({ a: 1 })).toBe('{"a":1}');
  });

  test('logger filters levels, redacts secrets and binds fields', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      sink: (l) => lines.push(l),
      now: () => new Date('2026-01-01T00:00:00Z'),
    });
    log.debug('hidden');
    log
      .child({ component: 'x' })
      .info('hello', { apiKey: 'sk-1', nested: { token: 't', ok: 1 }, err: new Error('boom') });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({
      level: 'info',
      msg: 'hello',
      component: 'x',
      apiKey: '[redacted]',
      nested: { token: '[redacted]', ok: 1 },
      err: { message: 'boom' },
    });
    const pretty: string[] = [];
    createLogger({ format: 'pretty', sink: (l) => pretty.push(l) }).warn('w', { a: 1 });
    expect(pretty[0]).toMatch(/WARN {2}w {"a":1}/);
    expect(redact([{ password: 'p' }])).toEqual([{ password: '[redacted]' }]);
  });
});
