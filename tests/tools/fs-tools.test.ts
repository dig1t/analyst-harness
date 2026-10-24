import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  editFileTool,
  globFilesTool,
  grepTextTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from '../../src/tools/fs-tools';
import type { ToolContext } from '../../src/tools/types';
import { PermissionDeniedError } from '../../src/util/errors';
import { makeToolContext, makeWorkspace, tmpDir, writeFiles } from '../helpers';

describe('file tools', () => {
  let root: string;
  let ctx: ToolContext;
  let kbDir: string;

  beforeEach(async () => {
    kbDir = await tmpDir();
    await writeFiles(kbDir, { 'wiki/http/x.md': '# X\nhello' });
    const made = await makeWorkspace([{ alias: 'knowledge', dir: kbDir, mode: 'ro' }]);
    root = made.root;
    ctx = makeToolContext(made.workspace);
    await writeFiles(root, {
      'data/sales.csv': 'region,amount\nnorth,10\nsouth,20\n',
      'data/nested/deep.json': '{"a": 1}',
      'notes.txt': 'one\ntwo\nthree\nfour\n',
      'node_modules/pkg/index.js': 'ignored',
      '.env': 'SECRET=1',
      'dup.txt': 'x\nx\n',
    });
  });

  const run = <I>(
    tool: {
      execute: (
        i: I,
        c: ToolContext,
      ) => Promise<{ content: string; isError?: boolean; changedFiles?: string[] }>;
    },
    input: I,
  ) => tool.execute(input, ctx);

  describe('read_file', () => {
    test('returns numbered lines and records a full read', async () => {
      const out = await run(readFileTool, { path: 'notes.txt' });
      expect(out.content).toMatch(/^\[notes.txt: lines 1-4 of 4, full read\]/);
      expect(out.content).toContain('1\tone');
      expect(ctx.workspace.fileState.hasFullRead(path.join(root, 'notes.txt'))).toBe(true);
    });

    test('partial reads do not satisfy the write gate', async () => {
      const out = await run(readFileTool, { path: 'notes.txt', offset: 2, limit: 2 });
      expect(out.content).toContain('lines 2-3 of 4, partial read');
      expect(out.content).toContain('2\ttwo');
      expect(ctx.workspace.fileState.hasFullRead(path.join(root, 'notes.txt'))).toBe(false);
    });

    test('errors for missing files, directories, binary content and offsets past EOF', async () => {
      await expect(run(readFileTool, { path: 'missing.txt' })).rejects.toThrow(/not found/);
      await expect(run(readFileTool, { path: 'data' })).rejects.toThrow(/directory/);
      await fsp.writeFile(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]));
      await expect(run(readFileTool, { path: 'bin.dat' })).rejects.toThrow(/binary/);
      await expect(run(readFileTool, { path: 'notes.txt', offset: 99 })).rejects.toThrow(/past the end/);
      await expect(run(readFileTool, { path: '../outside' })).rejects.toThrow(/escapes/);
    });

    test('enforces the size cap and handles empty files', async () => {
      ctx.config = { ...ctx.config, maxReadBytes: 5 };
      await expect(run(readFileTool, { path: 'notes.txt' })).rejects.toThrow(/read cap/);
      ctx.config = { ...ctx.config, maxReadBytes: 1000 };
      await fsp.writeFile(path.join(root, 'empty.txt'), '');
      expect((await run(readFileTool, { path: 'empty.txt' })).content).toContain('empty file');
    });

    test('sensitive files require approval', async () => {
      await expect(run(readFileTool, { path: '.env' })).rejects.toBeInstanceOf(PermissionDeniedError);
      const approving = makeToolContext(ctx.workspace, { gateway: { request: async () => true } });
      expect((await readFileTool.execute({ path: '.env' }, approving)).content).toContain('SECRET=1');
    });

    test('reads from mounted folders', async () => {
      expect((await run(readFileTool, { path: 'knowledge/wiki/http/x.md' })).content).toContain('# X');
    });
  });

  describe('write_file', () => {
    test('creates files with parent directories and returns a diff', async () => {
      const out = await run(writeFileTool, { path: 'reports/r.md', content: '# Report\n' });
      expect(out.content).toMatch(/^Created reports\/r.md/);
      expect(out.content).toContain('+# Report');
      expect(out.changedFiles).toEqual(['reports/r.md']);
      expect(await fsp.readFile(path.join(root, 'reports/r.md'), 'utf8')).toBe('# Report\n');
    });

    test('refuses to overwrite without the flag, without a full read, or into read-only mounts', async () => {
      await expect(run(writeFileTool, { path: 'notes.txt', content: 'x' })).rejects.toThrow(/already exists/);
      await expect(run(writeFileTool, { path: 'notes.txt', content: 'x', overwrite: true })).rejects.toThrow(
        /not been read/,
      );
      await expect(run(writeFileTool, { path: 'knowledge/wiki/new.md', content: 'x' })).rejects.toThrow(
        /read-only/,
      );
      await expect(run(writeFileTool, { path: 'data', content: 'x', overwrite: true })).rejects.toThrow(
        /directory/,
      );
    });

    test('overwrites after a full read and detects external changes', async () => {
      await run(readFileTool, { path: 'notes.txt' });
      await fsp.writeFile(path.join(root, 'notes.txt'), 'edited by someone else');
      await expect(
        run(writeFileTool, { path: 'notes.txt', content: 'mine', overwrite: true }),
      ).rejects.toThrow(/changed on disk/);
      await run(readFileTool, { path: 'notes.txt' });
      const out = await run(writeFileTool, { path: 'notes.txt', content: 'mine', overwrite: true });
      expect(out.content).toMatch(/^Overwrote/);
    });

    test('write permission can require approval', async () => {
      const strict = makeToolContext(ctx.workspace, { policy: { writeRequiresApproval: true } });
      await expect(writeFileTool.execute({ path: 'n.txt', content: 'x' }, strict)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      );
    });

    test('appends post-edit diagnostics for JSON', async () => {
      ctx.config = { ...ctx.config, postEditDiagnostics: true };
      const bad = await run(writeFileTool, { path: 'bad.json', content: '{"a": ' });
      expect(bad.content).toMatch(/post-edit diagnostics: json\] PROBLEMS FOUND/);
      const good = await run(writeFileTool, { path: 'good.json', content: '{"a": 1}' });
      expect(good.content).toMatch(/json\] OK/);
    });
  });

  describe('edit_file', () => {
    test('replaces a unique match after a full read', async () => {
      await run(readFileTool, { path: 'notes.txt' });
      const out = await run(editFileTool, { path: 'notes.txt', old_text: 'two', new_text: 'TWO' });
      expect(out.content).toContain('-two');
      expect(out.content).toContain('+TWO');
      expect(await fsp.readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('one\nTWO\nthree\nfour\n');
      // The write updated file state, so a second edit needs no re-read.
      await run(editFileTool, { path: 'notes.txt', old_text: 'one', new_text: '1' });
    });

    test('ambiguity, replace_all, missing text and no-ops', async () => {
      await run(readFileTool, { path: 'dup.txt' });
      await expect(run(editFileTool, { path: 'dup.txt', old_text: 'x', new_text: 'y' })).rejects.toThrow(
        /appears 2 times/,
      );
      const out = await run(editFileTool, {
        path: 'dup.txt',
        old_text: 'x',
        new_text: 'y',
        replace_all: true,
      });
      expect(out.content).toContain('2 replacements');
      await expect(run(editFileTool, { path: 'dup.txt', old_text: 'zzz', new_text: 'y' })).rejects.toThrow(
        /not found/,
      );
      await expect(run(editFileTool, { path: 'dup.txt', old_text: 'y', new_text: 'y' })).rejects.toThrow(
        /identical/,
      );
      await expect(run(editFileTool, { path: 'missing.txt', old_text: 'a', new_text: 'b' })).rejects.toThrow(
        /does not exist/,
      );
      await expect(run(editFileTool, { path: 'data', old_text: 'a', new_text: 'b' })).rejects.toThrow(
        /directory/,
      );
    });

    test('requires a read first and treats special replacement patterns literally', async () => {
      await expect(run(editFileTool, { path: 'notes.txt', old_text: 'one', new_text: 'x' })).rejects.toThrow(
        /not been read/,
      );
      await run(readFileTool, { path: 'notes.txt' });
      await run(editFileTool, { path: 'notes.txt', old_text: 'one', new_text: '$& $1' });
      expect(await fsp.readFile(path.join(root, 'notes.txt'), 'utf8')).toMatch(/^\$& \$1\n/);
    });
  });

  describe('list, glob and grep', () => {
    test('list_files shows a tree with sizes and hides ignored folders', async () => {
      const out = await run(listFilesTool, { path: '.', recursive: true });
      expect(out.content).toContain('data/');
      expect(out.content).toContain('  sales.csv (');
      expect(out.content).not.toContain('node_modules');
      expect((await run(listFilesTool, { max_entries: 2 })).content).toContain('truncated at 2');
      await expect(run(listFilesTool, { path: 'notes.txt' })).rejects.toThrow(/not a directory/);
      await expect(run(listFilesTool, { path: 'nope' })).rejects.toThrow(/not found/);
    });

    test('glob_files matches patterns relative to the search path', async () => {
      expect((await run(globFilesTool, { pattern: '**/*.json' })).content).toContain('data/nested/deep.json');
      expect((await run(globFilesTool, { pattern: '*.csv', path: 'data' })).content).toContain(
        'data/sales.csv',
      );
      expect((await run(globFilesTool, { pattern: '**/*.parquet' })).content).toMatch(/No files match/);
      await expect(run(globFilesTool, { pattern: '*', path: 'notes.txt' })).rejects.toThrow(
        /not a directory/,
      );
    });

    test('grep_text finds regex matches with include filters and case options', async () => {
      expect((await run(grepTextTool, { query: 'north|south' })).content).toMatch(
        /data\/sales.csv:2:north,10/,
      );
      expect((await run(grepTextTool, { query: 'NORTH', case_sensitive: false })).content).toContain('north');
      expect((await run(grepTextTool, { query: '(?i)NORTH' })).content).toContain('north');
      expect((await run(grepTextTool, { query: 'one', include: '*.csv' })).content).toMatch(/No matches/);
      expect((await run(grepTextTool, { query: 'three', path: 'notes.txt' })).content).toContain(
        'notes.txt:3:three',
      );
      await expect(run(grepTextTool, { query: '(' })).rejects.toThrow(/Invalid regular expression/);
      expect((await run(grepTextTool, { query: 'x', max_matches: 1 })).content).toContain('limit reached');
    });
  });
});
