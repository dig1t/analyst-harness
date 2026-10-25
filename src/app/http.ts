import { createHash, timingSafeEqual } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import { DASHBOARD_CSP } from '../dashboards/render';
import type { DashboardService } from '../dashboards/service';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';

export interface WebServerOptions {
  /** Omit to serve only /healthz. */
  dashboards?: DashboardService;
  /** Details added to /healthz for authorized callers. */
  status?: () => Record<string, unknown>;
  /** Basic auth for everything except the bare health check. */
  auth?: { user: string; password: string };
  logger?: Logger;
}

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const FILE_TYPES: Record<string, { type: string; download: boolean }> = {
  'index.html': { type: 'text/html; charset=utf-8', download: false },
  'meta.json': { type: 'application/json; charset=utf-8', download: false },
  'spec.json': { type: 'application/json; charset=utf-8', download: true },
  'notebook.ipynb': { type: 'application/x-ipynb+json', download: true },
};

function digest(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time check of an `Authorization: Basic ...` header. */
export function checkBasicAuth(
  header: string | undefined,
  auth: { user: string; password: string },
): boolean {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return false;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  // Compare digests so neither the length nor the content leaks through timing.
  const userOk = timingSafeEqual(digest(decoded.slice(0, sep)), digest(auth.user));
  const passOk = timingSafeEqual(digest(decoded.slice(sep + 1)), digest(auth.password));
  return userOk && passOk;
}

/**
 * The harness web port: `/healthz` for the container platform and, when dashboards are on,
 * the catalog at `/dashboards/` and each dashboard at `/dashboards/<slug>/`. Only files the
 * dashboard service names are served; every response carries strict security headers.
 */
export function createWebServer(opts: WebServerOptions): http.Server {
  const logger = opts.logger ?? silentLogger;
  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error('web request failed', { err, url: req.url });
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Internal error');
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const authorized = !opts.auth || checkBasicAuth(req.headers.authorization, opts.auth);
    if (url.pathname === '/healthz') {
      const body = authorized && opts.status ? { ok: true, ...opts.status() } : { ok: true };
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD');
      send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
      return;
    }
    const dashboards = opts.dashboards;
    if (!dashboards) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    if (!authorized) {
      res.setHeader('www-authenticate', 'Basic realm="analyst-harness", charset="UTF-8"');
      send(res, 401, 'text/plain; charset=utf-8', 'Authentication required');
      return;
    }
    if (url.pathname === '/' || url.pathname === '/dashboards') {
      redirect(res, '/dashboards/');
      return;
    }
    if (url.pathname === '/dashboards/') {
      const file = dashboards.catalogPath();
      let html = await fsp.readFile(file, 'utf8').catch(() => null);
      if (html === null) {
        await dashboards.writeIndex();
        html = await fsp.readFile(file, 'utf8');
      }
      sendFile(res, req, 'index.html', html);
      return;
    }
    const m = /^\/dashboards\/([^/]+)(?:\/([^/]*))?$/.exec(url.pathname);
    if (!m) {
      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    const slug = m[1]!;
    if (m[2] === undefined) {
      redirect(res, `/dashboards/${encodeURIComponent(slug)}/`);
      return;
    }
    const name = m[2] || 'index.html';
    const file = dashboards.filePath(slug, name);
    const body = file ? await fsp.readFile(file).catch(() => null) : null;
    if (!body) {
      send(res, 404, 'text/plain; charset=utf-8', 'No such dashboard file');
      return;
    }
    sendFile(res, req, name, body);
  }

  function sendFile(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    name: string,
    body: string | Buffer,
  ): void {
    const kind = FILE_TYPES[name] ?? { type: 'application/octet-stream', download: true };
    if (kind.download) res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('cache-control', 'no-cache');
    send(res, 200, kind.type, req.method === 'HEAD' ? '' : body, Buffer.byteLength(body));
  }
}

function redirect(res: http.ServerResponse, location: string): void {
  res.setHeader('location', location);
  send(res, 302, 'text/plain; charset=utf-8', `See ${location}`);
}

function send(
  res: http.ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  length = Buffer.byteLength(body),
): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  res.setHeader('content-security-policy', `${DASHBOARD_CSP}; frame-ancestors 'self'`);
  res.setHeader('content-type', type);
  res.setHeader('content-length', String(length));
  res.writeHead(status);
  res.end(body);
}
