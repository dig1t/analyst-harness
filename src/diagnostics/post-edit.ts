import { spawn } from 'node:child_process';
import path from 'node:path';
import YAML from 'yaml';

export interface Diagnostic {
  tool: string;
  ok: boolean;
  output: string;
}

export type CommandRunner = (
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<{ code: number | null; output: string }>;

export const runCommand: CommandRunner = (cmd, args, cwd, timeoutMs) =>
  new Promise((resolve) => {
    let output = '';
    let settled = false;
    const child = spawn(cmd, args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code: null, output: err.message });
      }
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, output: output.trim() });
      }
    });
  });

/**
 * Post-edit diagnostics (paper section 2.4): after a supported edit the harness runs a fast,
 * read-only check and appends the findings to the tool result, so syntax errors surface
 * before the model spends a turn running the code.
 */
export class PostEditDiagnostics {
  constructor(
    private readonly run: CommandRunner = runCommand,
    private readonly timeoutMs = 15_000,
  ) {}

  async check(absPath: string, content: string): Promise<Diagnostic | null> {
    const ext = path.extname(absPath).toLowerCase();
    const cwd = path.dirname(absPath);
    switch (ext) {
      case '.json':
        try {
          JSON.parse(content);
          return { tool: 'json', ok: true, output: 'valid JSON' };
        } catch (err) {
          return { tool: 'json', ok: false, output: (err as Error).message };
        }
      case '.yaml':
      case '.yml':
        try {
          YAML.parse(content);
          return { tool: 'yaml', ok: true, output: 'valid YAML' };
        } catch (err) {
          return { tool: 'yaml', ok: false, output: (err as Error).message.split('\n')[0] ?? 'invalid YAML' };
        }
      case '.py': {
        const ruff = await this.run(
          'ruff',
          ['check', '--quiet', '--output-format', 'concise', absPath],
          cwd,
          this.timeoutMs,
        );
        if (ruff.code !== null)
          return { tool: 'ruff', ok: ruff.code === 0, output: ruff.output || 'no issues' };
        const compile = await this.run(
          'python3',
          ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', absPath],
          cwd,
          this.timeoutMs,
        );
        if (compile.code === null) return null;
        return { tool: 'python-syntax', ok: compile.code === 0, output: compile.output || 'syntax OK' };
      }
      case '.js':
      case '.mjs':
      case '.cjs': {
        const res = await this.run(process.execPath, ['--check', absPath], cwd, this.timeoutMs);
        if (res.code === null) return null;
        return { tool: 'node --check', ok: res.code === 0, output: res.output || 'syntax OK' };
      }
      default:
        return null;
    }
  }

  static format(d: Diagnostic | null): string {
    if (!d) return '';
    return `\n\n[post-edit diagnostics: ${d.tool}] ${d.ok ? 'OK' : 'PROBLEMS FOUND'}\n${d.output}`;
  }
}
