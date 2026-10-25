import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  classifyOutcome,
  DomainRegistry,
  formatDomainSeed,
  isTrackableHost,
  loadDomainSeed,
  type DomainSeed,
} from '../../src/net/domains';
import { probeUrl } from '../../src/net/probe';
import { PoliteHttpClient } from '../../src/scrapers/http-client';
import { domainStatusTool } from '../../src/tools/harness-tools';
import { webFetchTool } from '../../src/tools/web-fetch';
import { fakeFetch, makeToolContext, makeWorkspace, tmpDir } from '../helpers';

const dnsError = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });

const SEED: DomainSeed = {
  environments: {
    sandbox: { description: 'An allow-listed sandbox', checked: '2026-10-25' },
    server: { description: 'The server' },
  },
  hosts: {
    'pypi.org': { sandbox: 'ok', note: 'JSON API at /pypi/<package>/json' },
    'www.ecb.europa.eu': { sandbox: 'unreachable', server: 'ok' },
  },
};

async function registry(environment = 'sandbox', now = () => Date.parse('2026-10-25T12:00:00Z')) {
  const dir = await tmpDir('harness-domains-');
  const statePath = path.join(dir, 'state', 'domains.json');
  const reg = await DomainRegistry.load({
    statePath,
    seed: structuredClone(SEED),
    environment,
    failFastAfter: 3,
    failFastMs: 6 * 3_600_000,
    now,
  });
  return { reg, statePath, dir };
}

describe('domain registry', () => {
  test('classifies outcomes and recognizes trackable hosts', () => {
    expect(classifyOutcome({ status: 200 })).toBe('ok');
    expect(classifyOutcome({ status: 304 })).toBe('ok');
    expect(classifyOutcome({ status: 404 })).toBe('http-404');
    expect(classifyOutcome({ error: dnsError() })).toBe('unreachable');
    expect(classifyOutcome({ error: Object.assign(new Error('x'), { name: 'TimeoutError' }) })).toBe(
      'timeout',
    );
    expect(classifyOutcome({ error: new Error('Proxy response (403) !== 200 when HTTP Tunneling') })).toBe(
      'blocked',
    );
    expect(isTrackableHost('api.github.com')).toBe(true);
    for (const bad of [
      'a.example',
      'example.com',
      'site.test',
      'localhost',
      '10.0.0.1',
      '<lang',
      'nodot',
      '',
    ])
      expect(isTrackableHost(bad)).toBe(false);
  });

  test('repeated network failures refuse a host until one request gets through', async () => {
    let t = Date.parse('2026-10-25T12:00:00Z');
    const { reg, statePath } = await registry('server', () => t);
    const url = 'https://data.example.org.uk/x';
    expect(reg.failFast(url)).toBeNull();
    reg.record(url, { error: dnsError() });
    reg.record(url, { error: dnsError() });
    expect(reg.failFast(url)).toBeNull();
    reg.record(url, { error: dnsError() });
    expect(reg.failFast(url)).toMatch(
      /^data\.example\.org\.uk failed 3 times in a row .* \(fetch failed \(ENOTFOUND\)\)$/,
    );
    // The refusal expires, and any answer (even an HTTP error) clears it.
    t += 7 * 3_600_000;
    expect(reg.failFast(url)).toBeNull();
    reg.record(url, { error: dnsError() });
    expect(reg.failFast(url)).not.toBeNull();
    reg.record(url, { status: 503 });
    expect(reg.failFast(url)).toBeNull();
    expect(reg.observation('data.example.org.uk')).toMatchObject({
      okCount: 1,
      failCount: 4,
      consecutiveFailures: 0,
      lastStatus: 'http-503',
    });
    // Placeholders and reserved names are never tracked.
    reg.record('https://site.test/', { error: dnsError() });
    expect(reg.observation('site.test')).toBeUndefined();
    await reg.flush();
    const saved = JSON.parse(await fsp.readFile(statePath, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(saved)).toEqual(['data.example.org.uk']);
    const again = await DomainRegistry.load({ statePath, seed: SEED, environment: 'server' });
    expect(again.observation('data.example.org.uk')!.okCount).toBe(1);
  });

  test('the seed refuses hosts listed as unreachable in this environment only', async () => {
    const sandbox = (await registry('sandbox')).reg;
    expect(sandbox.failFast('https://www.ecb.europa.eu/stats/x.xml')).toBe(
      'www.ecb.europa.eu is listed as unreachable from sandbox in the domain registry (checked 2026-10-25)',
    );
    expect(sandbox.failFast('https://pypi.org/pypi/x/json')).toBeNull();
    sandbox.record('https://www.ecb.europa.eu/', { status: 200 });
    expect(sandbox.failFast('https://www.ecb.europa.eu/stats/x.xml')).toBeNull();
    const server = (await registry('server')).reg;
    expect(server.failFast('https://www.ecb.europa.eu/stats/x.xml')).toBeNull();
    const off = await DomainRegistry.load({
      statePath: path.join(await tmpDir(), 'd.json'),
      seed: SEED,
      environment: 'sandbox',
      failFastMs: 0,
    });
    expect(off.failFast('https://www.ecb.europa.eu/')).toBeNull();
  });

  test('reports per host and per environment', async () => {
    const { reg } = await registry('sandbox');
    reg.record('https://pypi.org/pypi/requests/json', { status: 200 });
    reg.record('https://api.github.com/', { status: 403 });
    const hosts = reg.report(['pypi.org', 'www.ecb.europa.eu', 'nowhere.org']);
    expect(hosts).toContain(
      '- pypi.org: answers here (last ok; 1 answered, 0 failed; last answer 2026-10-25 12:00 UTC)',
    );
    expect(hosts).toContain('registry: sandbox ok; note: JSON API at /pypi/<package>/json');
    expect(hosts).toContain('- www.ecb.europa.eu: refused here: www.ecb.europa.eu is listed as unreachable');
    expect(hosts).toContain('registry: sandbox unreachable, server ok');
    expect(hosts).toContain('- nowhere.org: not tried from here yet');
    const summary = reg.report();
    expect(summary).toContain('Environment: sandbox (registry last checked 2026-10-25).');
    expect(summary).toContain('Answering here (observed): api.github.com, pypi.org');
    expect(summary).toContain('Registry, reachable from sandbox: 1 hosts: pypi.org');
    expect(summary).toContain('Registry, unreachable from sandbox: 1 hosts.');
  });

  test('the seed file round-trips, stays one line per host and rejects bad statuses', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'domains.yaml');
    const { reg } = await registry('server');
    reg.setSeedStatus('Example.ORG', 'http-404', '2026-10-26');
    await fsp.writeFile(file, formatDomainSeed(reg.seed));
    const text = await fsp.readFile(file, 'utf8');
    expect(text).toContain('  example.org: { server: http-404 }');
    expect(text).toContain('  www.ecb.europa.eu: { sandbox: unreachable, server: ok }');
    expect(text).toContain('  pypi.org: { sandbox: ok, note: "JSON API at /pypi/<package>/json" }');
    expect(text).toContain("    checked: '2026-10-26'");
    expect(await loadDomainSeed(file)).toEqual(reg.seed);
    expect(await loadDomainSeed(path.join(dir, 'missing.yaml'))).toEqual({ environments: {}, hosts: {} });
    await fsp.writeFile(file, 'hosts:\n  a.org: { server: maybe }\n');
    await expect(loadDomainSeed(file)).rejects.toThrow(/Invalid domain registry/);
  });

  test('the shipped registry loads and covers the scraper sources', async () => {
    const seed = await loadDomainSeed(path.resolve(__dirname, '../../config/domains.yaml'));
    expect(Object.keys(seed.environments)).toEqual(expect.arrayContaining(['claude-code-cloud', 'server']));
    for (const host of ['pypi.org', 'www.ecb.europa.eu', 'hacker-news.firebaseio.com', 'export.arxiv.org'])
      expect(seed.hosts[host]).toBeDefined();
    expect(Object.keys(seed.hosts).every(isTrackableHost)).toBe(true);
  });
});

describe('fetches feed the registry', () => {
  test('web_fetch refuses failing hosts without a request, unless forced', async () => {
    const { workspace } = await makeWorkspace();
    const { reg } = await registry('server');
    const calls: string[] = [];
    const failing = (async (input: string | URL | Request) => {
      calls.push(String(input));
      throw dnsError();
    }) as typeof fetch;
    const ctx = makeToolContext(workspace, {
      services: {
        fetch: failing,
        domains: {
          failFast: (u) => reg.failFast(u),
          record: (u, o) => void reg.record(u, o),
          describe: (h) => reg.report(h),
        },
      },
    });
    ctx.config = { ...ctx.config, allowPrivateNetwork: true };
    const url = 'https://gone.example.net/data.json';
    for (let i = 0; i < 3; i++)
      await expect(webFetchTool.execute({ url }, ctx)).rejects.toThrow(
        'Network error fetching https://gone.example.net/data.json: fetch failed (ENOTFOUND)',
      );
    expect(calls).toHaveLength(3);
    await expect(webFetchTool.execute({ url }, ctx)).rejects.toThrow(
      /^Not fetching https:\/\/gone\.example\.net\/data\.json: gone\.example\.net failed 3 times in a row.*pass force: true/,
    );
    expect(calls).toHaveLength(3);
    await expect(webFetchTool.execute({ url, force: true }, ctx)).rejects.toThrow('Network error');
    expect(calls).toHaveLength(4);

    const status = await domainStatusTool.execute({ hosts: ['https://gone.example.net/x'] }, ctx);
    expect(status.content).toContain('- gone.example.net: refused here: gone.example.net failed 4 times');
    const ok = fakeFetch({
      'https://fine.example.net/': { body: 'hi', headers: { 'content-type': 'text/plain' } },
    });
    ctx.services.fetch = ok.fetch;
    await webFetchTool.execute({ url: 'https://fine.example.net/' }, ctx);
    expect(reg.observation('fine.example.net')).toMatchObject({ okCount: 1, lastStatus: 'ok' });
    await expect(domainStatusTool.execute({}, makeToolContext(workspace))).rejects.toThrow(
      'The domain registry is not configured.',
    );
  });

  test('the scraper HTTP client reports every response and failure', async () => {
    const seen: Array<[string, unknown]> = [];
    const ff = fakeFetch({ 'https://api.example.net/items': { body: [{ id: 1 }] } });
    const client = new PoliteHttpClient({
      userAgent: 'test-bot',
      fetch: ff.fetch,
      allowPrivateNetwork: true,
      observe: (url, o) => void seen.push([url, o.status ?? 'error']),
      sleep: async () => undefined,
    });
    await client.get('https://api.example.net/items', { respectRobots: false, minIntervalMs: 0 });
    expect(seen).toEqual([['https://api.example.net/items', 200]]);
    const broken = new PoliteHttpClient({
      userAgent: 'test-bot',
      fetch: (async () => {
        throw dnsError();
      }) as typeof fetch,
      allowPrivateNetwork: true,
      observe: (url, o) => void seen.push([url, o.status ?? 'error']),
      sleep: async () => undefined,
    });
    await expect(
      broken.get('https://down.example.net/', { respectRobots: false, minIntervalMs: 0, retries: 1 }),
    ).rejects.toThrow('fetch failed');
    expect(seen.slice(1)).toEqual([
      ['https://down.example.net/', 'error'],
      ['https://down.example.net/', 'error'],
    ]);
  });

  test('probeUrl follows redirects and reports failures without throwing', async () => {
    const ff = fakeFetch({
      'https://a.example.net/': { status: 301, headers: { location: '/home' } },
      'https://a.example.net/home': { body: 'ok', headers: { 'content-type': 'text/plain' } },
    });
    const ok = await probeUrl('https://a.example.net/', {
      userAgent: 'x',
      fetch: ff.fetch,
      allowPrivate: true,
    });
    expect(ok).toMatchObject({ status: 200, finalUrl: 'https://a.example.net/home' });
    const bad = await probeUrl('https://b.example.net/', {
      userAgent: 'x',
      allowPrivate: true,
      fetch: (async () => {
        throw dnsError();
      }) as typeof fetch,
    });
    expect(classifyOutcome(bad)).toBe('unreachable');
    const loop = await probeUrl('https://c.example.net/', {
      userAgent: 'x',
      allowPrivate: true,
      fetch: fakeFetch({ 'https://c.example.net/': { status: 302, headers: { location: '/' } } }).fetch,
    });
    expect((loop.error as Error).message).toBe('too many redirects');
  });
});
