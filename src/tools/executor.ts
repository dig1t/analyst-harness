import type { ToolCallBlock } from '../core/types';
import { PermissionDeniedError, ToolError, errorMessage } from '../util/errors';
import { truncateMiddle } from '../util/text';
import type { ToolRegistry } from './registry';
import type { ToolContext } from './types';

export interface ToolExecution {
  call: ToolCallBlock;
  content: string;
  isError: boolean;
  permissionDenied: boolean;
  durationMs: number;
  changedFiles: string[];
  metadata?: Record<string, unknown>;
}

export interface ExecutorOptions {
  /** Tool results are truncated to this many characters (paper: 24k). */
  maxResultChars: number;
  /** Up to this many read-only calls run concurrently per step (paper: 8). */
  maxParallelReadOnly: number;
}

function formatZodIssues(error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string {
  return error.issues
    .map((i) => `- ${i.path.length ? i.path.map(String).join('.') : '(input)'}: ${i.message}`)
    .join('\n');
}

/** Execute one tool call. Never throws: every failure becomes an error observation. */
export async function executeToolCall(
  call: ToolCallBlock,
  registry: ToolRegistry,
  ctx: ToolContext,
  opts: ExecutorOptions,
): Promise<ToolExecution> {
  const started = Date.now();
  const finish = (content: string, isError: boolean, extra: Partial<ToolExecution> = {}): ToolExecution => ({
    call,
    content: truncateMiddle(content, opts.maxResultChars),
    isError,
    permissionDenied: false,
    durationMs: Date.now() - started,
    changedFiles: [],
    ...extra,
  });

  const def = registry.get(call.name);
  if (!def) {
    return finish(
      `Unknown tool \`${call.name}\`. It is not available in this harness configuration. Available tools: ${registry.names().join(', ')}.`,
      true,
    );
  }
  const parsed = def.schema.safeParse(call.input ?? {});
  if (!parsed.success) {
    return finish(
      `Invalid input for \`${call.name}\`:\n${formatZodIssues(parsed.error)}\nFix the input and call it again.`,
      true,
    );
  }
  try {
    if (ctx.signal?.aborted) return finish('The run was cancelled before this tool ran.', true);
    const out = await def.execute(parsed.data, ctx);
    return finish(out.content, out.isError === true, {
      changedFiles: out.changedFiles ?? [],
      metadata: out.metadata,
    });
  } catch (err) {
    if (err instanceof PermissionDeniedError) return finish(err.message, true, { permissionDenied: true });
    if (err instanceof ToolError) return finish(err.message, true);
    ctx.logger.error('tool crashed', { tool: call.name, err });
    return finish(`Internal error in \`${call.name}\`: ${errorMessage(err)}`, true);
  }
}

/**
 * Execute a model turn's tool calls. Consecutive read-only calls run concurrently (bounded);
 * a mutating call is a barrier that runs alone, so ordering between writes and reads holds.
 * Results come back in the order the model issued the calls.
 */
export async function executeToolCalls(
  calls: ToolCallBlock[],
  registry: ToolRegistry,
  ctx: ToolContext,
  opts: ExecutorOptions,
): Promise<ToolExecution[]> {
  const results: ToolExecution[] = new Array(calls.length);
  let i = 0;
  while (i < calls.length) {
    const def = registry.get(calls[i]!.name);
    if (def?.readOnly) {
      let j = i;
      while (j < calls.length && registry.get(calls[j]!.name)?.readOnly) j++;
      const batch = calls.slice(i, j);
      for (let k = 0; k < batch.length; k += opts.maxParallelReadOnly) {
        const slice = batch.slice(k, k + opts.maxParallelReadOnly);
        const out = await Promise.all(slice.map((c) => executeToolCall(c, registry, ctx, opts)));
        out.forEach((r, n) => (results[i + k + n] = r));
      }
      i = j;
    } else {
      results[i] = await executeToolCall(calls[i]!, registry, ctx, opts);
      i++;
    }
  }
  return results;
}
