import net from 'node:net';
import { ToolError } from '../util/errors';
import type { ExecRequest, ExecResponse } from './protocol';
import type { ShellResult } from './shell';

/**
 * Run one command in the sandbox container. Aborting closes the connection, which makes the
 * sandbox kill the command's process group.
 */
export function sandboxExec(
  socketPath: string,
  req: ExecRequest,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      fn();
    };
    // The sandbox enforces the timeout; this only covers a sandbox that stops answering.
    const guard = setTimeout(
      () => finish(() => reject(new ToolError('The sandbox did not answer in time.'))),
      req.timeoutMs + 15_000,
    );
    const onAbort = () =>
      finish(() => resolve({ exitCode: null, stdout: '', stderr: 'aborted', timedOut: false }));
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(req) + '\n'));
    socket.on('data', (chunk: string) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl < 0) return;
      let res: ExecResponse;
      try {
        res = JSON.parse(data.slice(0, nl)) as ExecResponse;
      } catch {
        finish(() => reject(new ToolError('The sandbox sent an unreadable answer.')));
        return;
      }
      finish(() =>
        res.ok
          ? resolve({
              exitCode: res.exitCode,
              stdout: res.stdout,
              stderr: res.stderr,
              timedOut: res.timedOut,
            })
          : reject(new ToolError(`The sandbox refused the command: ${res.error}`)),
      );
    });
    socket.on('error', (err) =>
      finish(() =>
        reject(
          new ToolError(
            `The command sandbox is unavailable (${(err as NodeJS.ErrnoException).code ?? err.message}); check the sandbox container.`,
          ),
        ),
      ),
    );
    socket.on('end', () =>
      finish(() => reject(new ToolError('The sandbox closed the connection without an answer.'))),
    );
  });
}
