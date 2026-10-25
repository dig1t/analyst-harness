import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type http from 'node:http';
import { checkBasicAuth, createWebServer } from '../../src/app/http';
import { DashboardService } from '../../src/dashboards/service';
import { Workspace } from '../../src/safety/workspace';
import { tmpDir, writeFiles } from '../helpers';

async function start(opts: Parameters<typeof createWebServer>[0]) {
  const server = createWebServer(opts);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

const stop = (server: http.Server) => new Promise((resolve) => server.close(resolve));

async function makeService() {
  const root = await tmpDir('harness-web-');
  await writeFiles(root, {
    'datasets/items/2026-10-25.jsonl': '{"id":1,"kind":"a"}\n{"id":2,"kind":"b"}\n',
  });
  const svc = new DashboardService({
    dir: path.join(root, 'dashboards'),
    datasetsDir: path.join(root, 'datasets'),
    dataDir: root,
    workspaceDir: path.join(root, 'ws'),
    defaultWorkspace: () =>
      new Workspace([
        { alias: '', dir: path.join(root, 'ws'), mode: 'rw' },
        { alias: 'datasets', dir: path.join(root, 'datasets'), mode: 'ro' },
      ]),
  });
  await svc.build({ title: 'Items', data: { items: { dataset: 'items' } }, items: [{ type: 'table' }] });
  return svc;
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

describe('web server', () => {
  test('serves the catalog and dashboard files with strict headers', async () => {
    const dashboards = await makeService();
    const { server, base } = await start({ dashboards, status: () => ({ uptime: '1 min' }) });
    try {
      const health = await fetch(`${base}/healthz`);
      expect(await health.json()).toEqual({ ok: true, uptime: '1 min' });

      const root = await fetch(`${base}/`, { redirect: 'manual' });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('/dashboards/');

      const catalog = await fetch(`${base}/dashboards/`);
      expect(catalog.status).toBe(200);
      expect(await catalog.text()).toContain('<a href="items/">Items</a>');

      const noSlash = await fetch(`${base}/dashboards/items`, { redirect: 'manual' });
      expect(noSlash.headers.get('location')).toBe('/dashboards/items/');

      const page = await fetch(`${base}/dashboards/items/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await page.text()).toContain('<title>Items</title>');

      const nb = await fetch(`${base}/dashboards/items/notebook.ipynb`);
      expect(nb.headers.get('content-disposition')).toBe('attachment; filename="notebook.ipynb"');
      const meta = await fetch(`${base}/dashboards/items/meta.json`);
      expect(await meta.json()).toMatchObject({ slug: 'items', title: 'Items' });

      const head = await fetch(`${base}/dashboards/items/`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(Number(head.headers.get('content-length'))).toBeGreaterThan(1000);

      for (const bad of [
        '/dashboards/items/../../datasets/items/2026-10-25.jsonl',
        '/dashboards/items/%2e%2e%2f%2e%2e%2fsecret',
        '/dashboards/..%2f..%2fetc/index.html',
        '/dashboards/items/secret.txt',
        '/dashboards/nope/',
        '/elsewhere',
      ]) {
        const r = await fetch(`${base}${bad}`, { redirect: 'manual' });
        expect([302, 404]).toContain(r.status);
        expect(await r.text()).not.toContain('"kind"');
      }
      const post = await fetch(`${base}/dashboards/items/`, { method: 'POST' });
      expect(post.status).toBe(405);
      expect(post.headers.get('allow')).toBe('GET, HEAD');
    } finally {
      await stop(server);
    }
  });

  test('basic auth guards dashboards and the detailed health status', async () => {
    const dashboards = await makeService();
    const auth = { user: 'harness', password: 's3cret pass' };
    const { server, base } = await start({ dashboards, auth, status: () => ({ spend: '$1' }) });
    try {
      expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
      const denied = await fetch(`${base}/dashboards/items/`);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('www-authenticate')).toContain('Basic realm="analyst-harness"');
      expect(await denied.text()).not.toContain('Items');
      const wrong = await fetch(`${base}/dashboards/items/`, {
        headers: { authorization: basic('harness', 'nope') },
      });
      expect(wrong.status).toBe(401);
      const ok = await fetch(`${base}/dashboards/items/`, {
        headers: { authorization: basic('harness', 's3cret pass') },
      });
      expect(ok.status).toBe(200);
      const health = await fetch(`${base}/healthz`, {
        headers: { authorization: basic('harness', 's3cret pass') },
      });
      expect(await health.json()).toEqual({ ok: true, spend: '$1' });
    } finally {
      await stop(server);
    }
  });

  test('without dashboards only the health check answers', async () => {
    const { server, base } = await start({});
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      expect((await fetch(`${base}/dashboards/`)).status).toBe(404);
    } finally {
      await stop(server);
    }
  });

  test('checkBasicAuth', () => {
    const auth = { user: 'u', password: 'p:with:colons' };
    expect(checkBasicAuth(basic('u', 'p:with:colons'), auth)).toBe(true);
    expect(checkBasicAuth(basic('u', 'p'), auth)).toBe(false);
    expect(checkBasicAuth(basic('x', 'p:with:colons'), auth)).toBe(false);
    expect(checkBasicAuth('Bearer abc', auth)).toBe(false);
    expect(checkBasicAuth(`Basic ${Buffer.from('nocolon').toString('base64')}`, auth)).toBe(false);
    expect(checkBasicAuth(undefined, auth)).toBe(false);
  });
});
