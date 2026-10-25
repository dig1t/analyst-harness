import { realpathSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import { Semaphore } from '../util/concurrency';
import { ExecRequestSchema, MAX_REQUEST_BYTES, type ExecResponse } from './protocol';
import { runShell } from './shell';

export interface SandboxServerOptions {
  socketPath: string;
  /** Workspace alias to directory in this container: { '': '/workspace', datasets: '/workspace/datasets' }. */
  mounts: Record<string, string>;
  /** Commands that run at once; more wait their turn. */
  maxConcurrent?: number;
  /** The base environment of every command (PATH, HOME, LANG); requests add to it. */
  baseEnv?: Record<string, string>;
  logger?: Logger;
}

/** `=/workspace,datasets=/workspace/datasets` to a mount map. */
export function parseMounts(spec: string): Record<string, string> {
  const mounts: Record<string, string> = {};
  for (const part of spec
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`mount "${part}" is not alias=directory`);
    mounts[part.slice(0, eq)] = path.resolve(part.slice(eq + 1));
  }
  return mounts;
}

/** The directory a request may run in, or an error message. Symlinks may not leave the mount. */
export function resolveCwd(
  mounts: Record<string, string>,
  mount: string,
  cwd: string,
): string | { error: string } {
  const root = mounts[mount];
  if (!root) return { error: `the sandbox has no "${mount || 'workspace'}" mount` };
  if (path.isAbsolute(cwd)) return { error: 'cwd must be relative to the mount' };
  const abs = path.resolve(root, cwd);
  const inside = (p: string, r: string) => p === r || p.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
  if (!inside(abs, root)) return { error: `cwd ${cwd} leaves the mount` };
  try {
    if (!inside(realpathSync(abs), realpathSync(root)))
      return { error: `cwd ${cwd} leaves the mount through a symlink` };
  } catch {
    return { error: `cwd ${cwd} does not exist` };
  }
  return abs;
}

/**
 * The sandbox side: runs shell commands for the harness inside a container that has no
 * network, no secrets and only the workspace (plus read-only data) mounted. The harness keeps
 * deciding what may run; this process only executes and reports.
 */
export function createSandboxServer(opts: SandboxServerOptions): net.Server {
  const logger = opts.logger ?? silentLogger;
  const slots = new Semaphore(Math.max(1, opts.maxConcurrent ?? 4));
  const baseEnv = opts.baseEnv ?? {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: '/tmp',
    LANG: 'C.UTF-8',
  };
  return net.createServer((socket) => {
    let buffer = '';
    let started = false;
    const controller = new AbortController();
    const reply = (r: ExecResponse) => {
      if (!socket.destroyed) socket.end(JSON.stringify(r) + '\n');
    };
    socket.on('close', () => controller.abort());
    socket.on('error', () => controller.abort());
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (started) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        started = true;
        reply({ ok: false, error: 'request too large' });
        return;
      }
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      started = true;
      void handle(buffer.slice(0, nl)).then(reply, (err: unknown) =>
        reply({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    });

    async function handle(line: string): Promise<ExecResponse> {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        return { ok: false, error: 'request is not JSON' };
      }
      const parsed = ExecRequestSchema.safeParse(raw);
      if (!parsed.success)
        return {
          ok: false,
          error: `invalid request: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        };
      const req = parsed.data;
      const cwd = resolveCwd(opts.mounts, req.mount, req.cwd);
      if (typeof cwd !== 'string') return { ok: false, error: cwd.error };
      const st = await fsp.stat(cwd).catch(() => null);
      if (!st?.isDirectory()) return { ok: false, error: `cwd ${req.cwd} is not a directory` };
      return slots.run(async () => {
        if (controller.signal.aborted) return { ok: false, error: 'cancelled' };
        const t0 = Date.now();
        const res = await runShell(
          req.command,
          cwd,
          { ...baseEnv, ...req.env },
          req.timeoutMs,
          controller.signal,
        );
        logger.info('sandbox command', {
          exitCode: res.exitCode,
          timedOut: res.timedOut,
          ms: Date.now() - t0,
        });
        return { ok: true, ...res, durationMs: Date.now() - t0 };
      });
    }
  });
}

/** Listen on the socket path, replacing a stale socket file; only this user may connect. */
export async function listenSandbox(server: net.Server, socketPath: string): Promise<void> {
  await fsp.mkdir(path.dirname(socketPath), { recursive: true });
  await fsp.rm(socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await fsp.chmod(socketPath, 0o660);
}
