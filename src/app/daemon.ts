import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, promises as fsp, statSync } from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeTextAtomic } from '../util/fs';

export interface DaemonOptions {
  /** The harness checkout or install: config, dist/ and .env live here. */
  root: string;
  /** Where the state file and logs go (the harness data directory). */
  dataDir: string;
  port: number;
  /** Interface to listen on; the daemon defaults to loopback so dashboards stay private. */
  host: string;
  /** What runs the harness (default: this Node binary with <root>/dist/index.js). */
  command?: string[];
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  /** How long to wait for /healthz after starting (default 20 s). */
  startTimeoutMs?: number;
  now?: () => number;
}

interface DaemonState {
  pid: number;
  port: number;
  host: string;
  root: string;
  startedAt: string;
  /** Modification time of the entry file it was started from, to notice a newer build. */
  build?: number;
}

export interface DaemonStatus {
  running: boolean;
  /** Started by this manager (we know its pid), as opposed to found answering on the port. */
  managed: boolean;
  pid?: number;
  port: number;
  url: string;
  startedAt?: string;
  logFile: string;
}

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export function daemonFiles(dataDir: string): { state: string; lock: string; log: string } {
  return {
    state: path.join(dataDir, 'state', 'daemon.json'),
    lock: path.join(dataDir, 'state', 'daemon.lock'),
    log: path.join(dataDir, 'logs', 'harness.log'),
  };
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const commandOf = (opts: DaemonOptions): string[] =>
  opts.command ?? [process.execPath, path.join(opts.root, 'dist', 'index.js')];

const mtimeOf = (file: string): number => statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;

function baseUrl(opts: Pick<DaemonOptions, 'host' | 'port'>): string {
  const host = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${opts.port}`;
}

async function healthy(opts: DaemonOptions): Promise<boolean> {
  try {
    const res = await (opts.fetch ?? fetch)(`${baseUrl(opts)}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Is a harness answering on the port, and did we start it? */
export async function daemonStatus(opts: DaemonOptions): Promise<DaemonStatus> {
  const files = daemonFiles(opts.dataDir);
  const state = await readJson<DaemonState | null>(files.state, null);
  const alive = !!state && isAlive(state.pid);
  const answering = await healthy(opts);
  return {
    running: answering,
    managed: alive && answering,
    pid: alive ? state!.pid : undefined,
    port: opts.port,
    url: baseUrl(opts),
    startedAt: alive ? state!.startedAt : undefined,
    logFile: files.log,
  };
}

/** The last `lines` lines of the log. */
export async function tailLog(dataDir: string, lines = 40): Promise<string> {
  const text = await fsp.readFile(daemonFiles(dataDir).log, 'utf8').catch(() => '');
  return text
    .split('\n')
    .slice(-lines - 1)
    .join('\n')
    .trim();
}

async function waitForHealth(
  opts: DaemonOptions,
  pid: number | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const until = (opts.now ?? Date.now)() + timeoutMs;
  while ((opts.now ?? Date.now)() < until) {
    if (await healthy(opts)) return true;
    if (pid !== undefined && !isAlive(pid)) return false;
    await sleep(250);
  }
  return healthy(opts);
}

/** Started by this manager from a build that has been replaced since (or by an older manager). */
async function outdated(opts: DaemonOptions, status: DaemonStatus): Promise<boolean> {
  if (!status.managed) return false;
  const state = await readJson<DaemonState | null>(daemonFiles(opts.dataDir).state, null);
  return state?.build !== mtimeOf(commandOf(opts).at(-1)!);
}

/**
 * Start the harness in the background unless one already answers on the port, and restart one
 * this manager started from an older build. Safe to call from many sessions at once: a lock
 * file lets one of them start it while the others wait.
 */
export async function startDaemon(opts: DaemonOptions): Promise<DaemonStatus> {
  const timeout = opts.startTimeoutMs ?? 20_000;
  const current = await daemonStatus(opts);
  if (current.running && !(await outdated(opts, current))) return current;
  const files = daemonFiles(opts.dataDir);
  await ensureDir(path.dirname(files.lock));
  let lock: number | undefined;
  try {
    lock = openSync(files.lock, 'wx');
  } catch {
    // Someone else is starting it; a lock older than the start timeout is left over from a crash.
    const age = Date.now() - (statSync(files.lock, { throwIfNoEntry: false })?.mtimeMs ?? 0);
    if (age < timeout + 5_000) {
      await waitForHealth(opts, undefined, timeout);
      return daemonStatus(opts);
    }
    await fsp.rm(files.lock, { force: true });
    lock = openSync(files.lock, 'wx');
  }
  try {
    // Check again under the lock: another session may have started or restarted it meanwhile.
    const now = await daemonStatus(opts);
    if (now.running) {
      if (!(await outdated(opts, now))) return now;
      await stopDaemon(opts);
    }
    const command = commandOf(opts);
    if (!opts.command && !existsSync(command[1]!))
      throw new Error(`the harness is not built yet: run \`npm run build\` in ${opts.root}`);
    await ensureDir(path.dirname(files.log));
    const size = statSync(files.log, { throwIfNoEntry: false })?.size ?? 0;
    if (size > MAX_LOG_BYTES) await fsp.rename(files.log, `${files.log}.1`);
    const out = openSync(files.log, 'a');
    let pid: number | undefined;
    try {
      const child = spawn(command[0]!, command.slice(1), {
        cwd: opts.root,
        env: {
          ...(opts.env ?? process.env),
          HARNESS_ROOT: opts.root,
          PORT: String(opts.port),
          HOST: opts.host,
        },
        detached: true,
        stdio: ['ignore', out, out],
      });
      child.unref();
      pid = child.pid;
    } finally {
      closeSync(out);
    }
    if (!pid) throw new Error('the harness process did not start');
    const state: DaemonState = {
      pid,
      port: opts.port,
      host: opts.host,
      root: opts.root,
      startedAt: new Date((opts.now ?? Date.now)()).toISOString(),
      build: mtimeOf(command.at(-1)!),
    };
    await writeTextAtomic(files.state, JSON.stringify(state, null, 2));
    if (!(await waitForHealth(opts, pid, timeout))) {
      const tail = await tailLog(opts.dataDir, 15);
      if (isAlive(pid)) process.kill(pid, 'SIGTERM');
      await forget(files.state, pid);
      throw new Error(
        `the harness did not come up on port ${opts.port}.${tail ? ` Last log lines:\n${tail}` : ''}`,
      );
    }
    return daemonStatus(opts);
  } finally {
    if (lock !== undefined) closeSync(lock);
    await fsp.rm(files.lock, { force: true });
  }
}

/**
 * Whether `pid` is still the harness we started. A stale state file can point at a reused
 * pid; where /proc exists we check the command line, elsewhere the port must answer.
 */
async function isOurs(pid: number, opts: DaemonOptions): Promise<boolean> {
  const entry = commandOf(opts).at(-1)!;
  const cmdline = await fsp.readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null);
  if (cmdline !== null) return cmdline.split('\0').includes(entry);
  return healthy(opts);
}

/** Remove the state file, unless another start has meanwhile replaced it with a new pid. */
async function forget(file: string, pid: number | undefined): Promise<void> {
  const current = await readJson<DaemonState | null>(file, null);
  if (!current || current.pid === pid) await fsp.rm(file, { force: true });
}

/** Stop the harness this manager started. Returns false when none was running. */
export async function stopDaemon(opts: DaemonOptions, waitMs = 10_000): Promise<boolean> {
  const files = daemonFiles(opts.dataDir);
  const state = await readJson<DaemonState | null>(files.state, null);
  if (!state || !isAlive(state.pid) || !(await isOurs(state.pid, opts))) {
    await forget(files.state, state?.pid);
    return false;
  }
  process.kill(state.pid, 'SIGTERM');
  const until = Date.now() + waitMs;
  while (Date.now() < until && isAlive(state.pid)) await sleep(100);
  if (isAlive(state.pid)) process.kill(state.pid, 'SIGKILL');
  await forget(files.state, state.pid);
  return true;
}

/** The note a Claude Code session gets at start: what is running and how to use it. */
export function sessionContext(
  status: DaemonStatus,
  where: { root: string; dataDir: string },
  problem?: string,
): string {
  const { root, dataDir } = where;
  const cli = 'harness';
  if (!status.running)
    return [
      `analyst-harness is installed at ${root} but is not running${problem ? `: ${problem}` : '.'}`,
      `Start it with \`${cli} daemon start\` and read \`${cli} daemon logs\` if it fails.`,
    ].join('\n');
  const since = status.startedAt ? `, since ${status.startedAt.slice(0, 16).replace('T', ' ')} UTC` : '';
  return [
    `analyst-harness is running in the background (${status.pid ? `pid ${status.pid}` : 'started outside this manager'}${since}): scheduled scrapers, the learning loop, the Discord bot when configured, and dashboards at ${status.url}/dashboards/.`,
    `Use it from this session with the \`${cli}\` command (installed at ${root}):`,
    `- ${cli} run "<task>": give the analyst agent a data task (uses the Anthropic API and the budgets)`,
    `- ${cli} scrapers, ${cli} scrape <name> [--dry-run]: list and run scrapers; datasets land in ${path.join(dataDir, 'datasets')}`,
    `- ${cli} explore <dataset>, ${cli} dashboard build <spec.yaml>, ${cli} dashboard list: dashboards`,
    `- ${cli} vault search "<query>", ${cli} vault status: the scraping knowledge vault`,
    `- ${cli} domains <host>: whether a host answers from this environment`,
    `- ${cli} daemon status | logs | restart | stop | start`,
  ].join('\n');
}
