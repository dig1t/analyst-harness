import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { listDatasets, loadDataSource } from '../../src/dashboards/data-loader';
import { explorerSlug, explorerSpec } from '../../src/dashboards/explorer';
import { escapeHtml, renderMarkdown } from '../../src/dashboards/markdown';
import { dashboardNotebook } from '../../src/dashboards/notebook';
import {
  type buildPayload,
  DashboardTooLargeError,
  renderDashboardFragment,
  renderDashboardHtml,
} from '../../src/dashboards/render';
import { DashboardBuildError, DashboardService } from '../../src/dashboards/service';
import { parseDashboardSpec, slugify } from '../../src/dashboards/spec';
import { formatIssues, resolveSpec } from '../../src/dashboards/validate';
import { Workspace } from '../../src/safety/workspace';
import type { SqlService } from '../../src/tools/types';
import { tmpDir, writeFiles } from '../helpers';

const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const RELEASES = Array.from({ length: 40 }, (_, i) => ({
  package: ['requests', 'httpx', 'lxml'][i % 3],
  released_at: new Date(Date.UTC(2026, 0, 1 + i * 7)).toISOString(),
  size: 1000 * (i + 1),
  wheel: i % 2 === 0,
  url: `https://pypi.org/project/x/${i}`,
  _hash: 'h',
}));

async function setup(extra: Record<string, string> = {}) {
  const root = await tmpDir('harness-dash-');
  await writeFiles(root, {
    'data/datasets/releases/2026-10-24.jsonl': jsonl(RELEASES.slice(0, 25)),
    'data/datasets/releases/2026-10-25.jsonl': jsonl(RELEASES.slice(25)),
    'data/workspace/reports/sales.csv': 'region,amount,closed\nNorth,10,2026-01-03\nSouth,32.5,2026-02-10\n',
    ...extra,
  });
  const dirs = {
    data: path.join(root, 'data'),
    datasets: path.join(root, 'data/datasets'),
    workspace: path.join(root, 'data/workspace'),
    dashboards: path.join(root, 'data/dashboards'),
  };
  const workspace = () =>
    new Workspace([
      { alias: '', dir: dirs.workspace, mode: 'rw' },
      { alias: 'datasets', dir: dirs.datasets, mode: 'ro' },
    ]);
  const service = (o: { sql?: SqlService; publicUrl?: string; maxBytes?: number } = {}) =>
    new DashboardService({
      dir: dirs.dashboards,
      datasetsDir: dirs.datasets,
      dataDir: dirs.data,
      workspaceDir: dirs.workspace,
      defaultWorkspace: workspace,
      describeDataset: (n) => (n === 'releases' ? 'PyPI releases' : undefined),
      ...o,
    });
  return { root, dirs, workspace, service };
}

const SPEC = {
  title: 'Release board',
  data: { rel: { dataset: 'releases', columns: { size: { label: 'Size', format: 'bytes' } } } },
  filters: [
    { type: 'daterange', field: 'released_at' },
    { type: 'select', field: 'package' },
  ],
  items: [
    { type: 'kpi', title: 'Releases', value: 'count', delta: { field: 'released_at', period: '30d' } },
    {
      type: 'line',
      x: { field: 'released_at', interval: 'month' },
      y: 'count',
      series: { field: 'package' },
    },
    { type: 'bar', x: { field: 'package' }, y: 'sum(size)' },
    { type: 'table', columns: ['package', { field: 'url', link: 'url' }, { field: 'size', bar: true }] },
    { type: 'markdown', text: 'Read **this** first.' },
  ],
};

describe('dashboard specs', () => {
  test('parse shorthand aggregates and a flat items list', () => {
    const spec = parseDashboardSpec(SPEC);
    expect(spec.sections).toHaveLength(1);
    const items = spec.sections[0]!.items;
    expect(items[0]).toMatchObject({ type: 'kpi', value: { agg: 'count' } });
    expect(items[2]).toMatchObject({ type: 'bar', y: { agg: 'sum', field: 'size' } });
    expect(spec.refresh).toBe('on-new-data');
    expect(slugify('Ventas: Año 2026!')).toBe('ventas-ano-2026');
    expect(slugify('***')).toBe('dashboard');
  });

  test('the example shipped with the build-dashboard skill parses', async () => {
    const file = path.resolve(
      __dirname,
      '../../skills/harness/build-dashboard/examples/release-tracker.yaml',
    );
    const spec = parseDashboardSpec(YAML.parse(await fsp.readFile(file, 'utf8')));
    expect(spec.sections.flatMap((s) => s.items.map((i) => i.type))).toEqual(
      expect.arrayContaining(['kpi', 'area', 'facets', 'bar', 'histogram', 'scatter', 'table', 'markdown']),
    );
  });

  test('explain mistakes in words an agent can act on', () => {
    const bad = (patch: object) => () => parseDashboardSpec({ ...SPEC, ...patch });
    expect(bad({ items: [{ type: 'donut', value: 'count' }] })).toThrow(
      /unknown component type "donut"; use one of kpi, line/,
    );
    expect(bad({ items: [{ type: 'kpi', value: 'sum' }] })).toThrow(/this aggregate needs a field/);
    expect(bad({ items: [{ type: 'kpi', value: 'count', format: 'dollars' }] })).toThrow(/unknown format/);
    expect(bad({ data: { a: { dataset: 'x', file: 'y.csv' } } })).toThrow(/exactly one of sql, dataset/);
    expect(bad({ data: {} })).toThrow(/between 1 and 20 data sources/);
    expect(() => parseDashboardSpec({ title: 'x' })).toThrow(/Invalid dashboard spec/);
  });
});

describe('data loading', () => {
  test('reads the newest rows of a scraped dataset, drops _hash and infers types', async () => {
    const { dirs, workspace } = await setup();
    const ctx = { workspace: workspace(), datasetsDir: dirs.datasets, runId: 'r1' };
    const d = await loadDataSource('rel', { dataset: 'releases', limit: 30 }, ctx);
    expect(d.rows).toHaveLength(30);
    expect(d).toMatchObject({ totalRows: 40, truncated: true, dependsOn: ['releases'] });
    // Newest 30 rows, still in chronological order.
    expect(d.rows[0]!.released_at).toBe(RELEASES[10]!.released_at);
    expect(d.rows.at(-1)!.released_at).toBe(RELEASES[39]!.released_at);
    expect(d.columns.find((c) => c.name === '_hash')).toBeUndefined();
    const types = Object.fromEntries(d.columns.map((c) => [c.name, c.type]));
    expect(types).toMatchObject({ released_at: 'datetime', size: 'integer', wheel: 'boolean', url: 'url' });
    expect(await listDatasets(dirs.datasets)).toEqual(['releases']);
    await expect(loadDataSource('x', { dataset: 'nope', limit: 10 }, ctx)).rejects.toThrow(
      'no dataset "nope" (known datasets: releases)',
    );
    await expect(loadDataSource('x', { dataset: '../etc', limit: 10 }, ctx)).rejects.toThrow(
      'invalid dataset name',
    );
  });

  test('reads workspace files, inline values and SQL', async () => {
    const { dirs, workspace } = await setup({
      'data/workspace/a.json': JSON.stringify({ rows: [{ k: 1 }, { k: 2 }] }),
      'data/workspace/b.jsonl': '{"k": 1}\nnot json\n',
      'data/workspace/c.txt': 'x',
    });
    const ctx = { workspace: workspace(), datasetsDir: dirs.datasets, runId: 'r1' };
    const csv = await loadDataSource('s', { file: 'reports/sales.csv', limit: 100 }, ctx);
    expect(csv.rows).toEqual([
      { region: 'North', amount: 10, closed: '2026-01-03' },
      { region: 'South', amount: 32.5, closed: '2026-02-10' },
    ]);
    expect(csv.columns.map((c) => c.type)).toEqual(['string', 'number', 'date']);
    expect((await loadDataSource('a', { file: 'a.json', limit: 100 }, ctx)).rows).toHaveLength(2);
    await expect(loadDataSource('b', { file: 'b.jsonl', limit: 100 }, ctx)).rejects.toThrow(
      'b.jsonl line 2 is not valid JSON',
    );
    await expect(loadDataSource('c', { file: 'c.txt', limit: 100 }, ctx)).rejects.toThrow(
      'unsupported file type .txt',
    );
    await expect(loadDataSource('m', { file: 'missing.csv', limit: 100 }, ctx)).rejects.toThrow(
      'file not found',
    );
    const v = await loadDataSource('v', { values: [{ a: 1 }, { a: 2 }, { a: 3 }], limit: 2 }, ctx);
    expect(v).toMatchObject({ totalRows: 3, truncated: true, source: { kind: 'values' } });
    await expect(loadDataSource('q', { sql: 'SELECT 1', limit: 10 }, ctx)).rejects.toThrow(
      'DuckDB is not available',
    );
    const sql: SqlService = {
      query: async () => '',
      queryRows: async (q, max) => ({ columns: ['n'], rows: [{ n: 1 }, { n: 2 }].slice(0, max), total: 2 }),
    };
    const q = await loadDataSource(
      'q',
      { sql: "SELECT * FROM read_json_auto('datasets/releases/*.jsonl')", limit: 10 },
      { ...ctx, sql },
    );
    expect(q).toMatchObject({ rows: [{ n: 1 }, { n: 2 }], dependsOn: ['releases'], source: { kind: 'sql' } });
  });
});

describe('validation against the data', () => {
  test('unknown fields, wrong types, ambiguous data and defaults', async () => {
    const { dirs, workspace } = await setup();
    const ctx = { workspace: workspace(), datasetsDir: dirs.datasets, runId: 'r1' };
    const rel = await loadDataSource('rel', { dataset: 'releases', limit: 100 }, ctx);
    const sales = await loadDataSource('sales', { file: 'reports/sales.csv', limit: 100 }, ctx);
    const one = new Map([['rel', rel]]);
    const ok = resolveSpec({ ...parseDashboardSpec(SPEC), slug: 'b' }, one);
    expect(ok.issues).toEqual([]);
    expect(ok.spec.sections[0]!.items.map((i) => [i.id, i.data, i.width])).toEqual([
      ['kpi-1-1', 'rel', 3],
      ['line-1-2', 'rel', 12],
      ['bar-1-3', 'rel', 6],
      ['table-1-4', 'rel', 12],
      ['markdown-1-5', '', 12],
    ]);
    expect(ok.spec.filters.map((f) => [f.id, f.datasets])).toEqual([
      ['filter-1', ['rel']],
      ['filter-2', ['rel']],
    ]);

    const broken = parseDashboardSpec({
      title: 'x',
      data: { rel: { dataset: 'releases' }, sales: { file: 'reports/sales.csv' } },
      filters: [{ type: 'daterange', field: 'package', data: 'rel' }],
      items: [
        { type: 'kpi', value: 'mean(package)', data: 'rel' },
        { type: 'histogram', field: 'size' },
        { type: 'bar', x: { field: 'nope' }, y: 'count', data: 'rel' },
        { type: 'kpi', value: 'count', hero: true, data: 'sales' },
        { type: 'kpi', value: 'count', hero: true, data: 'sales' },
        {
          type: 'scatter',
          x: { field: 'size' },
          y: { field: 'size' },
          series: { field: 'package', top: 6 },
          data: 'rel',
        },
        { type: 'kpi', value: 'sum(wheel)', data: 'rel' },
      ],
    });
    const two = new Map([
      ['rel', rel],
      ['sales', sales],
    ]);
    const { issues, spec } = resolveSpec({ ...broken, slug: 'x' }, two);
    const text = formatIssues(issues);
    expect(text).toContain('value.field "package" is string; it must be numeric for mean');
    expect(text).toContain('set "data" to one of: rel, sales');
    expect(text).toContain('x.field "nope" is not a column of "rel"; columns: package (string)');
    expect(text).toContain('only one hero figure per view');
    expect(text).toContain('scatter plots show at most 3 series');
    expect(text).toContain('"package" in "rel" is string, not a date');
    // A yes/no column sums to a count of "yes".
    expect(text).not.toContain('sum(wheel)');
    expect(issues.filter((i) => i.level === 'error')).toHaveLength(4);
    const items = spec.sections[0]!.items;
    expect((items[4] as { hero: boolean }).hero).toBe(false);
    expect((items[5] as { series: { top: number } }).series.top).toBe(3);
  });
});

describe('markdown notes', () => {
  test('a safe subset: escaped text, http(s) links only, code, lists and tables', () => {
    const html = renderMarkdown(
      [
        '## Notes <script>alert(1)</script>',
        'Use **bold**, *em*, `a<b` and [docs](https://example.com/?a=1&b=2) [x](javascript:alert(1)).',
        '',
        '- one',
        '- two',
        '',
        '| a | b |',
        '|---|--:|',
        '| 1 | 2 |',
        '',
        '```',
        '<b>raw</b>',
        '```',
        '> quoted',
      ].join('\n'),
    );
    expect(html).toContain('<h4>Notes &lt;script&gt;alert(1)&lt;/script&gt;</h4>');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>em</em>');
    expect(html).toContain('<code>a&lt;b</code>');
    expect(html).toContain(
      '<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(html).toContain('[x](javascript:alert(1))');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<td style="text-align:right">2</td>');
    expect(html).toContain('<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>');
    expect(html).toContain('<blockquote><p>quoted</p></blockquote>');
    // Text cannot forge the placeholder used for code spans.
    expect(renderMarkdown('a \ue0000\ue000 b')).toBe('<p>a 0 b</p>');
    expect(escapeHtml(`<a href="x">'&`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
  });
});

describe('rendering', () => {
  test('one self-contained page: CSP, escaped payload, no way out of the data script', async () => {
    const { dirs, workspace } = await setup();
    const ctx = { workspace: workspace(), datasetsDir: dirs.datasets, runId: 'r1' };
    const evil = await loadDataSource(
      'rel',
      { values: [{ name: '</script><script>alert(1)</script>', note: '\u2028' }], limit: 10 },
      ctx,
    );
    const spec = parseDashboardSpec({
      title: 'Evil <b>title</b>',
      data: { rel: { values: [{ a: 1 }] } },
      items: [{ type: 'table' }, { type: 'markdown', text: '<img src=x onerror=alert(1)>' }],
    });
    const { spec: resolved } = resolveSpec({ ...spec, slug: 'evil' }, new Map([['rel', evil]]));
    const html = await renderDashboardHtml(resolved, [evil], { runId: 'run_1' });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta http-equiv="Content-Security-Policy" content="default-src \'none\'');
    expect(html).toContain('<title>Evil &lt;b&gt;title&lt;/b&gt;</title>');
    const data = html.slice(
      html.indexOf('id="hx-data">'),
      html.indexOf('</script>', html.indexOf('id="hx-data">')),
    );
    expect(data).not.toContain('<');
    expect(data).toContain('\\u003c/script\\u003e');
    expect(data).not.toContain('\u2028');
    // The payload still parses back to the original values.
    const payload = JSON.parse(data.slice('id="hx-data">'.length)) as ReturnType<typeof buildPayload>;
    expect(payload.datasets[0]!.rows).toBeDefined();
    expect(payload.meta).toMatchObject({ mode: 'standalone', runId: 'run_1', generator: 'analyst-harness' });
    const md = payload.spec.sections[0]!.items[1] as { html: string };
    expect(md.html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
    // The bundle never closes its own script tag early.
    const scripts = html.match(/<\/script>/g) ?? [];
    expect(scripts).toHaveLength(2);

    const fragment = await renderDashboardFragment(resolved, [evil]);
    expect(fragment.startsWith('<title>')).toBe(true);
    expect(fragment).toContain('<meta name="claude:viewport-fit-sides" content="cover">');
    expect(fragment).not.toContain('<!doctype');
    expect(fragment).toContain('"mode":"embedded"');

    await expect(renderDashboardHtml(resolved, [evil], { maxBytes: 1000 })).rejects.toBeInstanceOf(
      DashboardTooLargeError,
    );
  });

  test('the notebook reloads every source with pandas or DuckDB', () => {
    const spec = parseDashboardSpec({
      title: 'Nb',
      data: {
        rel: { dataset: 'releases' },
        q: { sql: 'SELECT 1 AS n' },
        f: { file: 'reports/sales.csv' },
        v: { values: [{ a: 1 }] },
      },
      items: [{ type: 'markdown', text: 'x' }],
    });
    const nb = JSON.parse(dashboardNotebook(spec, '/srv/data', '/srv/data/workspace')) as {
      nbformat: number;
      cells: Array<{ cell_type: string; source: string[] }>;
    };
    expect(nb.nbformat).toBe(4);
    const src = nb.cells.map((c) => c.source.join('')).join('\n');
    expect(src).toContain('HARNESS_DATA = Path("/srv/data")');
    expect(src).toContain('(DATASETS / "releases").glob');
    expect(src).toContain('SELECT 1 AS n');
    expect(src).toContain('reports/sales.csv');
  });
});

describe('DashboardService', () => {
  test('builds, lists, serves file paths, profiles and removes dashboards', async () => {
    const { dirs, service, workspace } = await setup();
    const svc = service({ publicUrl: 'https://h.example/' });
    const built = await svc.build(SPEC, { source: 'cli' });
    expect(built.meta).toMatchObject({
      slug: 'release-board',
      title: 'Release board',
      dependsOn: ['releases'],
      refresh: 'on-new-data',
      source: 'cli',
      datasets: [{ name: 'rel', rows: 40, totalRows: 40 }],
    });
    expect(built.url).toBe('https://h.example/dashboards/release-board/');
    for (const f of ['index.html', 'spec.json', 'notebook.ipynb', 'meta.json'])
      await expect(fsp.stat(path.join(dirs.dashboards, 'release-board', f))).resolves.toBeTruthy();
    const catalog = await fsp.readFile(svc.catalogPath(), 'utf8');
    expect(catalog).toContain('<a href="release-board/">Release board</a>');
    expect(catalog).toContain('<td>PyPI releases</td>');
    expect(DashboardService.summary(built, 'dashboards/release-board/index.html')).toContain(
      'URL: https://h.example/dashboards/release-board/',
    );
    expect((await svc.list()).map((m) => m.slug)).toEqual(['release-board']);
    expect(svc.filePath('release-board', 'notebook.ipynb')).toBe(
      path.join(dirs.dashboards, 'release-board', 'notebook.ipynb'),
    );
    expect(svc.filePath('release-board', '../../secret')).toBeNull();
    expect(svc.filePath('../etc', 'index.html')).toBeNull();
    expect(await svc.get('../x')).toBeNull();

    const profile = await svc.profile({ dataset: 'releases' }, { workspace: workspace(), runId: 'r' });
    expect(profile).toContain('Dataset releases: 40 rows');
    expect(profile).toContain('- time axis: released_at');
    expect(profile).toContain('- measures: size');
    expect(profile).toContain('categories with few values: package, wheel');
    expect(profile).toContain('Sample rows:');
    await expect(svc.profile({}, { workspace: workspace(), runId: 'r' })).rejects.toThrow(
      'exactly one of dataset, sql or file',
    );

    expect(await svc.remove('release-board')).toBe(true);
    expect(await svc.remove('release-board')).toBe(false);
    expect(await svc.list()).toEqual([]);
  });

  test('build problems come back as one readable DashboardBuildError', async () => {
    const { service } = await setup();
    const svc = service();
    await expect(svc.build('title: [unclosed')).rejects.toThrow(/not valid YAML or JSON/);
    const err = await svc
      .build({ ...SPEC, items: [{ type: 'bar', x: { field: 'nope' }, y: 'count' }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DashboardBuildError);
    expect((err as Error).message).toContain(
      'The dashboard was not built:\n- Error: sections[0].items[0] (bar)',
    );
    await expect(svc.build({ ...SPEC, data: { rel: { dataset: 'missing' } } })).rejects.toThrow(
      /data\.rel: no dataset "missing"/,
    );
    await expect(service({ maxBytes: 2000 }).build(SPEC)).rejects.toThrow(/aggregate in SQL/);
  });

  test('refreshFor rebuilds on-new-data dashboards of a dataset; explore names its slug safely', async () => {
    const { service, dirs } = await setup({
      'data/datasets/ecb_rates/2026-10-25.jsonl': jsonl([
        { date: '2026-10-24', currency: 'USD', rate: 1.16 },
        { date: '2026-10-24', currency: 'JPY', rate: 176.2 },
      ]),
    });
    const svc = service();
    await svc.build(SPEC);
    await svc.build({ ...SPEC, title: 'Manual one', refresh: 'manual' });
    const before = (await svc.get('release-board'))!.builtAt;
    await new Promise((r) => setTimeout(r, 5));
    expect(await svc.refreshFor(['releases'])).toEqual(['release-board']);
    expect((await svc.get('release-board'))!.builtAt > before).toBe(true);
    expect(await svc.refreshFor(['other'])).toEqual([]);

    expect(explorerSlug('ecb_rates')).toBe('explore-ecb-rates');
    const ex = await svc.explore('ecb_rates');
    expect(ex.meta).toMatchObject({ slug: 'explore-ecb-rates', source: 'explore', dependsOn: ['ecb_rates'] });
    const catalog = await fsp.readFile(path.join(dirs.dashboards, 'index.html'), 'utf8');
    expect(catalog).toContain('<a href="explore-ecb-rates/">ecb_rates</a>');
    await expect(svc.explore('nope')).rejects.toThrow('no dataset "nope"');
  });

  test('explorer specs pick components from the column types', () => {
    const spec = explorerSpec({
      dataset: 'releases',
      columns: [
        { name: 'released_at', type: 'datetime' },
        { name: 'package', type: 'string' },
        { name: 'size', type: 'integer' },
        { name: 'url', type: 'url' },
      ],
      rows: RELEASES.map(({ _hash, ...r }) => r),
    });
    const types = (spec.sections ?? []).flatMap((s) => s.items.map((i) => i.type));
    expect(types).toEqual(expect.arrayContaining(['kpi', 'table', 'facets', 'histogram', 'profile']));
    expect(types.some((t) => t === 'line' || t === 'area')).toBe(true);
    expect(spec.filters?.map((f) => f.type)).toEqual(['daterange', 'search']);
    // Readable labels, with the unit left to the format.
    expect(spec.data.releases!.columns).toMatchObject({
      released_at: { label: 'Released at' },
      size: { label: 'Size' },
    });
    expect(() => parseDashboardSpec(spec)).not.toThrow();
  });
});
