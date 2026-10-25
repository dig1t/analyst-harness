import { spawn } from 'node:child_process';

/** Each stream keeps at most this much output. */
export const OUTPUT_CAP = 512 * 1024;

export interface ShellResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTree = () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
    }, timeoutMs);
    const onAbort = () => killTree();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < OUTPUT_CAP) stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < OUTPUT_CAP) stderr += d.toString();
    });
    const done = (exitCode: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    child.on('error', (err) => {
      stderr += err.message;
      done(null);
    });
    child.on('close', (code) => done(code));
  });
}
