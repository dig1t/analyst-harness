#!/usr/bin/env node
/**
 * Claude Code SessionStart hook: make sure analyst-harness is installed, built and running,
 * then tell the session how to use it (stdout becomes session context).
 *
 * Registered by .claude/settings.json for sessions in this repository and, after
 * scripts/install.sh, by ~/.claude/settings.json for every session on the machine. It runs
 * synchronously, installs dependencies and builds only when they are missing or stale (cloud
 * sessions start from a fresh clone), and never fails the session: problems become context.
 * Set HARNESS_AUTOSTART=0 to turn it off for a session.
 */
'use strict';
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Claude Code sends a JSON object on stdin; read it only when stdin is a pipe or a file. */
function hookInput() {
  try {
    const st = fs.fstatSync(0);
    if (!st.isFIFO() && !st.isFile()) return {};
    const text = fs.readFileSync(0, 'utf8');
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

const mtime = (p) => fs.statSync(p, { throwIfNoEntry: false })?.mtimeMs ?? 0;

function newest(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(p) : mtime(p));
  }
  return latest;
}

/** Run npm with its output on stderr, so it never lands in the session context. */
function npm(args) {
  // npm and the scripts it runs need node on PATH, which an app-launched Claude Code may lack.
  const PATH = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`;
  const res = spawnSync(NPM, args, {
    cwd: ROOT,
    stdio: ['ignore', 2, 2],
    env: { ...process.env, PATH },
    shell: process.platform === 'win32',
  });
  if (res.error) throw new Error(`could not run npm: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} failed (exit ${res.status ?? res.signal})`);
}

/** What is missing or older than its sources. */
function staleness() {
  const lock = path.join(ROOT, 'node_modules', '.package-lock.json');
  const install = !fs.existsSync(lock) || mtime(path.join(ROOT, 'package-lock.json')) > mtime(lock);
  const built = mtime(path.join(ROOT, 'dist', 'cli.js'));
  const ui = mtime(path.join(ROOT, 'dist', 'ui', 'dashboard.js'));
  const sources = Math.max(newest(path.join(ROOT, 'src')), newest(path.join(ROOT, 'ui')));
  return { install, build: !built || !ui || sources > Math.min(built, ui) };
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Several sessions can start at once; only one of them installs or builds at a time. */
function withBuildLock(fn) {
  const id = crypto.createHash('sha256').update(ROOT).digest('hex').slice(0, 12);
  const lock = path.join(os.tmpdir(), `analyst-harness-build-${id}.lock`);
  const until = Date.now() + 590_000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() - mtime(lock) > 600_000) fs.rmSync(lock, { force: true });
      else if (Date.now() > until)
        throw new Error('another session is still building the harness', { cause: err });
      else sleepSync(500);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Install and build when missing or stale. `harness daemon ensure` then restarts a harness that
 * still runs the previous build.
 */
function prepare() {
  const first = staleness();
  if (!first.install && !first.build) return;
  withBuildLock(() => {
    // Check again: another session may have finished the work while this one waited.
    const todo = staleness();
    if (todo.install) npm(['install', '--no-audit', '--no-fund']);
    if (todo.build) npm(['run', 'build']);
  });
}

/** Skip a second note for the same session event (the project and the user hook both run here). */
function alreadyReported(input) {
  if (!input.session_id) return false;
  const marker = path.join(
    os.tmpdir(),
    `analyst-harness-${String(input.session_id).replace(/[^\w-]/g, '')}-${input.source || 'start'}`,
  );
  try {
    if (Date.now() - mtime(marker) >= 120_000) fs.rmSync(marker, { force: true });
    fs.closeSync(fs.openSync(marker, 'wx'));
    return false;
  } catch (err) {
    // EEXIST: the other hook got here first. Anything else only means the note may appear twice.
    return err.code === 'EEXIST';
  }
}

/**
 * Put bin/harness on the session's PATH so `harness ...` works in its shell, and in cloud
 * sessions point the harness at the registry column for that environment.
 */
function exposeCli(environment) {
  const file = process.env.CLAUDE_ENV_FILE;
  if (!file) return;
  const lines = [`export PATH="${path.join(ROOT, 'bin')}:$PATH"`];
  if (environment) lines.push(`export HARNESS_ENVIRONMENT=${environment}`);
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const missing = lines.filter((l) => !current.includes(l));
  if (missing.length) fs.appendFileSync(file, `${missing.join('\n')}\n`);
}

function main() {
  if (process.env.HARNESS_AUTOSTART === '0') return;
  const input = hookInput();
  if (alreadyReported(input)) return;
  try {
    prepare();
    const env = { ...process.env, HARNESS_ROOT: ROOT };
    const cli = (...args) =>
      spawnSync(process.execPath, [path.join(ROOT, 'dist', 'cli.js'), ...args], {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      });
    // Cloud sessions use their own column of the domain registry (config/domains.yaml).
    if (process.env.CLAUDE_CODE_REMOTE === 'true' && !env.HARNESS_ENVIRONMENT)
      env.HARNESS_ENVIRONMENT = 'claude-code-cloud';
    exposeCli(process.env.CLAUDE_CODE_REMOTE === 'true' ? env.HARNESS_ENVIRONMENT : undefined);
    const res = cli('daemon', 'ensure', '--hook');
    const note = (res.stdout || '').trim();
    if (note) process.stdout.write(`${note}\n`);
    else
      throw new Error(
        (res.stderr || '').trim().split('\n').slice(-3).join(' ') || `exit ${res.status ?? res.signal}`,
      );
  } catch (err) {
    process.stdout.write(
      `analyst-harness (installed at ${ROOT}) could not be started for this session: ${err.message}\n` +
        `Repair it with \`bash ${path.join(ROOT, 'scripts', 'install.sh')}\`, then \`harness daemon start\`.\n`,
    );
  }
}

main();
