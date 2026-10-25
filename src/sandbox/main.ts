import { createLogger } from '../util/logger';
import { createSandboxServer, listenSandbox, parseMounts } from './server';

/**
 * Entry point of the sandbox container (`node dist/sandbox/main.js`). Configuration comes
 * from the environment: SANDBOX_SOCKET, SANDBOX_MOUNTS (alias=dir, comma separated; the empty
 * alias is the workspace root) and SANDBOX_MAX_CONCURRENT.
 */
export async function startSandbox(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const logger = createLogger({ level: env.LOG_LEVEL === 'debug' ? 'debug' : 'info', format: 'json' });
  const socketPath = env.SANDBOX_SOCKET ?? '/sandbox/exec.sock';
  const mounts = parseMounts(env.SANDBOX_MOUNTS ?? '=/workspace');
  const server = createSandboxServer({
    socketPath,
    mounts,
    maxConcurrent: Number(env.SANDBOX_MAX_CONCURRENT ?? 4),
    logger: logger.child({ component: 'sandbox' }),
  });
  await listenSandbox(server, socketPath);
  logger.info('sandbox listening', {
    socketPath,
    mounts: Object.keys(mounts).map((m) => m || '(workspace)'),
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) {
  startSandbox().catch((err) => {
    process.stderr.write(`sandbox failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
