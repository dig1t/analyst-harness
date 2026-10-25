import { formatTime, makeFormatter } from '../src/dashboards/core/format';
import { isTimeType } from '../src/dashboards/core/infer';
import { toTime } from '../src/dashboards/core/time';
import type { ActiveFilter, FilterValue } from '../src/dashboards/core/types';
import { errorState } from './card';
import { keyLabel } from './chart';
import { BarChart } from './components/bar';
import { DataTable } from './components/table';
import { Facets } from './components/facets';
import { FilterBar } from './components/filter-bar';
import { HeatmapChart } from './components/heatmap';
import { HistogramChart } from './components/histogram';
import { KpiTile } from './components/kpi';
import { LineChart } from './components/line';
import { MarkdownBlock } from './components/markdown';
import { PivotTable } from './components/pivot';
import { ProfileGrid } from './components/profile';
import { ScatterChart } from './components/scatter';
import { h, icon, storageGet, storageSet } from './dom';
import { copyText } from './export';
import { Store, decodeState, encodeState } from './store';
import type { App, ClientComponent, Component, ComponentOf, PagePayload } from './types';

function create(app: App, def: ClientComponent): Component {
  switch (def.type) {
    case 'kpi':
      return new KpiTile(app, def as ComponentOf<'kpi'>);
    case 'line':
    case 'area':
      return new LineChart(app, def as ComponentOf<'line'>);
    case 'bar':
      return new BarChart(app, def as ComponentOf<'bar'>);
    case 'scatter':
      return new ScatterChart(app, def as ComponentOf<'scatter'>);
    case 'histogram':
      return new HistogramChart(app, def as ComponentOf<'histogram'>);
    case 'heatmap':
      return new HeatmapChart(app, def as ComponentOf<'heatmap'>);
    case 'table':
      return new DataTable(app, def as ComponentOf<'table'>);
    case 'facets':
      return new Facets(app, def as ComponentOf<'facets'>);
    case 'profile':
      return new ProfileGrid(app, def as ComponentOf<'profile'>);
    case 'pivot':
      return new PivotTable(app, def as ComponentOf<'pivot'>);
    case 'markdown':
      return new MarkdownBlock(def);
  }
}

class DashboardApp implements App {
  readonly store: Store;
  readonly spec: PagePayload['spec'];
  readonly locale: string;
  readonly downloads: boolean;
  readonly filters: PagePayload['spec']['filters'];
  private readonly components: Component[] = [];
  private readonly bar: FilterBar;
  private hashTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly payload: PagePayload,
    root: HTMLElement,
  ) {
    this.spec = payload.spec;
    this.locale = payload.spec.locale || 'en-US';
    this.downloads = payload.meta.mode !== 'embedded';
    this.filters = payload.spec.filters.filter((f) => f.datasets.length > 0);
    this.store = new Store(payload.datasets);
    for (const f of this.filters) {
      const value: FilterValue =
        f.type === 'daterange'
          ? { kind: 'time', preset: f.default }
          : f.type === 'select'
            ? { kind: 'values', values: f.default ?? [] }
            : f.type === 'range'
              ? { kind: 'range' }
              : { kind: 'search', text: '' };
      this.store.set({
        id: f.id,
        datasets: f.datasets,
        fields: f.type === 'search' ? f.fields : [f.field],
        value,
        label: f.label,
      });
    }
    this.restore();
    this.bar = new FilterBar(this);
    root.append(
      this.header(),
      this.bar.el,
      ...this.spec.sections.map((s, i) => this.section(s, i)),
      this.footer(),
    );
    this.store.subscribe((changed) => {
      this.bar.update();
      for (const c of this.components) if (c.datasets.some((d) => changed.has(d))) c.update(changed);
      this.persist();
    });
    for (const c of this.components) if (c instanceof LineChart || c instanceof BarChart) c.update();
    document.addEventListener('keydown', (ev) => {
      const t = ev.target as HTMLElement;
      if (ev.key === '/' && !/input|textarea|select/i.test(t.tagName) && !t.isContentEditable) {
        const search = root.querySelector<HTMLInputElement>(
          '.hx-global-search, .hx-table-toolbar input[type="search"]',
        );
        if (search) {
          ev.preventDefault();
          search.focus();
        }
      }
    });
  }

  private section(sec: PagePayload['spec']['sections'][number], i: number): HTMLElement {
    const items = sec.items.map((def) => {
      try {
        const c = create(this, def);
        this.components.push(c);
        return c.el;
      } catch (err) {
        return h(
          'div',
          { class: `hx-item w-${def.width}` },
          errorState(`This ${def.type} could not be shown: ${(err as Error).message}`),
        );
      }
    });
    return h(
      'section',
      { class: 'hx-section', 'aria-labelledby': sec.title ? `section-${i}` : undefined },
      sec.title || sec.description
        ? h(
            'header',
            { class: 'hx-section-header' },
            sec.title ? h('h2', { id: `section-${i}` }, sec.title) : null,
            sec.description ? h('p', null, sec.description) : null,
          )
        : null,
      h('div', { class: 'hx-grid' }, items),
    );
  }

  private dataThrough(): string | null {
    let latest: number | null = null;
    for (const d of this.store.datasets.values()) {
      const col =
        d.info.columns.find((c) => c.name === '_scraped_at') ??
        d.info.columns.find((c) => isTimeType(c.type));
      if (!col) continue;
      for (const r of d.rows) {
        const t = toTime(r[col.name]);
        if (t !== null && (latest === null || t > latest)) latest = t;
      }
    }
    return latest === null ? null : formatTime(latest, 'datetime', this.locale);
  }

  private header(): HTMLElement {
    const built = Date.parse(this.payload.meta.builtAt);
    const rows = [...this.store.datasets.values()].reduce((n, d) => n + d.rows.length, 0);
    const through = this.dataThrough();
    const meta = [
      through ? `Data through ${through}` : null,
      `${rows.toLocaleString(this.locale)} rows`,
      Number.isFinite(built) ? `Built ${formatTime(built, 'datetime', this.locale)}` : null,
    ].filter(Boolean) as string[];
    return h(
      'header',
      { class: 'hx-header' },
      h(
        'div',
        { class: 'hx-header-text' },
        h('h1', null, this.spec.title),
        this.spec.description ? h('p', { class: 'hx-description' }, this.spec.description) : null,
        h('p', { class: 'hx-meta' }, meta.join('  \u00b7  ')),
      ),
      h(
        'div',
        { class: 'hx-header-actions' },
        this.payload.meta.mode === 'served'
          ? h(
              'button',
              {
                type: 'button',
                class: 'hx-btn',
                onclick: () => void copyText(location.href, 'Copied a link to this view'),
              },
              icon('link'),
              'Copy link',
            )
          : null,
        this.themeSwitch(),
      ),
    );
  }

  private themeSwitch(): HTMLElement {
    const root = document.documentElement;
    const apply = (mode: string) => {
      if (mode === 'light' || mode === 'dark') root.setAttribute('data-theme', mode);
      else root.removeAttribute('data-theme');
      group
        .querySelectorAll('button')
        .forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    };
    const group = h(
      'div',
      { class: 'hx-segmented', role: 'group', 'aria-label': 'Theme' },
      (['auto', 'light', 'dark'] as const).map((mode) =>
        h(
          'button',
          {
            type: 'button',
            'data-mode': mode,
            title:
              mode === 'auto' ? 'Match the system theme' : `${mode[0]!.toUpperCase()}${mode.slice(1)} theme`,
            onclick: () => {
              storageSet('hx-theme', mode === 'auto' ? null : mode);
              apply(mode);
            },
          },
          icon(mode === 'auto' ? 'auto' : mode === 'light' ? 'sun' : 'moon'),
          h('span', { class: 'hx-visually-hidden' }, mode),
        ),
      ),
    );
    apply(storageGet('hx-theme') ?? (this.spec.theme === 'auto' ? 'auto' : this.spec.theme));
    return group;
  }

  private footer(): HTMLElement {
    const n = (v: number) => v.toLocaleString(this.locale);
    return h(
      'footer',
      { class: 'hx-footer' },
      h('h2', null, 'About this data'),
      h(
        'div',
        { class: 'hx-sources' },
        [...this.store.datasets.values()].map((d) =>
          h(
            'article',
            { class: 'hx-source' },
            h('h3', null, d.info.name),
            d.info.description ? h('p', null, d.info.description) : null,
            h(
              'p',
              { class: 'hx-meta' },
              `${n(d.rows.length)} rows${d.info.truncated ? ` of ${n(d.info.totalRows ?? d.rows.length)} (the newest are shown)` : ''}, ${d.info.columns.length} columns`,
            ),
            d.info.source
              ? h(
                  'details',
                  null,
                  h('summary', null, d.info.source.kind === 'sql' ? 'Query' : 'Source'),
                  h(
                    'pre',
                    null,
                    d.info.source.kind === 'dataset'
                      ? `Scraped dataset: ${d.info.source.text}`
                      : d.info.source.text,
                  ),
                  d.info.source.kind === 'sql'
                    ? h(
                        'button',
                        {
                          type: 'button',
                          class: 'hx-link-btn',
                          onclick: () => void copyText(d.info.source!.text, 'Copied the query'),
                        },
                        'Copy query',
                      )
                    : null,
                )
              : null,
          ),
        ),
      ),
      this.spec.sources.length
        ? h(
            'div',
            { class: 'hx-provenance' },
            h('h3', null, 'Sources'),
            h(
              'ul',
              null,
              this.spec.sources.map((src) => h('li', null, src)),
            ),
          )
        : null,
      h(
        'p',
        { class: 'hx-meta hx-generator' },
        `Made with ${this.payload.meta.generator}`,
        this.payload.meta.runId ? ` in run ${this.payload.meta.runId}` : '',
        this.payload.meta.notebook && this.payload.meta.mode === 'served'
          ? [
              '. ',
              h(
                'a',
                { href: this.payload.meta.notebook, download: 'notebook.ipynb' },
                'Open the data in Jupyter',
              ),
            ]
          : '',
      ),
    );
  }

  clearFilters(): void {
    const specIds = new Set(this.filters.map((f) => f.id));
    this.store.clearAll((f) => specIds.has(f.id));
  }

  setTimeRange(dataset: string, field: string, from: number, to: number, label: string): void {
    const spec = this.filters.find(
      (f) => f.type === 'daterange' && f.field === field && f.datasets.includes(dataset),
    );
    if (spec) this.store.update(spec.id, { kind: 'time', from, to });
    else
      this.store.set({
        id: `time:${dataset}:${field}`,
        datasets: [dataset],
        fields: [field],
        value: { kind: 'time', from, to },
        label: `${this.store.column(dataset, field)?.label ?? field}: ${label}`,
      });
  }

  selectionFor(dataset: string, field: string): ActiveFilter | undefined {
    const spec = this.filters.find(
      (f) => f.type === 'select' && f.field === field && f.datasets.includes(dataset),
    );
    return spec ? this.store.get(spec.id) : this.store.get(`values:${dataset}:${field}`);
  }

  clearValues(dataset: string, field: string): void {
    const f = this.selectionFor(dataset, field);
    if (!f) return;
    if (f.id.startsWith('values:')) this.store.remove(f.id);
    else this.store.update(f.id, { kind: 'values', values: [] });
  }

  isSelected(dataset: string, field: string, value: string): boolean {
    const f = this.selectionFor(dataset, field);
    return !!f && f.value.kind === 'values' && f.value.values.includes(value);
  }

  toggleValue(dataset: string, field: string, value: string, label: string): void {
    const existing = this.selectionFor(dataset, field);
    const current = existing && existing.value.kind === 'values' ? existing.value.values : [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    if (existing && !existing.id.startsWith('values:')) {
      this.store.update(existing.id, { kind: 'values', values: next });
      return;
    }
    const id = `values:${dataset}:${field}`;
    if (next.length === 0) this.store.remove(id);
    else {
      const name = this.store.column(dataset, field)?.label ?? field;
      const only =
        next.length === 1
          ? next[0] === value
            ? label
            : `${name}: ${keyLabel(this, dataset, field)(next[0]!)}`
          : `${name}: ${next.length} values`;
      this.store.set({
        id,
        datasets: [dataset],
        fields: [field],
        value: { kind: 'values', values: next },
        label: only,
      });
    }
  }

  private restore(): void {
    const state = decodeState(location.hash);
    if (!state) return;
    for (const [id, value] of Object.entries(state)) {
      if (this.store.get(id)) {
        this.store.update(id, value);
        continue;
      }
      const m = /^(values|time):([^:]+):(.+)$/.exec(id);
      if (!m || !this.store.datasets.has(m[2]!)) continue;
      const field = m[3]!;
      const name = this.store.column(m[2]!, field)?.label ?? field;
      const fmtDate = makeFormatter('date', 'date', this.locale);
      const label =
        value.kind === 'values'
          ? `${name}: ${value.values.length === 1 ? keyLabel(this, m[2]!, field)(value.values[0]!) : `${value.values.length} values`}`
          : value.kind === 'time'
            ? `${name}: ${value.from !== undefined ? fmtDate(value.from) : 'start'} to ${value.to !== undefined ? fmtDate(value.to - 1) : 'now'}`
            : name;
      this.store.set({ id, datasets: [m[2]!], fields: [field], value, label });
    }
  }

  private persist(): void {
    if (this.payload.meta.mode === 'embedded') return;
    if (this.hashTimer) clearTimeout(this.hashTimer);
    this.hashTimer = setTimeout(() => {
      const snap = this.store.snapshot();
      const hash = Object.keys(snap).length ? `#f=${encodeState(snap)}` : '';
      try {
        history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);
      } catch {
        // some sandboxes forbid history changes; the view still works
      }
    }, 250);
  }
}

function boot(): void {
  const root = document.getElementById('hx-app');
  const data = document.getElementById('hx-data');
  if (!root || !data) return;
  let payload: PagePayload;
  try {
    payload = JSON.parse(data.textContent ?? '{}') as PagePayload;
  } catch (err) {
    root.appendChild(errorState(`The dashboard data could not be read: ${(err as Error).message}`));
    return;
  }
  new DashboardApp(payload, root);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
