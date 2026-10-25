import { spawnSync } from 'node:child_process';
import { constants, promises as fsp } from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers';

const ROOT = path.resolve(__dirname, '../..');
const HOOK = path.join(ROOT, 'scripts', 'claude-hook.js');
const SESSION_START = path.join(ROOT, 'scripts', 'claude-session-start.js');

/** Run one of the install scripts against a private Claude Code config directory. */
function run(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const res = spawnSync(process.execPath, [script, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { code: res.status, out: res.stdout.trim(), err: res.stderr.trim() };
}

type Group = { hooks: { command: string; timeout?: number }[] };
const sessionStart = async (file: string): Promise<Group[]> =>
  JSON.parse(await fsp.readFile(file, 'utf8')).hooks.SessionStart;
const ours = (g: Group) => g.hooks.some((h) => h.command.includes('claude-session-start.js'));

describe('Claude Code hook installer', () => {
  test('install keeps other settings, never doubles up, and uninstall removes only ours', async () => {
    const dir = await tmpDir('harness-claudecfg-');
    const file = path.join(dir, 'settings.json');
    const other = { hooks: [{ type: 'command', command: 'echo other' }] };
    const settings = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: { SessionStart: [other], PreToolUse: [{ matcher: 'Bash', hooks: [] }] },
    };
    await fsp.writeFile(file, JSON.stringify(settings));
    const env = { CLAUDE_CONFIG_DIR: dir };

    expect(run(HOOK, ['status'], env).code).toBe(3);
    expect(run(HOOK, ['install'], env)).toMatchObject({ code: 0, out: expect.stringContaining(file) });
    expect(run(HOOK, ['install'], env).code).toBe(0);
    const groups = await sessionStart(file);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toEqual(other);
    expect(groups[1]!.hooks).toEqual([
      { type: 'command', command: `"${process.execPath}" "${SESSION_START}"`, timeout: 600 },
    ]);
    const after = JSON.parse(await fsp.readFile(file, 'utf8'));
    expect(after.permissions).toEqual(settings.permissions);
    expect(after.hooks.PreToolUse).toEqual(settings.hooks.PreToolUse);
    expect(JSON.parse(await fsp.readFile(`${file}.bak`, 'utf8')).hooks.SessionStart).toHaveLength(2);
    expect(run(HOOK, ['status'], env)).toMatchObject({ code: 0, out: `installed: ${file}` });

    expect(run(HOOK, ['uninstall'], env).out).toContain('Removed the analyst-harness hook');
    expect(await sessionStart(file)).toEqual([other]);
    expect(run(HOOK, ['uninstall'], env).out).toContain('No analyst-harness hook');
    expect(run(HOOK, ['status'], env).code).toBe(3);
  });

  test('a missing settings file is created, and emptied hooks are removed again', async () => {
    const dir = path.join(await tmpDir('harness-claudecfg-'), 'nested');
    const file = path.join(dir, 'settings.json');
    expect(run(HOOK, ['install'], { CLAUDE_CONFIG_DIR: dir }).code).toBe(0);
    expect((await sessionStart(file)).filter(ours)).toHaveLength(1);
    expect(run(HOOK, ['uninstall'], { CLAUDE_CONFIG_DIR: dir }).code).toBe(0);
    expect(JSON.parse(await fsp.readFile(file, 'utf8'))).toEqual({});
  });

  test('a settings file that is not JSON is left untouched', async () => {
    const dir = await tmpDir('harness-claudecfg-');
    const file = path.join(dir, 'settings.json');
    await fsp.writeFile(file, '{bad');
    const res = run(HOOK, ['install'], { CLAUDE_CONFIG_DIR: dir });
    expect(res).toMatchObject({
      code: 1,
      err: `${file} is not a JSON object; fix it by hand, then run this again`,
    });
    expect(await fsp.readFile(file, 'utf8')).toBe('{bad');
    expect(run(HOOK, ['nope'], { CLAUDE_CONFIG_DIR: dir }).code).toBe(2);
  });

  test('the project hook runs the session script, which HARNESS_AUTOSTART=0 silences', async () => {
    const settings = JSON.parse(await fsp.readFile(path.join(ROOT, '.claude', 'settings.json'), 'utf8'));
    const command: string = settings.hooks.SessionStart[0].hooks[0].command;
    expect(command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/session-start.sh');
    const script = path.join(ROOT, '.claude', 'hooks', 'session-start.sh');
    await fsp.access(script, constants.X_OK);
    expect(await fsp.readFile(script, 'utf8')).toContain('scripts/claude-session-start.js');
    await fsp.access(path.join(ROOT, 'bin', 'harness'), constants.X_OK);
    expect(run(SESSION_START, [], { HARNESS_AUTOSTART: '0' })).toEqual({ code: 0, out: '', err: '' });
  });
});
