import { promises as fsp } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {
  daemonFiles,
  daemonStatus,
  isAlive,
  sessionContext,
  startDaemon,
  stopDaemon,
  tailLog,
  type DaemonOptions,
} from '../../src/app/daemon';
import { loadDotEnv, parseDotEnv } from '../../src/config/dotenv';
import { tmpDir } from '../helpers';

/** A stand-in for dist/index.js: answers /healthz on PORT and HOST like the real server. */
const FAKE_HARNESS = `const http = require('http');
console.log('fake harness starting on ' + process.env.PORT + ' with root ' + process.env.HARNESS_ROOT);
http.createServer((req, res) => { res.writeHead(req.url === '/healthz' ? 200 : 404); res.end('{"ok":true}'); })
  .listen(Number(process.env.PORT), process.env.HOST);
process.on('SIGTERM', () => process.exit(0));
`;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function setup(script = FAKE_HARNESS): Promise<DaemonOptions> {
  const root = await tmpDir('harness-daemon-');
  const entry = path.join(root, 'fake-harness.js');
  await fsp.writeFile(entry, script);
  return {
    root,
    dataDir: path.join(root, 'data'),
    port: await freePort(),
    host: '127.0.0.1',
    command: [process.execPath, entry],
    startTimeoutMs: 8_000,
  };
}

const started: DaemonOptions[] = [];
afterEach(async () => {
  for (const o of started.splice(0)) await stopDaemon(o).catch(() => undefined);
});

describe('harness daemon', () => {
  test('starts once, reports status, and stops', async () => {
    const opts = await setup();
    started.push(opts);
    expect(await daemonStatus(opts)).toMatchObject({ running: false, managed: false });
    // Several sessions starting at once still get one process.
    const results = await Promise.all([startDaemon(opts), startDaemon(opts), startDaemon(opts)]);
    const pids = new Set(results.map((r) => r.pid).filter(Boolean));
    expect(pids.size).toBe(1);
    const status = await daemonStatus(opts);
    expect(status).toMatchObject({ running: true, managed: true, url: `http://127.0.0.1:${opts.port}` });
    expect(isAlive(status.pid!)).toBe(true);
    expect((await startDaemon(opts)).pid).toBe(status.pid);
    const log = await tailLog(opts.dataDir);
    expect(log).toContain(`fake harness starting on ${opts.port} with root ${opts.root}`);
    await expect(fsp.stat(daemonFiles(opts.dataDir).lock)).rejects.toThrow();

    expect(await stopDaemon(opts)).toBe(true);
    expect(isAlive(status.pid!)).toBe(false);
    expect(await daemonStatus(opts)).toMatchObject({ running: false });
    expect(await stopDaemon(opts)).toBe(false);
  });

  test('start restarts a harness it started from an older build', async () => {
    const opts = await setup();
    started.push(opts);
    const first = await startDaemon(opts);
    expect((await startDaemon(opts)).pid).toBe(first.pid);
    // A rebuild (npm run build, the installer or the session hook) replaces the entry file.
    const later = new Date(Date.now() + 5_000);
    await fsp.utimes(opts.command![1]!, later, later);
    const second = await startDaemon(opts);
    expect(second).toMatchObject({ running: true, managed: true });
    expect(second.pid).not.toBe(first.pid);
    expect(isAlive(first.pid!)).toBe(false);
    expect((await startDaemon(opts)).pid).toBe(second.pid);
  });

  test('a harness already answering on the port is left alone', async () => {
    const opts = await setup();
    const server = http.createServer((_req, res) => res.end('{"ok":true}'));
    await new Promise<void>((r) => server.listen(opts.port, '127.0.0.1', () => r()));
    try {
      const status = await startDaemon(opts);
      expect(status).toMatchObject({ running: true, managed: false, pid: undefined });
      await expect(fsp.stat(daemonFiles(opts.dataDir).state)).rejects.toThrow();
      expect(await stopDaemon(opts)).toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  test('a harness that fails to come up is reported with its log', async () => {
    const opts = await setup("console.error('boom: missing ANTHROPIC_API_KEY'); process.exit(1);");
    await expect(startDaemon(opts)).rejects.toThrow(
      /did not come up on port \d+\. Last log lines:\nboom: missing/,
    );
    await expect(fsp.stat(daemonFiles(opts.dataDir).state)).rejects.toThrow();
    await expect(fsp.stat(daemonFiles(opts.dataDir).lock)).rejects.toThrow();
    const unbuilt = { ...(await setup()), command: undefined };
    await expect(startDaemon(unbuilt)).rejects.toThrow('the harness is not built yet: run `npm run build`');
  });

  test('stale state, stale locks and big logs are cleaned up', async () => {
    const opts = await setup();
    started.push(opts);
    const files = daemonFiles(opts.dataDir);
    await fsp.mkdir(path.dirname(files.state), { recursive: true });
    await fsp.mkdir(path.dirname(files.log), { recursive: true });
    // A pid that does not exist, a lock left by a crash, and an oversized log.
    await fsp.writeFile(
      files.state,
      JSON.stringify({ pid: 2 ** 22 + 7, port: opts.port, host: '127.0.0.1' }),
    );
    expect(await stopDaemon(opts)).toBe(false);
    await expect(fsp.stat(files.state)).rejects.toThrow();
    await fsp.writeFile(files.lock, '');
    const old = new Date(Date.now() - 60_000);
    await fsp.utimes(files.lock, old, old);
    await fsp.writeFile(files.log, 'x'.repeat(10 * 1024 * 1024 + 1));
    expect((await startDaemon(opts)).managed).toBe(true);
    expect((await fsp.stat(`${files.log}.1`)).size).toBeGreaterThan(10 * 1024 * 1024);
    expect((await fsp.stat(files.log)).size).toBeLessThan(1024);
  });

  test('a stale state file never makes stop kill an unrelated process', async () => {
    const opts = await setup();
    const files = daemonFiles(opts.dataDir);
    await fsp.mkdir(path.dirname(files.state), { recursive: true });
    // Our own pid is alive but is not the harness and does not answer on the port.
    await fsp.writeFile(
      files.state,
      JSON.stringify({ pid: process.pid, port: opts.port, host: '127.0.0.1' }),
    );
    expect(await stopDaemon(opts)).toBe(false);
    await expect(fsp.stat(files.state)).rejects.toThrow();
  });

  test('stop keeps the state of a harness another session started meanwhile', async () => {
    const slowExit = FAKE_HARNESS.replace('process.exit(0)', 'setTimeout(() => process.exit(0), 400)');
    const opts = await setup(slowExit);
    started.push(opts);
    await startDaemon(opts);
    const files = daemonFiles(opts.dataDir);
    const stopping = stopDaemon(opts);
    await new Promise((r) => setTimeout(r, 100));
    // While the old harness shuts down, a session that found the port free starts a new one.
    const newer = { pid: process.pid, port: opts.port, host: '127.0.0.1', root: opts.root, startedAt: 'x' };
    await fsp.writeFile(files.state, JSON.stringify(newer));
    expect(await stopping).toBe(true);
    expect(JSON.parse(await fsp.readFile(files.state, 'utf8'))).toEqual(newer);
    await fsp.rm(files.state);
  });

  test('the session note says what runs and how to use it, or what went wrong', () => {
    const where = { root: '/opt/analyst-harness', dataDir: '/opt/analyst-harness/data' };
    const running = sessionContext(
      {
        running: true,
        managed: true,
        pid: 42,
        port: 8080,
        url: 'http://127.0.0.1:8080',
        startedAt: '2026-10-25T08:00:00.000Z',
        logFile: '/x.log',
      },
      where,
    );
    expect(running).toContain(
      'analyst-harness is running in the background (pid 42, since 2026-10-25 08:00 UTC)',
    );
    expect(running).toContain('dashboards at http://127.0.0.1:8080/dashboards/');
    expect(running).toContain('datasets land in /opt/analyst-harness/data/datasets');
    const down = sessionContext(
      { running: false, managed: false, port: 8080, url: 'http://127.0.0.1:8080', logFile: '/x.log' },
      where,
      'port 8080 is already in use',
    );
    expect(down).toBe(
      'analyst-harness is installed at /opt/analyst-harness but is not running: port 8080 is already in use\nStart it with `harness daemon start` and read `harness daemon logs` if it fails.',
    );
  });
});

describe('.env files', () => {
  test('parse KEY=value lines with quotes, export and comments', () => {
    expect(
      parseDotEnv(
        '# comment\nA=1\nexport B="two words"\nC=\'x # y\'\nD=plain # note\nE=\nF="a\\nb"\r\nnot a pair\n  G = spaced  \n',
      ),
    ).toEqual({ A: '1', B: 'two words', C: 'x # y', D: 'plain', E: '', F: 'a\nb', G: 'spaced' });
  });

  test('load into the environment without overriding it, unless turned off', async () => {
    const root = await tmpDir('harness-env-');
    await fsp.writeFile(path.join(root, '.env'), 'ANTHROPIC_API_KEY=from-file\nPORT=9000\n');
    await fsp.writeFile(path.join(root, 'other.env'), 'PORT=9100\n');
    const env: NodeJS.ProcessEnv = { PORT: '8080' };
    expect(loadDotEnv(root, env)).toEqual(['ANTHROPIC_API_KEY']);
    expect(env).toEqual({ PORT: '8080', ANTHROPIC_API_KEY: 'from-file' });
    const custom: NodeJS.ProcessEnv = { HARNESS_ENV_FILE: 'other.env' };
    expect(loadDotEnv(root, custom)).toEqual(['PORT']);
    expect(custom.PORT).toBe('9100');
    expect(loadDotEnv(root, { HARNESS_ENV_FILE: 'none' })).toEqual([]);
    expect(loadDotEnv(path.join(root, 'missing'), {})).toEqual([]);
  });
});
