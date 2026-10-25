import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { PostEditDiagnostics, runCommand, type CommandRunner } from '../../src/diagnostics/post-edit';
import { tmpDir } from '../helpers';

describe('post-edit diagnostics', () => {
  test('JSON and YAML are checked in-process', async () => {
    const d = new PostEditDiagnostics();
    expect(await d.check('/x/a.json', '{"a": 1}')).toEqual({ tool: 'json', ok: true, output: 'valid JSON' });
    expect((await d.check('/x/a.json', '{oops'))!.ok).toBe(false);
    expect(await d.check('/x/a.yml', 'a: 1')).toEqual({ tool: 'yaml', ok: true, output: 'valid YAML' });
    expect((await d.check('/x/a.yaml', 'a: [1'))!.ok).toBe(false);
    expect(await d.check('/x/notes.md', '# hi')).toBeNull();
  });

  test('Python uses ruff when present and falls back to a syntax check', async () => {
    const calls: string[] = [];
    const noRuff: CommandRunner = async (cmd) => {
      calls.push(cmd);
      return cmd === 'ruff'
        ? { code: null, output: 'not found' }
        : { code: 1, output: 'SyntaxError: invalid syntax' };
    };
    const res = await new PostEditDiagnostics(noRuff).check('/x/a.py', 'def (:');
    expect(calls).toEqual(['ruff', 'python3']);
    expect(res).toEqual({ tool: 'python-syntax', ok: false, output: 'SyntaxError: invalid syntax' });
    const withRuff: CommandRunner = async () => ({ code: 0, output: '' });
    expect(await new PostEditDiagnostics(withRuff).check('/x/a.py', 'x = 1')).toEqual({
      tool: 'ruff',
      ok: true,
      output: 'no issues',
    });
    const nothing: CommandRunner = async () => ({ code: null, output: '' });
    expect(await new PostEditDiagnostics(nothing).check('/x/a.py', 'x')).toBeNull();
    expect(await new PostEditDiagnostics(nothing).check('/x/a.js', 'x')).toBeNull();
  });

  test('real syntax checks for Python and JavaScript files', async () => {
    const dir = await tmpDir();
    const goodPy = path.join(dir, 'good.py');
    const badJs = path.join(dir, 'bad.js');
    await fsp.writeFile(goodPy, 'x = 1\n');
    await fsp.writeFile(badJs, 'function (\n');
    const d = new PostEditDiagnostics();
    const py = await d.check(goodPy, 'x = 1\n');
    expect(py?.ok).toBe(true);
    const js = await d.check(badJs, 'function (\n');
    expect(js).toMatchObject({ tool: 'node --check', ok: false });
    expect(PostEditDiagnostics.format(js)).toMatch(/\[post-edit diagnostics: node --check\] PROBLEMS FOUND/);
    expect(PostEditDiagnostics.format(null)).toBe('');
  });

  test('runCommand reports missing binaries and kills slow commands', async () => {
    expect((await runCommand('definitely-not-a-binary-xyz', [], process.cwd(), 1000)).code).toBeNull();
    const slow = await runCommand('sleep', ['5'], process.cwd(), 100);
    expect(slow.code).not.toBe(0);
  });
});
