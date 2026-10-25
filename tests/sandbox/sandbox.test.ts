import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { sandboxExec } from '../../src/sandbox/client';
import { createSandboxServer, listenSandbox, parseMounts, resolveCwd } from '../../src/sandbox/server';
import { Workspace } from '../../src/safety/workspace';
import { bashTool } from '../../src/tools/bash-tool';
import { makeToolContext, tmpDir } from '../helpers';

async function startSandbox() {
  const root = await tmpDir('harness-sbx-');
  const ws = path.join(root, 'ws');
  const ds = path.join(root, 'ds');
  await fsp.mkdir(path.join(ws, 'reports'), { recursive: true });
  await fsp.mkdir(path.join(ds, 'items'), { recursive: true });
  await fsp.writeFile(path.join(ds, 'items', 'a.jsonl'), '{"id":1}\n{"id":2}\n');
  const socketPath = path.join(root, 's', 'exec.sock');
  const server = createSandboxServer({
    socketPath,
    mounts: { '': ws, datasets: ds },
    baseEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/tmp' },
  });
  await listenSandbox(server, socketPath);
  return { root, ws, ds, socketPath, close: () => new Promise((r) => server.close(r)) };
}

describe('sandbox', () => {
  test('mounts parse and working directories stay inside them', async () => {
    expect(parseMounts('=/workspace, datasets=/workspace/datasets')).toEqual({
      '': '/workspace',
      datasets: '/workspace/datasets',
    });
    expect(() => parseMounts('nonsense')).toThrow('is not alias=directory');
    const root = await tmpDir('harness-sbx-cwd-');
    await fsp.mkdir(path.join(root, 'ws', 'sub'), { recursive: true });
    await fsp.symlink('/etc', path.join(root, 'ws', 'escape'));
    const mounts = { '': path.join(root, 'ws') };
    expect(resolveCwd(mounts, '', 'sub')).toBe(path.join(root, 'ws', 'sub'));
    expect(resolveCwd(mounts, '', '../..')).toEqual({ error: 'cwd ../.. leaves the mount' });
    expect(resolveCwd(mounts, '', '/etc')).toEqual({ error: 'cwd must be relative to the mount' });
    expect(resolveCwd(mounts, '', 'escape')).toEqual({
      error: 'cwd escape leaves the mount through a symlink',
    });
    expect(resolveCwd(mounts, '', 'missing')).toEqual({ error: 'cwd missing does not exist' });
    expect(resolveCwd(mounts, 'knowledge', '.')).toEqual({ error: 'the sandbox has no "knowledge" mount' });
  });

  test('runs commands in the requested mount with only the environment it is given', async () => {
    const sbx = await startSandbox();
    try {
      const res = await sandboxExec(sbx.socketPath, {
        v: 1,
        command: 'pwd; echo "$GREETING"; echo "${SECRET:-no secret}"; wc -l < items/a.jsonl',
        mount: 'datasets',
        timeoutMs: 10_000,
        env: { GREETING: 'hello' },
      });
      expect(res.exitCode).toBe(0);
      expect(res.stdout.split('\n').slice(0, 4)).toEqual([
        await fsp.realpath(sbx.ds),
        'hello',
        'no secret',
        '2',
      ]);
      const fail = await sandboxExec(sbx.socketPath, {
        v: 1,
        command: 'echo oops >&2; exit 3',
        timeoutMs: 5_000,
      });
      expect(fail).toMatchObject({ exitCode: 3, stderr: 'oops\n', timedOut: false });
      const slow = await sandboxExec(sbx.socketPath, { v: 1, command: 'sleep 5', timeoutMs: 1_000 });
      expect(slow.timedOut).toBe(true);
      await expect(
        sandboxExec(sbx.socketPath, { v: 1, command: 'ls', mount: 'knowledge', timeoutMs: 5_000 }),
      ).rejects.toThrow('The sandbox refused the command: the sandbox has no "knowledge" mount');
      await expect(
        sandboxExec(sbx.socketPath, { v: 1, command: 'ls', cwd: '../ds', timeoutMs: 5_000 }),
      ).rejects.toThrow('leaves the mount');
    } finally {
      await sbx.close();
    }
  });

  test('aborting the request kills the command', async () => {
    const sbx = await startSandbox();
    try {
      const marker = path.join(sbx.ws, 'finished');
      const controller = new AbortController();
      const started = Date.now();
      const run = sandboxExec(
        sbx.socketPath,
        { v: 1, command: `sleep 2 && touch ${marker}`, timeoutMs: 10_000 },
        controller.signal,
      );
      setTimeout(() => controller.abort(), 200);
      expect(await run).toMatchObject({ exitCode: null, stderr: 'aborted' });
      expect(Date.now() - started).toBeLessThan(1500);
      await new Promise((r) => setTimeout(r, 2500));
      await expect(fsp.stat(marker)).rejects.toThrow();
    } finally {
      await sbx.close();
    }
  });

  test('malformed requests get an error answer, a missing sandbox a clear tool error', async () => {
    const sbx = await startSandbox();
    try {
      const answer = await new Promise<string>((resolve) => {
        const s = net.createConnection(sbx.socketPath, () => s.write('{"v":2}\n'));
        let buf = '';
        s.on('data', (d) => (buf += d.toString()));
        s.on('end', () => resolve(buf));
      });
      expect(JSON.parse(answer)).toMatchObject({
        ok: false,
        error: expect.stringContaining('invalid request'),
      });
    } finally {
      await sbx.close();
    }
    await expect(
      sandboxExec(path.join(sbx.root, 'nope.sock'), { v: 1, command: 'ls', timeoutMs: 5_000 }),
    ).rejects.toThrow(/The command sandbox is unavailable \(ENOENT\)/);
  });

  test('the bash tool runs in the sandbox when a socket is configured', async () => {
    const sbx = await startSandbox();
    try {
      const workspace = new Workspace([
        { alias: '', dir: sbx.ws, mode: 'rw' },
        { alias: 'datasets', dir: sbx.ds, mode: 'ro' },
      ]);
      const ctx = makeToolContext(workspace, { policy: { mode: 'trusted' } });
      ctx.config = { ...ctx.config, sandboxSocket: sbx.socketPath, bashPassEnv: ['PASSED'] };
      ctx.env = { ...ctx.env, PASSED: 'yes' };
      const out = await bashTool.execute(
        {
          command: 'echo "${SECRET_TOKEN:-scrubbed} ${ANTHROPIC_API_KEY:-scrubbed} $PASSED"; ls',
          cwd: 'datasets',
        },
        ctx,
      );
      expect(out.content).toContain('exit_code: 0');
      expect(out.content).toContain('scrubbed scrubbed yes');
      expect(out.content).toContain('items');
      const denied = await bashTool
        .execute({ command: 'sudo ls' }, { ...ctx, permissions: makeToolContext(workspace).permissions })
        .catch((e: Error) => e.message);
      expect(denied).toMatch(/Permission denied by policy/);
    } finally {
      await sbx.close();
    }
  });
});
