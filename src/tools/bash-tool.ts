import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { sandboxExec } from '../sandbox/client';
import { runShell, type ShellResult } from '../sandbox/shell';
import { scrubbedEnv } from '../safety/env';
import { ToolError } from '../util/errors';
import { defineTool, requirePermission, type ToolContext, type ToolDefinition } from './types';

export { runShell, type ShellResult };

const TOOLS_DESCRIPTION = `Execute a shell command in the workspace and return its exit code, stdout and stderr. Useful for running analysis scripts (python3, node), DuckDB or sqlite3 CLIs, tests, linters and read-only git queries.
When: use this when you need to invoke external programs. For file reading prefer read_file (it records read state for read-before-write); for file search prefer grep_text; for SQL over CSV/JSON/Parquet prefer sql_query.
Protocol: command is run via /bin/sh -c, so pipes, redirects and shell builtins work. cwd defaults to the workspace root and must be inside the workspace. timeout_seconds (default 120, max 600) kills the process on expiry and returns whatever output it produced, with timed_out=true. The exit code is returned literally; non-zero exit codes are reported as errors so you see the failure clearly. The harness does NOT track which files the shell touched: run ls or git status afterwards if you need to know.
Error modes: the permission layer rejects destructive commands by default (rm -rf, sudo, git push, git reset --hard, chmod -R, chown -R, piping downloads into a shell); they return a denied error, don't expect approval. Read-only commands on the default allow list (git status/diff/log/branch/show, ls, pwd, rg, cat, head, tail, wc, file, grep, jq, find without -exec/-delete) run without prompting. Everything else may require approval. Secrets are not present in the shell environment.
Side effects: anything the command does: file creation, network calls, package installs. Files modified by bash are NOT eligible for edit_file without a fresh read_file.`;

const BASH_ONLY_DESCRIPTION = `Execute a shell command in the workspace and return its exit code, stdout and stderr. This is your ONLY tool for touching the workspace: reading, searching, editing files and querying data all happen through commands you write (cat, sed -n, rg, python3, duckdb, sqlite3, jq).
Protocol: command is run via /bin/sh -c, so pipes, redirects and shell builtins work. cwd defaults to the workspace root and must be inside the workspace. timeout_seconds (default 120, max 600) kills the process on expiry and returns whatever output it produced, with timed_out=true. The exit code is returned literally; non-zero exit codes are reported as errors.
Error modes: the permission layer rejects destructive commands by default (rm -rf, sudo, git push, git reset --hard, chmod -R, chown -R, piping downloads into a shell); they return a denied error, don't expect approval. Read-only commands on the allow list run without prompting; everything else may require approval. Secrets are not present in the shell environment.
Side effects: anything the command does. Nothing validates your edits, so after modifying a file read it back to confirm the change landed as intended.`;

async function execute(
  { command, timeout_seconds, cwd }: { command: string; timeout_seconds?: number; cwd?: string },
  ctx: ToolContext,
) {
  const timeout = Math.min(timeout_seconds ?? ctx.config.bashTimeoutDefaultSec, ctx.config.bashTimeoutMaxSec);
  const dir = await ctx.workspace.resolve(cwd ?? '.', 'read');
  const st = await fsp.stat(dir.abs).catch(() => null);
  if (!st?.isDirectory()) throw new ToolError(`cwd ${dir.display} is not an existing directory.`);
  await requirePermission(ctx, {
    kind: 'bash',
    tool: 'bash',
    summary: `run \`${command.length > 200 ? command.slice(0, 200) + '...' : command}\``,
    command,
  });
  const socket = ctx.config.sandboxSocket;
  let res: ShellResult;
  if (socket) {
    // The sandbox has its own clean environment; only variables passed on purpose go along.
    const passed = Object.fromEntries(
      ctx.config.bashPassEnv.filter((k) => ctx.env[k] !== undefined).map((k) => [k, ctx.env[k]!]),
    );
    res = await sandboxExec(
      socket,
      {
        v: 1,
        command,
        mount: dir.mount.alias,
        cwd: path.relative(dir.mount.dir, dir.abs) || '.',
        timeoutMs: timeout * 1000,
        env: passed,
      },
      ctx.signal,
    );
  } else
    res = await runShell(
      command,
      dir.abs,
      scrubbedEnv(ctx.env, ctx.config.bashPassEnv),
      timeout * 1000,
      ctx.signal,
    );
  const parts = [
    `exit_code: ${res.exitCode ?? 'none'}${res.timedOut ? ` (timed_out=true after ${timeout}s)` : ''}`,
  ];
  if (res.stdout) parts.push(`--- stdout ---\n${res.stdout.trimEnd()}`);
  if (res.stderr) parts.push(`--- stderr ---\n${res.stderr.trimEnd()}`);
  if (!res.stdout && !res.stderr) parts.push('(no output)');
  return { content: parts.join('\n'), isError: res.timedOut || res.exitCode !== 0 };
}

const schema = z.object({
  command: z.string().min(1),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
  cwd: z.string().optional().describe('Working directory relative to the workspace root'),
});

export const bashTool = defineTool({
  name: 'bash',
  category: 'execution',
  readOnly: false,
  usageRule:
    'analysis scripts, CLIs, git status/diff. Avoid destructive commands: they will be denied by the permission layer.',
  description: TOOLS_DESCRIPTION,
  schema,
  execute,
});

/** Same executor with the bash-only description (paper, Figure 28). */
export const bashOnlyTool: ToolDefinition<z.infer<typeof schema>> = {
  ...bashTool,
  usageRule:
    'every workspace interaction (read, search, edit, query). Avoid destructive commands: they will be denied by the permission layer.',
  description: BASH_ONLY_DESCRIPTION,
};
