import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { extract, getPath, mapFields, parseFeed, parseSitemap } from '../../src/scrapers/extract';
import {
  decodeBody,
  HttpError,
  PoliteHttpClient,
  RobotsDisallowedError,
} from '../../src/scrapers/http-client';
import { HostRateLimiter } from '../../src/scrapers/rate-limiter';
import { ScraperRegistry } from '../../src/scrapers/registry';
import { RobotsCache } from '../../src/scrapers/robots';
import { formatScrapeReport, ScraperRunner } from '../../src/scrapers/runner';
import { loadScraperSpecs, parseScraperSpec, type ScraperSpecInput } from '../../src/scrapers/spec';
import { coerce, validateRecords } from '../../src/scrapers/validate';
import { fakeFetch, tmpDir, writeFiles, type FakeRoute } from '../helpers';

const UA = 'analyst-harness-test/1.0';

function client(
  routes: Record<string, FakeRoute | ((init?: RequestInit) => FakeRoute)>,
  extra: Partial<ConstructorParameters<typeof PoliteHttpClient>[0]> = {},
) {
  const ff = fakeFetch(routes);
  const sleeps: number[] = [];
  const http = new PoliteHttpClient({
    userAgent: UA,
    fetch: ff.fetch,
    allowPrivateNetwork: true,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    limiter: new HostRateLimiter(
      () => 0,
      async () => undefined,
    ),
    ...extra,
  });
  return { http, calls: ff.calls, sleeps };
}

const spec = (input: Partial<ScraperSpecInput> & Pick<ScraperSpecInput, 'source'>) =>
  parseScraperSpec({ name: 'test-scraper', ...input });

describe('scraper specs', () => {
  test('applies defaults and validates strictly', () => {
    const s = spec({ source: { type: 'rss', url: 'https://x.test/feed' } });
    expect(s).toMatchObject({
      enabled: true,
      timezone: 'UTC',
      output: { mode: 'changed' },
      validation: { minItems: 1, maxInvalidRatio: 0.2 },
      fetch: { respectRobots: true, retries: 3, minIntervalMs: 1000 },
    });
    expect(() => parseScraperSpec({ name: 'Bad Name', source: { type: 'rss', url: 'https://x' } })).toThrow(
      /Invalid scraper spec/,
    );
    expect(() => parseScraperSpec({ name: 'x', source: { type: 'ftp', url: 'https://x' } })).toThrow();
    expect(() =>
      parseScraperSpec({ name: 'x', source: { type: 'rss', url: 'https://x' }, surprise: 1 }),
    ).toThrow();
  });

  test('the example specs in config/scrapers are valid', async () => {
    const specs = await loadScraperSpecs(path.resolve(__dirname, '../../config/scrapers'));
    expect(specs.map((s) => s.name).sort()).toEqual([
      'arxiv-cs-ai',
      'books-toscrape',
      'ecb-exchange-rates',
      'hn-top-stories',
    ]);
    for (const s of specs) expect(s.description).not.toBe('');
  });

  test('loader rejects duplicates and invalid YAML, and tolerates a missing folder', async () => {
    const dir = await tmpDir();
    await writeFiles(dir, {
      'a.yaml': 'name: dup\nsource: { type: rss, url: "https://x.test/a" }\n',
      'b.yml': 'name: dup\nsource: { type: rss, url: "https://x.test/b" }\n',
    });
    await expect(loadScraperSpecs(dir)).rejects.toThrow(/Duplicate scraper name/);
    await writeFiles(dir, { 'b.yml': 'name: [oops' });
    await expect(loadScraperSpecs(dir)).rejects.toThrow(/Invalid YAML/);
    expect(await loadScraperSpecs(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('extractors', () => {
  test('getPath walks objects and arrays', () => {
    expect(getPath({ a: { b: [{ c: 5 }] } }, 'a.b.0.c')).toBe(5);
    expect(getPath({ a: 1 }, '')).toEqual({ a: 1 });
    expect(getPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getPath('str', 'a')).toBeUndefined();
  });

  test('json: items path, limit and expansion of id lists', async () => {
    const { http, calls } = client({
      'https://api.test/top.json': { body: [1, 2, 3] },
      'https://api.test/item/1.json': { body: { id: 1, title: ' First ', score: '10' } },
      'https://api.test/item/2.json': { body: { id: 2, title: 'Second', score: 3 } },
    });
    const s = spec({
      source: {
        type: 'json',
        url: 'https://api.test/top.json',
        expand: { url: 'https://api.test/item/{item}.json', limit: 2 },
      },
      fields: {
        id: { path: 'id', type: 'integer', required: true },
        title: { path: 'title', transform: ['trim'] },
        score: { path: 'score', type: 'number' },
      },
      fetch: { respectRobots: false },
    });
    const res = await extract(s, { http });
    expect(res.records).toEqual([
      { id: 1, title: 'First', score: '10' },
      { id: 2, title: 'Second', score: 3 },
    ]);
    expect(res.pages).toBe(3);
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.test/top.json',
      'https://api.test/item/1.json',
      'https://api.test/item/2.json',
    ]);
  });

  test('json: entries mode turns object maps into records and errors are explicit', async () => {
    const { http } = client({
      'https://fx.test/latest': { body: { base: 'EUR', rates: { USD: 1.1, GBP: 0.85 } } },
      'https://fx.test/bad': { body: 'not json', headers: { 'content-type': 'text/plain' } },
    });
    const s = spec({
      source: { type: 'json', url: 'https://fx.test/latest', items: 'rates', entries: true },
      fields: { currency: { path: 'key' }, rate: { path: 'value', type: 'number' } },
      fetch: { respectRobots: false },
    });
    expect((await extract(s, { http })).records).toEqual([
      { currency: 'USD', rate: 1.1 },
      { currency: 'GBP', rate: 0.85 },
    ]);
    await expect(
      extract(
        spec({
          source: { type: 'json', url: 'https://fx.test/latest', items: 'base' },
          fetch: { respectRobots: false },
        }),
        { http },
      ),
    ).rejects.toThrow(/not an array/);
    await expect(
      extract(
        spec({
          source: { type: 'json', url: 'https://fx.test/latest', items: 'base', entries: true },
          fetch: { respectRobots: false },
        }),
        { http },
      ),
    ).rejects.toThrow(/not an object/);
    await expect(
      extract(
        spec({ source: { type: 'json', url: 'https://fx.test/bad' }, fetch: { respectRobots: false } }),
        { http },
      ),
    ).rejects.toThrow(/not valid JSON/);
  });

  test('html: items, attributes, regex, absolute URLs, all-matches and pagination', async () => {
    const page = (n: number, next?: string) => `<html><body>
      <article class="p"><h3><a href="b${n}.html" title="Book ${n}">B${n}</a></h3><p class="price">£5${n}.00</p><p class="star-rating Three"></p><span class="tag">a</span><span class="tag">b</span></article>
      ${next ? `<li class="next"><a href="${next}">next</a></li>` : ''}</body></html>`;
    const { http } = client({
      'https://books.test/cat/p1.html': { body: page(1, 'p2.html') },
      'https://books.test/cat/p2.html': { body: page(2) },
    });
    const s = spec({
      source: {
        type: 'html',
        url: 'https://books.test/cat/p1.html',
        itemSelector: 'article.p',
        next: { selector: 'li.next > a', maxPages: 5 },
      },
      fields: {
        title: { selector: 'h3 > a', attr: 'title', required: true },
        url: { selector: 'h3 > a', attr: 'href', type: 'url', transform: ['absoluteUrl'] },
        price: { selector: '.price', type: 'number', transform: ['number'] },
        rating: { selector: 'p.star-rating', attr: 'class', regex: 'star-rating (\\w+)' },
        tags: { selector: '.tag', all: true },
      },
      fetch: { respectRobots: false },
    });
    const res = await extract(s, { http });
    expect(res.pages).toBe(2);
    expect(res.records[0]).toEqual({
      title: 'Book 1',
      url: 'https://books.test/cat/b1.html',
      price: '51.00',
      rating: 'Three',
      tags: ['a', 'b'],
    });
    expect(res.records[1]!.url).toBe('https://books.test/cat/b2.html');
    const bare = await extract(
      spec({
        source: { type: 'html', url: 'https://books.test/cat/p2.html', itemSelector: 'h3 > a' },
        fetch: { respectRobots: false },
      }),
      { http },
    );
    expect(bare.records).toEqual([{ text: 'B2', href: 'https://books.test/cat/b2.html' }]);
  });

  test('rss and atom feeds normalize to common fields', async () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
      <item><title>One</title><link>https://n.test/1</link><guid>g1</guid><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate><description>Hello &amp; welcome</description><category>ai</category></item>
      <item><title>Two</title><link>https://n.test/2</link></item></channel></rss>`;
    const items = parseFeed(rss);
    expect(items[0]).toMatchObject({
      id: 'g1',
      title: 'One',
      link: 'https://n.test/1',
      summary: 'Hello & welcome',
      categories: ['ai'],
    });
    expect(items[1]).toMatchObject({ id: 'https://n.test/2', title: 'Two' });
    const atom = `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/1</id><title>  Deep
      Paper </title><link rel="alternate" href="http://arxiv.org/abs/1"/><link rel="related" href="http://arxiv.org/pdf/1"/><published>2026-10-22T00:00:00Z</published><summary>S</summary><author><name>A</name></author><author><name>B</name></author><category term="cs.AI"/></entry></feed>`;
    expect(parseFeed(atom)[0]).toMatchObject({
      id: 'http://arxiv.org/abs/1',
      title: 'Deep Paper',
      link: 'http://arxiv.org/abs/1',
      author: 'A, B',
      categories: ['cs.AI'],
    });
    expect(() => parseFeed('<html></html>')).toThrow(/not an RSS or Atom/);
    const { http } = client({
      'https://n.test/feed': { body: rss, headers: { 'content-type': 'application/rss+xml', etag: '"v1"' } },
    });
    const res = await extract(
      spec({
        source: { type: 'rss', url: 'https://n.test/feed', limit: 1 },
        fetch: { respectRobots: false },
      }),
      { http },
    );
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).not.toHaveProperty('raw');
    expect(res.validators?.etag).toBe('"v1"');
    const mapped = await extract(
      spec({
        source: { type: 'rss', url: 'https://n.test/feed' },
        fields: { t: { path: 'title' } },
        fetch: { respectRobots: false },
      }),
      { http },
    );
    expect(mapped.records).toEqual([{ t: 'One' }, { t: 'Two' }]);
  });

  test('sitemaps follow indexes and filter URLs', async () => {
    const index =
      '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://s.test/a.xml</loc></sitemap><sitemap><loc>https://s.test/b.xml</loc></sitemap></sitemapindex>';
    const a =
      '<urlset><url><loc>https://s.test/jobs/1</loc><lastmod>2026-10-01</lastmod></url><url><loc>https://s.test/about</loc></url></urlset>';
    const b = '<urlset><url><loc>https://s.test/jobs/2</loc></url></urlset>';
    expect(parseSitemap(a).urls).toHaveLength(2);
    const { http } = client({
      'https://s.test/sitemap.xml': { body: index },
      'https://s.test/a.xml': { body: a },
      'https://s.test/b.xml': { body: b },
    });
    const res = await extract(
      spec({
        source: { type: 'sitemap', url: 'https://s.test/sitemap.xml', include: '/jobs/' },
        fetch: { respectRobots: false },
      }),
      { http },
    );
    expect(res.records).toEqual([
      { url: 'https://s.test/jobs/1', lastmod: '2026-10-01' },
      { url: 'https://s.test/jobs/2', lastmod: undefined },
    ]);
    expect(res.pages).toBe(3);
  });

  test('conditional requests short-circuit on 304', async () => {
    const { http, calls } = client({ 'https://n.test/feed': () => ({ status: 304 }) });
    const res = await extract(
      spec({ source: { type: 'rss', url: 'https://n.test/feed' }, fetch: { respectRobots: false } }),
      { http, validators: { etag: '"v1"', lastModified: 'Fri, 23 Oct 2026 10:00:00 GMT' } },
    );
    expect(res.notModified).toBe(true);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['if-none-match']).toBe('"v1"');
    expect(headers['if-modified-since']).toMatch(/2026/);
  });

  test('mapFields passes plain objects through when no fields are configured', () => {
    expect(mapFields({ a: 1 }, {}, () => undefined, 'https://x')).toEqual({ a: 1 });
    expect(mapFields(5, {}, () => undefined, 'https://x')).toEqual({ value: 5 });
  });
});

describe('validation', () => {
  test.each([
    [{ type: 'number' }, '1,234.5', 1234.5],
    [{ type: 'integer' }, '42', 42],
    [{ type: 'boolean' }, 'yes', true],
    [{ type: 'boolean' }, 'N', false],
    [{ type: 'url' }, 'https://a.test/x', 'https://a.test/x'],
    [{ type: 'date' }, 'Fri, 23 Oct 2026 10:00:00 GMT', '2026-10-23T10:00:00.000Z'],
    [{ type: 'date' }, 1_761_216_000, '2025-10-23T10:40:00.000Z'],
    [{ type: 'string' }, { a: 1 }, '{"a":1}'],
    [{ type: 'json' }, { a: 1 }, { a: 1 }],
    [{ type: 'integer' }, ['1', '2'], [1, 2]],
  ])('coerce %j %j', (rule, input, expected) => {
    expect(coerce(input, { required: false, transform: [], ...rule } as never)).toEqual({
      ok: true,
      value: expected,
    });
  });

  test.each([
    [{ type: 'number' }, 'abc'],
    [{ type: 'integer' }, '1.5'],
    [{ type: 'boolean' }, 'maybe'],
    [{ type: 'url' }, '/relative'],
    [{ type: 'url' }, 'ftp://x.test/a'],
    [{ type: 'date' }, 'not a date'],
  ])('coerce %j rejects %j', (rule, input) => {
    expect(coerce(input, { required: false, transform: [], ...rule } as never).ok).toBe(false);
  });

  test('required, default and optional fields', () => {
    const s = spec({
      source: { type: 'rss', url: 'https://x.test' },
      fields: {
        id: { type: 'integer', required: true },
        n: { type: 'number', default: 0 },
        opt: { type: 'url' },
      },
    });
    const { valid, invalid } = validateRecords(s, [
      { id: '1', n: '', opt: 'bad url' },
      { n: 3 },
      { id: 'x' },
    ]);
    expect(valid).toEqual([{ id: 1, n: 0, opt: null }]);
    expect(invalid.map((i) => i.index)).toEqual([1, 2]);
    expect(invalid[0]!.errors[0]).toMatch(/required but missing/);
    expect(
      validateRecords(spec({ source: { type: 'rss', url: 'https://x.test' } }), [{ a: 1 }]).valid,
    ).toEqual([{ a: 1 }]);
  });
});

describe('PoliteHttpClient', () => {
  test('honors robots.txt disallow rules for its user agent', async () => {
    const { http } = client({
      'https://r.test/robots.txt': {
        body: 'User-agent: *\nDisallow: /private\nCrawl-delay: 3\n',
        headers: { 'content-type': 'text/plain' },
      },
      'https://r.test/public': { body: 'ok' },
    });
    await expect(http.get('https://r.test/private/x')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect((await http.get('https://r.test/public')).body).toBe('ok');
    expect(await http.robots.crawlDelayMs('https://r.test/public', UA)).toBe(3000);
  });

  test('missing robots.txt allows everything; an unreachable one disallows everything', async () => {
    const ok = client({ 'https://a.test/x': { body: 'fine' } });
    expect((await ok.http.get('https://a.test/x')).body).toBe('fine');
    const down = client({
      'https://b.test/robots.txt': { status: 503 },
      'https://b.test/x': { body: 'hidden' },
    });
    await expect(down.http.get('https://b.test/x')).rejects.toBeInstanceOf(RobotsDisallowedError);
  });

  test('retries 503 and 429 with backoff and Retry-After, but not 404', async () => {
    let n = 0;
    const { http, sleeps } = client({
      'https://c.test/flaky': (): FakeRoute =>
        n++ < 2
          ? { status: n === 1 ? 503 : 429, headers: n === 2 ? { 'retry-after': '7' } : undefined }
          : { body: 'finally' },
      'https://c.test/missing': { status: 404 },
    });
    expect((await http.get('https://c.test/flaky', { respectRobots: false })).body).toBe('finally');
    expect(sleeps).toEqual([500, 7000]);
    await expect(http.get('https://c.test/missing', { respectRobots: false })).rejects.toBeInstanceOf(
      HttpError,
    );
    let m = 0;
    const always = client({ 'https://c.test/down': () => (m++, { status: 500 }) });
    await expect(
      always.http.get('https://c.test/down', { respectRobots: false, retries: 2 }),
    ).rejects.toMatchObject({ status: 500 });
    expect(m).toBe(3);
  });

  test('network errors retry; blocked hosts do not', async () => {
    let n = 0;
    const flaky = new PoliteHttpClient({
      userAgent: UA,
      allowPrivateNetwork: true,
      sleep: async () => undefined,
      limiter: new HostRateLimiter(
        () => 0,
        async () => undefined,
      ),
      fetch: (async () => {
        if (n++ === 0) throw new TypeError('fetch failed');
        return new Response('ok');
      }) as typeof fetch,
    });
    expect((await flaky.get('https://d.test/', { respectRobots: false })).body).toBe('ok');
    const guarded = new PoliteHttpClient({ userAgent: UA, fetch: fakeFetch({}).fetch });
    await expect(guarded.get('http://127.0.0.1/admin', { respectRobots: false, retries: 3 })).rejects.toThrow(
      /private|internal|Refusing/,
    );
  });

  test('sends the honest user agent and follows redirects', async () => {
    const { http, calls } = client({
      'https://e.test/old': { status: 301, headers: { location: '/new' } },
      'https://e.test/new': { body: 'moved' },
    });
    const res = await http.get('https://e.test/old', { respectRobots: false });
    expect(res.finalUrl).toBe('https://e.test/new');
    expect((calls[0]!.init!.headers as Record<string, string>)['user-agent']).toBe(UA);
    expect(http.userAgent).toBe(UA);
  });

  test('decodeBody gunzips .gz bodies only', () => {
    expect(decodeBody(gzipSync(Buffer.from('<urlset/>')), 'https://x.test/sitemap.xml.gz')).toBe('<urlset/>');
    expect(decodeBody(Buffer.from('plain'), 'https://x.test/a.gz')).toBe('plain');
  });
});

describe('HostRateLimiter and RobotsCache', () => {
  test('spaces requests to the same host and serializes them', async () => {
    let now = 0;
    const waits: number[] = [];
    const limiter = new HostRateLimiter(
      () => now,
      async (ms) => {
        waits.push(ms);
        now += ms;
      },
    );
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((i) => limiter.schedule('h', 1000, async () => void order.push(i))));
    await limiter.schedule('other', 1000, async () => undefined);
    expect(order).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 1000]);
  });

  test('caches robots.txt per origin for the TTL', async () => {
    let fetches = 0;
    let now = 0;
    const cache = new RobotsCache(
      async () => (
        fetches++,
        { status: 200, body: 'User-agent: *\nDisallow: /x\nSitemap: https://h.test/s.xml' }
      ),
      1000,
      () => now,
    );
    expect(await cache.isAllowed('https://h.test/x/1', 'bot')).toBe(false);
    expect(await cache.isAllowed('https://h.test/y', 'bot')).toBe(true);
    expect(await cache.sitemaps('https://h.test/')).toEqual(['https://h.test/s.xml']);
    expect(await cache.isAllowed('https://h.test/robots.txt', 'bot')).toBe(true);
    expect(fetches).toBe(1);
    now = 2000;
    await cache.isAllowed('https://h.test/y', 'bot');
    expect(fetches).toBe(2);
    const broken = new RobotsCache(async () => Promise.reject(new Error('dns')));
    expect(await broken.isAllowed('https://z.test/', 'bot')).toBe(false);
    expect(await broken.crawlDelayMs('https://z.test/', 'bot')).toBeUndefined();
    expect(await broken.sitemaps('https://z.test/')).toEqual([]);
  });
});

describe('ScraperRunner', () => {
  const jsonSpec = () =>
    spec({
      source: { type: 'json', url: 'https://api.test/items' },
      fields: {
        id: { path: 'id', type: 'integer', required: true },
        title: { path: 'title', required: true },
      },
      key: 'id',
      validation: { minItems: 1, maxInvalidRatio: 0.4 },
      fetch: { respectRobots: false },
    });

  test('detects new and changed records across runs and appends them to the dataset', async () => {
    const dataDir = await tmpDir();
    let body: unknown = [
      { id: 1, title: 'a' },
      { id: 2, title: 'b' },
    ];
    const { http } = client({ 'https://api.test/items': () => ({ body: body as object }) });
    const runner = new ScraperRunner(http, dataDir, undefined, () => new Date('2026-10-24T12:00:00Z'));
    const r1 = await runner.run(jsonSpec());
    expect(r1).toMatchObject({
      ok: true,
      fetched: 2,
      valid: 2,
      new: 2,
      changed: 0,
      written: 2,
      datasetFile: 'datasets/test-scraper/2026-10-24.jsonl',
    });
    body = [
      { id: 1, title: 'a' },
      { id: 2, title: 'B!' },
      { id: 3, title: 'c' },
    ];
    const r2 = await runner.run(jsonSpec());
    expect(r2).toMatchObject({ new: 1, changed: 1, written: 2 });
    const lines = (await fsp.readFile(path.join(dataDir, r2.datasetFile!), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatchObject({
      id: 2,
      title: 'B!',
      _change: 'changed',
      _key: '2',
      _scraper: 'test-scraper',
    });
    const state = await runner.state('test-scraper');
    expect(state).toMatchObject({ consecutiveFailures: 0, lastValidCount: 3 });
    expect(state.history).toHaveLength(2);
    expect(formatScrapeReport(r2)).toMatch(
      /^OK scraper test-scraper: 3 fetched, 3 valid, 0 invalid, 1 new, 1 changed, 2 written/,
    );
  });

  test('dry runs write nothing and do not touch state', async () => {
    const dataDir = await tmpDir();
    const { http } = client({ 'https://api.test/items': { body: [{ id: 1, title: 'a' }] } });
    const runner = new ScraperRunner(http, dataDir);
    const r = await runner.run(jsonSpec(), { dryRun: true });
    expect(r).toMatchObject({ ok: true, dryRun: true, written: 0, new: 1 });
    expect(r.sample).toHaveLength(1);
    await expect(fsp.access(path.join(dataDir, 'datasets'))).rejects.toThrow();
    expect((await runner.state('test-scraper')).history).toEqual([]);
  });

  test('flags breakage: zero items after a good run, invalid spikes and errors', async () => {
    const dataDir = await tmpDir();
    let body: unknown = [{ id: 1, title: 'a' }];
    let status = 200;
    const { http } = client({ 'https://api.test/items': () => ({ status, body: body as object }) });
    const runner = new ScraperRunner(http, dataDir);
    await runner.run(jsonSpec());
    body = [];
    const empty = await runner.run(jsonSpec());
    expect(empty.ok).toBe(false);
    expect(empty.issues[0]).toMatch(/zero valid items \(last run had 1\)/);
    body = [{ id: 'x' }, { id: 'y' }, { id: 5, title: 'ok' }];
    const drift = await runner.run(jsonSpec());
    expect(drift.issues.join(' ')).toMatch(/67% of records failed validation/);
    expect(drift.invalidSamples[0]).toMatch(/^#0: id/);
    status = 404;
    const failed = await runner.run(jsonSpec());
    expect(failed).toMatchObject({
      ok: false,
      consecutiveFailures: 3,
      error: expect.stringMatching(/HTTP 404/),
    });
    status = 200;
    body = [{ id: 9, title: 'back' }];
    expect((await runner.run(jsonSpec())).consecutiveFailures).toBe(0);
  });

  test('custom TypeScript scrapers share the runner', async () => {
    const dataDir = await tmpDir();
    const runner = new ScraperRunner(client({}).http, dataDir);
    const s = spec({ source: { type: 'json', url: 'https://unused.test/' }, key: 'k' });
    const report = await runner.run(s, {
      custom: { spec: s, fetch: async () => ({ records: [{ k: 'a', v: 1 }], pages: 2 }) },
    });
    expect(report).toMatchObject({ ok: true, pages: 2, new: 1, written: 1 });
  });
});

describe('ScraperRegistry', () => {
  test('loads specs, runs them with a re-entrancy guard and lists them', async () => {
    const dir = await tmpDir();
    await writeFiles(dir, {
      'one.yaml':
        'name: one\ndescription: first\nschedule: "5 * * * *"\nsource: { type: json, url: "https://api.test/one" }\nfetch: { respectRobots: false }\n',
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const ff = fakeFetch({ 'https://api.test/one': { body: [{ a: 1 }] } });
    const slowFetch = (async (url: string, init?: RequestInit) => {
      await gate;
      return ff.fetch(url, init);
    }) as typeof fetch;
    const http = new PoliteHttpClient({
      userAgent: UA,
      fetch: slowFetch,
      allowPrivateNetwork: true,
      limiter: new HostRateLimiter(
        () => 0,
        async () => undefined,
      ),
    });
    const reg = new ScraperRegistry(new ScraperRunner(http, await tmpDir()), dir);
    await reg.reload([]);
    expect(reg.list()).toEqual([{ name: 'one', description: 'first', schedule: '5 * * * *', enabled: true }]);
    const first = reg.runReport('one');
    expect(reg.isRunning('one')).toBe(true);
    await expect(reg.runReport('one')).rejects.toThrow(/already running/);
    release();
    expect((await first).ok).toBe(true);
    expect(await reg.run('one', { dryRun: true })).toMatch(/^OK scraper one \(dry run\)/);
    await expect(reg.runReport('ghost')).rejects.toThrow(/unknown scraper/);
    expect((await reg.state('one')).history.length).toBe(1);
    const custom = parseScraperSpec({ name: 'custom', source: { type: 'json', url: 'https://x.test' } });
    await reg.reload([{ spec: custom, fetch: async () => ({ records: [] }) }]);
    expect(reg.get('custom')).toBeDefined();
    await expect(
      reg.reload([
        {
          spec: parseScraperSpec({ name: 'one', source: { type: 'json', url: 'https://x.test' } }),
          fetch: async () => ({ records: [] }),
        },
      ]),
    ).rejects.toThrow(/collides/);
  });
});
