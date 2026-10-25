import { z } from 'zod';

/**
 * One shell command for the sandbox: newline-terminated JSON over a Unix socket, one request
 * per connection, answered by one JSON line. Closing the connection early kills the command.
 */
export const ExecRequestSchema = z
  .object({
    v: z.literal(1),
    command: z.string().min(1).max(100_000),
    /** Workspace alias of the working directory: '' (the workspace root), 'datasets', ... */
    mount: z
      .string()
      .regex(/^[a-z0-9-]{0,64}$/)
      .default(''),
    /** Directory inside that mount, relative and without `..`. */
    cwd: z.string().max(4096).default('.'),
    timeoutMs: z.number().int().min(1_000).max(600_000),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(10_000)).default({}),
  })
  .strict();

export type ExecRequest = z.input<typeof ExecRequestSchema>;

export type ExecResponse =
  | {
      ok: true;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      durationMs: number;
    }
  | { ok: false; error: string };

/** Largest request line the server reads. */
export const MAX_REQUEST_BYTES = 1024 * 1024;
