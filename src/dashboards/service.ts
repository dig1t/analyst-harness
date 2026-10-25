import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type { Workspace } from '../safety/workspace';
import type { SqlService } from '../tools/types';
import { ToolError, errorMessage } from '../util/errors';
import { ensureDir, readJson, writeTextAtomic } from '../util/fs';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import { markdownTable } from '../util/text';
import { loadUiAssets } from './assets';
import { describeProfile, isNumericType, isTimeType, profileColumn } from './core/infer';
import { listDatasets, loadDataSource, type LoadedDataset } from './data-loader';
import { explorerSpec } from './explorer';
import { escapeHtml } from './markdown';
import { dashboardNotebook } from './notebook';
import { DashboardTooLargeError, DASHBOARD_CSP, renderDashboardHtml } from './render';
import { parseDashboardSpec, slugify, type DashboardSpec } from './spec';
import { formatIssues, resolveSpec, type BuildIssue } from './validate';

export interface DashboardMeta {
  slug: string;
  title: string;
  description?: string;
  builtAt: string;
  runId?: string;
  bytes: number;
  datasets: Array<{ name: string; rows: number; totalRows: number; columns: number }>;
  dependsOn: string[];
  refresh: 'on-new-data' | 'manual';
  warnings: string[];
  source: 'agent' | 'cli' | 'explore' | 'refresh' | 'api';
}

export interface BuildResult {
  meta: DashboardMeta;
  /** Absolute path of index.html. */
  path: string;
  url?: string;
  issues: BuildIssue[];
}

export interface DashboardServiceOptions {
  /** Where dashboards are written: <dir>/<slug>/index.html. */
  dir: string;
  datasetsDir: string;
  /** For the notebook's paths. */
  dataDir: string;
  workspaceDir: string;
  sql?: SqlService;
  logger?: Logger;
  /** Base URL that serves /dashboards/ (for links in Discord and tool results). */
  publicUrl?: string;
  maxBytes?: number;
  /** Workspace for builds outside an agent run (CLI, refresh after a scrape). */
  defaultWorkspace: () => Workspace;
  /** Scraper descriptions, used by explorer dashboards. */
  describeDataset?: (name: string) => string | undefined;
}

/** A build problem the author can fix; tools report it to the model instead of failing the run. */
export class DashboardBuildError extends ToolError {}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const DASHBOARD_FILES = ['index.html', 'notebook.ipynb', 'spec.json', 'meta.json'] as const;

export class DashboardService {
  private readonly logger: Logger;
  private readonly building = new Map<string, Promise<BuildResult>>();

  constructor(private readonly opts: DashboardServiceOptions) {
    this.logger = opts.logger ?? silentLogger;
  }

  url(slug: string): string | undefined {
    return this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/+$/, '')}/dashboards/${slug}/` : undefined;
  }

  filePath(slug: string, file: string = 'index.html'): string | null {
    if (!SLUG_RE.test(slug) || !(DASHBOARD_FILES as readonly string[]).includes(file)) return null;
    return path.join(this.opts.dir, slug, file);
  }

  /** Parse (YAML text or an object), load data, validate against it, render and write. */
  async build(
    input: unknown,
    opts: { runId?: string; workspace?: Workspace; source?: DashboardMeta['source'] } = {},
  ): Promise<BuildResult> {
    let raw = input;
    if (typeof raw === 'string') {
      try {
        raw = YAML.parse(raw) as unknown;
      } catch (err) {
        throw new DashboardBuildError(`The dashboard spec is not valid YAML or JSON: ${errorMessage(err)}`);
      }
    }
    let spec: DashboardSpec;
    try {
      spec = parseDashboardSpec(raw);
    } catch (err) {
      throw new DashboardBuildError(errorMessage(err));
    }
    const slug = spec.slug ?? slugify(spec.title);
    const pending = this.building.get(slug);
    if (pending) await pending.catch(() => undefined);
    const job = this.doBuild(spec, slug, raw, opts);
    this.building.set(slug, job);
    try {
      return await job;
    } finally {
      if (this.building.get(slug) === job) this.building.delete(slug);
    }
  }

  private async doBuild(
    spec: DashboardSpec,
    slug: string,
    raw: unknown,
    opts: { runId?: string; workspace?: Workspace; source?: DashboardMeta['source'] },
  ): Promise<BuildResult> {
    const ownRun = !opts.runId;
    const runId = opts.runId ?? `dashboard-${slug}-${Date.now()}`;
    const workspace = opts.workspace ?? this.opts.defaultWorkspace();
    const issues: BuildIssue[] = [];
    const loaded = new Map<string, LoadedDataset>();
    try {
      for (const [name, src] of Object.entries(spec.data)) {
        try {
          loaded.set(
            name,
            await loadDataSource(name, src, {
              workspace,
              datasetsDir: this.opts.datasetsDir,
              sql: this.opts.sql,
              runId,
            }),
          );
        } catch (err) {
          issues.push({ level: 'error', where: `data.${name}`, message: errorMessage(err) });
        }
      }
    } finally {
      if (ownRun) this.opts.sql?.release?.(runId);
    }
    if (issues.some((i) => i.level === 'error'))
      throw new DashboardBuildError(`The dashboard was not built:\n${formatIssues(issues)}`);
    const resolved = resolveSpec({ ...spec, slug }, loaded);
    issues.push(...resolved.issues);
    if (issues.some((i) => i.level === 'error'))
      throw new DashboardBuildError(`The dashboard was not built:\n${formatIssues(issues)}`);
    let html: string;
    try {
      html = await renderDashboardHtml(resolved.spec, [...loaded.values()], {
        mode: 'standalone',
        runId: opts.runId,
        notebook: 'notebook.ipynb',
        maxBytes: this.opts.maxBytes,
      });
    } catch (err) {
      if (err instanceof DashboardTooLargeError)
        throw new DashboardBuildError(`The dashboard was not built: ${err.message}`);
      throw err;
    }
    const dir = path.join(this.opts.dir, slug);
    await ensureDir(dir);
    const datasets = [...loaded.values()];
    const meta: DashboardMeta = {
      slug,
      title: spec.title,
      description: spec.description,
      builtAt: new Date().toISOString(),
      runId: opts.runId,
      bytes: Buffer.byteLength(html),
      datasets: datasets.map((d) => ({
        name: d.name,
        rows: d.rows.length,
        totalRows: d.totalRows,
        columns: d.columns.length,
      })),
      dependsOn: [...new Set(datasets.flatMap((d) => d.dependsOn))],
      refresh: spec.refresh,
      warnings: issues.filter((i) => i.level === 'warning').map((i) => `${i.where}: ${i.message}`),
      source: opts.source ?? (opts.runId ? 'agent' : 'cli'),
    };
    await writeTextAtomic(path.join(dir, 'index.html'), html);
    await writeTextAtomic(path.join(dir, 'spec.json'), JSON.stringify(raw, null, 2));
    await writeTextAtomic(
      path.join(dir, 'notebook.ipynb'),
      dashboardNotebook(spec, this.opts.dataDir, this.opts.workspaceDir),
    );
    await writeTextAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    await this.writeIndex().catch((err) => this.logger.warn('dashboard index not written', { err }));
    this.logger.info('dashboard built', { slug, bytes: meta.bytes, datasets: meta.datasets.length });
    return { meta, path: path.join(dir, 'index.html'), url: this.url(slug), issues };
  }

  async list(): Promise<DashboardMeta[]> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.opts.dir);
    } catch {
      return [];
    }
    const metas: DashboardMeta[] = [];
    for (const e of entries) {
      if (!SLUG_RE.test(e)) continue;
      const m = await readJson<DashboardMeta | null>(path.join(this.opts.dir, e, 'meta.json'), null);
      if (m) metas.push(m);
    }
    return metas.sort((a, b) => b.builtAt.localeCompare(a.builtAt));
  }

  async get(slug: string): Promise<DashboardMeta | null> {
    if (!SLUG_RE.test(slug)) return null;
    return readJson<DashboardMeta | null>(path.join(this.opts.dir, slug, 'meta.json'), null);
  }

  async remove(slug: string): Promise<boolean> {
    if (!(await this.get(slug))) return false;
    await fsp.rm(path.join(this.opts.dir, slug), { recursive: true, force: true });
    await this.writeIndex();
    return true;
  }

  /** Build (or rebuild) the explorer dashboard for a scraped dataset. */
  async explore(dataset: string, opts: { runId?: string } = {}): Promise<BuildResult> {
    const workspace = this.opts.defaultWorkspace();
    const runId = `explore-${dataset}-${Date.now()}`;
    let sample: LoadedDataset;
    try {
      sample = await loadDataSource(
        dataset,
        { dataset, limit: 5000 },
        { workspace, datasetsDir: this.opts.datasetsDir, runId },
      );
    } catch (err) {
      throw new DashboardBuildError(errorMessage(err));
    }
    const spec = explorerSpec({
      dataset,
      columns: sample.columns,
      rows: sample.rows,
      description: this.opts.describeDataset?.(dataset),
    });
    return this.build(spec, { runId: opts.runId, workspace, source: 'explore' });
  }

  /** Rebuild every on-new-data dashboard that reads one of `datasets`. Errors are logged. */
  async refreshFor(datasets: string[]): Promise<string[]> {
    const rebuilt: string[] = [];
    for (const meta of await this.list()) {
      if (meta.refresh !== 'on-new-data' || !meta.dependsOn.some((d) => datasets.includes(d))) continue;
      const raw = await readJson<unknown>(path.join(this.opts.dir, meta.slug, 'spec.json'), null);
      if (!raw) continue;
      try {
        await this.build(raw, { source: meta.source === 'explore' ? 'explore' : 'refresh' });
        rebuilt.push(meta.slug);
      } catch (err) {
        this.logger.warn('dashboard refresh failed', { slug: meta.slug, err: errorMessage(err) });
      }
    }
    return rebuilt;
  }

  /** A model-readable profile of a data source, with suggestions for components. */
  async profile(
    src: { dataset?: string; sql?: string; file?: string; limit?: number },
    ctx: { workspace: Workspace; runId: string },
  ): Promise<string> {
    const given = [src.dataset, src.sql, src.file].filter((x) => x !== undefined).length;
    if (given !== 1) throw new ToolError('give exactly one of dataset, sql or file');
    const d = await loadDataSource(
      'profile',
      { dataset: src.dataset, sql: src.sql, file: src.file, limit: src.limit ?? 20_000 },
      { workspace: ctx.workspace, datasetsDir: this.opts.datasetsDir, sql: this.opts.sql, runId: ctx.runId },
    );
    const name = src.dataset ?? src.file ?? 'query';
    const lines = [describeProfile(name, d.columns, d.rows)];
    if (d.truncated) lines.push(`(profiled the first ${d.rows.length} of ${d.totalRows} rows)`);
    const times = d.columns.filter((c) => isTimeType(c.type)).map((c) => c.name);
    const measures = d.columns
      .filter((c) => isNumericType(c.type) && !/(^|_)id$/i.test(c.name))
      .map((c) => c.name);
    const cats = d.columns
      .filter((c) => c.type === 'string' || c.type === 'boolean')
      .filter((c) => {
        const p = profileColumn(c, d.rows, 1);
        return p.distinct >= 2 && p.distinct <= 60;
      })
      .map((c) => c.name);
    lines.push('', 'Suggestions:');
    if (times.length)
      lines.push(`- time axis: ${times.join(', ')} (line/area over time, daterange filter, KPI delta)`);
    if (measures.length) lines.push(`- measures: ${measures.join(', ')} (KPIs, histograms, bar values)`);
    if (cats.length)
      lines.push(`- categories with few values: ${cats.join(', ')} (facets, select filters, bar x, series)`);
    if (!times.length && !measures.length)
      lines.push('- mostly text: a searchable table with facets fits best');
    const sample = d.rows.slice(0, 5);
    if (sample.length) {
      const cols = d.columns.slice(0, 8).map((c) => c.name);
      lines.push(
        '',
        'Sample rows:',
        markdownTable(
          cols,
          sample.map((r) => cols.map((c) => truncate(r[c]))),
        ),
      );
    }
    return lines.join('\n');
  }

  /** The catalog page at /dashboards/: every dashboard and dataset, with explorer links. */
  async writeIndex(): Promise<void> {
    const metas = await this.list();
    const datasets = await listDatasets(this.opts.datasetsDir);
    const assets = await loadUiAssets();
    const fmt = (iso: string) => new Date(iso).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const explorers = new Set(
      metas.filter((m) => m.slug.startsWith('explore-')).map((m) => m.slug.slice('explore-'.length)),
    );
    const cards = metas
      .map(
        (m) => `<article class="hx-card hx-catalog-card">
  <h3 class="hx-card-title"><a href="${escapeHtml(m.slug)}/">${escapeHtml(m.title)}</a></h3>
  ${m.description ? `<p class="hx-card-subtitle">${escapeHtml(m.description)}</p>` : ''}
  <p class="hx-meta">Built ${escapeHtml(fmt(m.builtAt))} &middot; ${m.datasets.map((d) => `${escapeHtml(d.name)} (${d.rows.toLocaleString('en-US')} rows)`).join(', ')}</p>
</article>`,
      )
      .join('\n');
    const rows = await Promise.all(
      datasets.map(async (name) => {
        const files = (await fsp.readdir(path.join(this.opts.datasetsDir, name)).catch(() => [] as string[]))
          .filter((f) => f.endsWith('.jsonl'))
          .sort();
        const latest = files[files.length - 1]?.replace(/\.jsonl$/, '') ?? '';
        const desc = this.opts.describeDataset?.(name) ?? '';
        return `<tr><td>${explorers.has(name) ? `<a href="explore-${escapeHtml(name)}/">${escapeHtml(name)}</a>` : escapeHtml(name)}</td><td>${escapeHtml(desc)}</td><td class="num">${files.length}</td><td>${escapeHtml(latest)}</td></tr>`;
      }),
    );
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">
<title>Dashboards</title>
<style>${assets.css}
.hx-catalog { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 16px; }
.hx-catalog-card a { color: var(--ink); text-decoration: none; }
.hx-catalog-card a:hover { text-decoration: underline; }</style>
</head>
<body>
<main id="hx-app">
<header class="hx-header"><div class="hx-header-text"><h1>Dashboards</h1><p class="hx-description">Dashboards built by the harness agents, and the datasets its scrapers maintain.</p></div></header>
<section class="hx-section"><header class="hx-section-header"><h2>Dashboards</h2></header>
${metas.length ? `<div class="hx-catalog">${cards}</div>` : '<p class="hx-card-note">No dashboards yet. Ask the harness for one, or run <code>harness explore &lt;dataset&gt;</code>.</p>'}
</section>
<section class="hx-section"><header class="hx-section-header"><h2>Datasets</h2><p>Explore a dataset with <code>harness explore &lt;name&gt;</code> or <code>/explore</code> in Discord.</p></header>
<div class="hx-card"><div class="hx-table-scroll"><table class="hx-table"><thead><tr><th>Dataset</th><th>Source</th><th class="num">Days</th><th>Latest file</th></tr></thead><tbody>${rows.join('') || '<tr><td colspan="4">No datasets yet.</td></tr>'}</tbody></table></div></div>
</section>
</main>
</body>
</html>
`;
    await ensureDir(this.opts.dir);
    await writeTextAtomic(path.join(this.opts.dir, 'index.html'), html);
  }

  /** One paragraph for tool results and chat replies. */
  static summary(result: BuildResult, displayPath: string): string {
    const m = result.meta;
    const lines = [
      `Built dashboard "${m.title}" (${m.slug}), ${(m.bytes / 1024).toFixed(0)} KB, self-contained HTML.`,
      `File: ${displayPath}`,
      result.url ? `URL: ${result.url}` : 'Served at /dashboards/' + m.slug + '/ on the harness web server.',
      `Data: ${m.datasets.map((d) => `${d.name} ${d.rows.toLocaleString('en-US')} rows x ${d.columns} columns`).join('; ')}`,
    ];
    if (m.warnings.length) lines.push('Warnings:', ...m.warnings.map((w) => `- ${w}`));
    lines.push(
      'Check every warning; open the file in a browser if you can, then report the link and what the dashboard shows.',
    );
    return lines.join('\n');
  }
}

function truncate(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 59) + '\u2026' : s;
}
