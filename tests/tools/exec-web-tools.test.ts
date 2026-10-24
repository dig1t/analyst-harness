import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { bashOnlyTool, bashTool, runShell } from '../../src/tools/bash-tool';
import { guardedFetch, htmlToMarkdown, htmlToText, webFetchTool } from '../../src/tools/web-fetch';
import { PermissionDeniedError } from '../../src/util/errors';
import { fakeFetch, makeToolContext, makeWorkspace } from '../helpers';

describe('bash tool', () => {
  test('runs allow-listed commands and reports exit codes', async () => {
    const { root, workspace } = await makeWorkspace();
    await fsp.writeFile(path.join(root, 'a.txt'), 'hello\n');
    const ctx = makeToolContext(workspace);
    const out = await bashTool.execute({ command: 'cat a.txt' }, ctx);
    expect(out.content).toMatch(/^exit_code: 0/);
    expect(out.content).toContain('hello');
    expect(out.isError).toBe(false);
  });

  test('non-zero exits are errors; denied and un-approved commands throw', async () => {
    const { workspace } = await makeWorkspace();
    const trusted = makeToolContext(workspace, { policy: { mode: 'trusted' } });
    const out = await bashTool.execute({ command: 'echo oops >&2; exit 3' }, trusted);
    expect(out.isError).toBe(true);
    expect(out.content).toContain('exit_code: 3');
    expect(out.content).toContain('--- stderr ---\noops');
    await expect(bashTool.execute({ command: 'sudo ls' }, trusted)).rejects.toBeInstanceOf(
      PermissionDeniedError,
    );
    await expect(
      bashTool.execute({ command: 'python3 -c "print(1)"' }, makeToolContext(workspace)),
    ).rejects.toThrow(/not granted/);
  });

  test('secrets are scrubbed from the environment', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace, { policy: { mode: 'trusted' } });
    const out = await bashTool.execute(
      { command: 'echo "token=${SECRET_TOKEN:-none} key=${ANTHROPIC_API_KEY:-none}"' },
      ctx,
    );
    expect(out.content).toContain('token=none key=none');
  });

  test('times out long commands and rejects bad cwd', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace, { policy: { mode: 'trusted' } });
    const out = await bashTool.execute({ command: 'sleep 5', timeout_seconds: 1 }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/timed_out=true/);
    await expect(bashTool.execute({ command: 'ls', cwd: 'missing' }, ctx)).rejects.toThrow(
      /not an existing directory/,
    );
    await expect(bashTool.execute({ command: 'ls', cwd: '../' }, ctx)).rejects.toThrow(/escapes/);
  });

  test('abort signals kill the process', async () => {
    const controller = new AbortController();
    const p = runShell('sleep 5', process.cwd(), { PATH: process.env.PATH ?? '' }, 10_000, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const res = await p;
    expect(res.exitCode).not.toBe(0);
  });

  test('bash-only variant keeps the executor but swaps the description', () => {
    expect(bashOnlyTool.execute).toBe(bashTool.execute);
    expect(bashOnlyTool.description).toMatch(/ONLY tool for touching the workspace/);
    expect(bashTool.description).toMatch(/prefer read_file/);
  });
});

describe('web_fetch tool', () => {
  const html =
    '<html><head><style>x{}</style><script>evil()</script></head><body><nav aria-hidden="true">menu</nav><main><h1>Title</h1><p>Hello <a href="/x">link</a></p></main></body></html>';

  async function ctxWith(routes: Parameters<typeof fakeFetch>[0]) {
    const { workspace } = await makeWorkspace();
    const ff = fakeFetch(routes);
    const ctx = makeToolContext(workspace, { services: { fetch: ff.fetch } });
    ctx.config = { ...ctx.config, allowPrivateNetwork: true };
    return { ctx, calls: ff.calls };
  }

  test('converts HTML to markdown without scripts or styles', async () => {
    const { ctx, calls } = await ctxWith({
      'https://site.test/': { body: html, headers: { 'content-type': 'text/html; charset=utf-8' } },
    });
    const out = await webFetchTool.execute({ url: 'https://site.test/' }, ctx);
    expect(out.content).toMatch(/^\[200 https:\/\/site.test\//);
    expect(out.content).toContain('# Title');
    expect(out.content).toContain('[link](/x)');
    expect(out.content).not.toContain('evil');
    expect((calls[0]!.init!.headers as Record<string, string>)['user-agent']).toMatch(/analyst-harness/);
    const text = await webFetchTool.execute({ url: 'https://site.test/', format: 'text' }, ctx);
    expect(text.content).toContain('Title');
    expect(text.content).not.toContain('<');
    const raw = await webFetchTool.execute({ url: 'https://site.test/', format: 'html' }, ctx);
    expect(raw.content).toContain('<main>');
  });

  test('pretty-prints JSON and flags HTTP errors with a preview', async () => {
    const { ctx } = await ctxWith({
      'https://api.test/x': { body: { a: [1, 2] } },
      'https://api.test/missing': { status: 404, body: 'nothing here' },
    });
    expect((await webFetchTool.execute({ url: 'https://api.test/x' }, ctx)).content).toContain(
      '"a": [\n    1,',
    );
    const err = await webFetchTool.execute({ url: 'https://api.test/missing' }, ctx);
    expect(err.isError).toBe(true);
    expect(err.content).toContain('nothing here');
  });

  test('binary content returns a notice and large bodies are truncated', async () => {
    const { ctx } = await ctxWith({
      'https://cdn.test/img': { body: 'PNGDATA', headers: { 'content-type': 'image/png' } },
      'https://cdn.test/big': { body: 'x'.repeat(5000), headers: { 'content-type': 'text/plain' } },
    });
    expect((await webFetchTool.execute({ url: 'https://cdn.test/img' }, ctx)).content).toMatch(
      /Binary content/,
    );
    const big = await webFetchTool.execute({ url: 'https://cdn.test/big', max_bytes: 1024 }, ctx);
    expect(big.content).toContain('truncated');
  });

  test('follows redirects but re-checks every hop against the SSRF guard', async () => {
    const { workspace } = await makeWorkspace();
    const ff = fakeFetch({
      'https://93.184.216.34/start': { status: 302, headers: { location: 'https://93.184.216.34/next' } },
      'https://93.184.216.34/next': {
        status: 301,
        headers: { location: 'http://169.254.169.254/latest/meta-data' },
      },
    });
    const ctx = makeToolContext(workspace, { services: { fetch: ff.fetch } });
    await expect(webFetchTool.execute({ url: 'https://93.184.216.34/start' }, ctx)).rejects.toThrow(
      /private or reserved|Refusing/,
    );
    expect(ff.calls.map((c) => c.url)).toEqual(['https://93.184.216.34/start', 'https://93.184.216.34/next']);
  });

  test('redirect loops stop and network errors become tool errors', async () => {
    const { ctx } = await ctxWith({
      'https://loop.test/': { status: 302, headers: { location: 'https://loop.test/' } },
    });
    await expect(guardedFetch('https://loop.test/', ctx, {}, 2)).rejects.toThrow(/Too many redirects/);
    const failing = makeToolContext(ctx.workspace, {
      services: { fetch: (async () => Promise.reject(new TypeError('ECONNREFUSED'))) as typeof fetch },
    });
    failing.config = { ...failing.config, allowPrivateNetwork: true };
    await expect(webFetchTool.execute({ url: 'https://down.test/' }, failing)).rejects.toThrow(
      /Network error/,
    );
  });

  test('html helpers', () => {
    expect(htmlToMarkdown('<p>a</p><p>b</p>')).toBe('a\n\nb');
    expect(htmlToText('<body><p>x</p><script>y</script></body>')).toBe('x');
  });
});
