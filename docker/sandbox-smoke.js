// CI smoke test for the sandbox in the built image: start the server, run python3 through
// the client, expect 42. Run with: node docker/sandbox-smoke.js (inside the image).
process.env.SANDBOX_SOCKET = process.env.SANDBOX_SOCKET || '/tmp/exec.sock';
process.env.SANDBOX_MOUNTS = process.env.SANDBOX_MOUNTS || '=/tmp';
const root = process.env.HARNESS_ROOT || '/app';
const { startSandbox } = require(`${root}/dist/sandbox/main.js`);
const { sandboxExec } = require(`${root}/dist/sandbox/client.js`);

startSandbox()
  .then(() =>
    sandboxExec(process.env.SANDBOX_SOCKET, {
      v: 1,
      command: 'python3 -c "print(6 * 7)"',
      timeoutMs: 20000,
    }),
  )
  .then(
    (r) => {
      process.stdout.write(`sandbox answered: ${r.stdout}`);
      process.exit(r.stdout.trim() === '42' ? 0 : 1);
    },
    (err) => {
      process.stderr.write(`sandbox smoke test failed: ${err.message}\n`);
      process.exit(1);
    },
  );
