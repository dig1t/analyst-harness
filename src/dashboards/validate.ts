import { isNumericType, isTimeType } from './core/infer';
import { MAX_SCATTER_SERIES } from './core/series';
import type { ColumnInfo, ColumnType } from './core/types';
import type { LoadedDataset } from './data-loader';
import type { AggValue, DashboardComponent, DashboardFilter, DashboardSpec } from './spec';

export interface BuildIssue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

export type ResolvedComponent = DashboardComponent & { id: string; data: string; width: number };

export type ResolvedFilter = DashboardFilter & { id: string; datasets: string[] };

export interface ResolvedSpec extends Omit<DashboardSpec, 'sections' | 'filters'> {
  slug: string;
  filters: ResolvedFilter[];
  sections: Array<{ title?: string; description?: string; items: ResolvedComponent[] }>;
}

const DEFAULT_WIDTH: Record<DashboardComponent['type'], number> = {
  kpi: 3,
  line: 12,
  area: 12,
  bar: 6,
  scatter: 6,
  histogram: 6,
  heatmap: 12,
  table: 12,
  facets: 3,
  markdown: 12,
  profile: 12,
  pivot: 12,
};

const NUMERIC_AGGS = new Set(['sum', 'mean', 'median', 'min', 'max', 'p10', 'p90', 'first', 'last']);

function describeColumns(cols: ColumnInfo[]): string {
  const shown = cols.slice(0, 30).map((c) => `${c.name} (${c.type})`);
  return shown.join(', ') + (cols.length > 30 ? `, and ${cols.length - 30} more` : '');
}

/** Check a spec against the loaded data and fill in ids, data names, widths and filter targets. */
export function resolveSpec(
  spec: DashboardSpec & { slug: string },
  datasets: Map<string, LoadedDataset>,
): { spec: ResolvedSpec; issues: BuildIssue[] } {
  const issues: BuildIssue[] = [];
  const names = [...datasets.keys()];
  const err = (where: string, message: string) => issues.push({ level: 'error', where, message });
  const warn = (where: string, message: string) => issues.push({ level: 'warning', where, message });

  for (const d of datasets.values()) {
    if (d.rows.length === 0) warn(`data.${d.name}`, 'has no rows; its components will show an empty state');
    if (d.truncated)
      warn(
        `data.${d.name}`,
        `has ${d.totalRows.toLocaleString('en-US')} rows; the page embeds ${d.rows.length.toLocaleString('en-US')} (aggregate in SQL or raise limit)`,
      );
  }

  const column = (data: string, field: string): ColumnInfo | undefined =>
    datasets.get(data)?.columns.find((c) => c.name === field);

  const usedIds = new Set<string>();
  let heroes = 0;
  const sections = spec.sections.map((section, si) => ({
    title: section.title,
    description: section.description,
    items: section.items.map((item, ii): ResolvedComponent => {
      const label = item.title ? ` (${item.type} "${item.title}")` : ` (${item.type})`;
      const where = `sections[${si}].items[${ii}]${label}`;
      let data = item.data ?? (names.length === 1 ? names[0]! : '');
      if (item.type !== 'markdown') {
        if (!item.data && names.length > 1) err(where, `set "data" to one of: ${names.join(', ')}`);
        else if (!datasets.has(data)) err(where, `unknown data "${data}"; defined: ${names.join(', ')}`);
      } else data = item.data ?? '';
      let id = item.id ?? `${item.type}-${si + 1}-${ii + 1}`;
      while (usedIds.has(id)) id = `${id}-x`;
      usedIds.add(id);
      const cols = datasets.get(data)?.columns ?? [];
      const need = (
        path: string,
        field: string | undefined,
        accept?: (t: ColumnType) => boolean,
        what?: string,
      ) => {
        if (!field || !datasets.has(data)) return;
        const c = column(data, field);
        if (!c) {
          err(where, `${path} "${field}" is not a column of "${data}"; columns: ${describeColumns(cols)}`);
          return;
        }
        if (accept && !accept(c.type)) err(where, `${path} "${field}" is ${c.type}; it must be ${what}`);
      };
      const needAgg = (path: string, a: AggValue) => {
        // sum and mean also take yes/no columns: the count and the share of "yes".
        const ok = (t: ColumnType) =>
          isNumericType(t) || (t === 'boolean' && (a.agg === 'sum' || a.agg === 'mean'));
        if (NUMERIC_AGGS.has(a.agg)) need(`${path}.field`, a.field, ok, 'numeric for ' + a.agg);
        else need(`${path}.field`, a.field);
        need(`${path}.orderBy`, a.orderBy);
      };
      const width = item.width ?? DEFAULT_WIDTH[item.type];
      const resolved = { ...item, id, data, width } as ResolvedComponent;
      switch (item.type) {
        case 'kpi':
          needAgg('value', item.value);
          need('delta.field', item.delta?.field, isTimeType, 'a date or datetime');
          need('sparkline.field', item.sparkline?.field, isTimeType, 'a date or datetime');
          if (item.hero && ++heroes > 1) {
            warn(where, 'only one hero figure per view; this one renders as a regular tile');
            (resolved as { hero?: boolean }).hero = false;
          }
          break;
        case 'line':
        case 'area':
          need(
            'x.field',
            item.x.field,
            (t) => isTimeType(t) || isNumericType(t),
            'a date, datetime or number',
          );
          needAgg('y', item.y);
          need('series.field', item.series?.field);
          break;
        case 'bar':
          need('x.field', item.x.field);
          needAgg('y', item.y);
          need('series.field', item.series?.field);
          break;
        case 'scatter':
          need('x.field', item.x.field, (t) => isNumericType(t) || isTimeType(t), 'a number or date');
          need('y.field', item.y.field, isNumericType, 'a number');
          need('series.field', item.series?.field);
          need('label', item.label);
          if (item.series && (item.series.top ?? MAX_SCATTER_SERIES) > MAX_SCATTER_SERIES) {
            warn(
              where,
              `scatter plots show at most ${MAX_SCATTER_SERIES} series; the rest fold into "Other"`,
            );
            (resolved as { series?: { top?: number } }).series = { ...item.series, top: MAX_SCATTER_SERIES };
          }
          break;
        case 'histogram':
          need('field', item.field, isNumericType, 'a number');
          break;
        case 'heatmap':
          need('x.field', item.x.field);
          need('y.field', item.y.field);
          needAgg('value', item.value);
          break;
        case 'table':
          for (const [ci, c] of (item.columns ?? []).entries()) {
            const f = typeof c === 'string' ? c : c.field;
            need(`columns[${ci}]`, f);
            if (typeof c !== 'string' && c.link) {
              const refs = c.link.includes('{')
                ? [...c.link.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!)
                : [c.link];
              for (const r of refs) need(`columns[${ci}].link`, r);
            }
            if (typeof c !== 'string' && c.bar) need(`columns[${ci}]`, f, isNumericType, 'a number for bar');
          }
          need('sort.field', item.sort?.field);
          if (!item.columns && cols.length > 25)
            warn(where, `shows all ${cols.length} columns; list the ones readers need in "columns"`);
          break;
        case 'facets':
          item.fields.forEach((f, fi) => need(`fields[${fi}]`, f));
          break;
        case 'profile':
          (item.columns ?? []).forEach((f, fi) => need(`columns[${fi}]`, f));
          break;
        case 'pivot':
          need('rows.field', item.rows.field);
          need('columns.field', item.columns?.field);
          needAgg('value', item.value);
          break;
        case 'markdown':
          break;
      }
      return resolved;
    }),
  }));

  const filters = spec.filters.map((f, fi): ResolvedFilter => {
    const where = `filters[${fi}] (${f.type})`;
    const fields = f.type === 'search' ? f.fields : [f.field];
    const requested = f.data === undefined ? names : Array.isArray(f.data) ? f.data : [f.data];
    for (const r of requested)
      if (!datasets.has(r)) err(where, `unknown data "${r}"; defined: ${names.join(', ')}`);
    const targets = requested.filter((n) => datasets.has(n) && fields.every((fld) => column(n, fld)));
    if (targets.length === 0 && requested.every((r) => datasets.has(r)))
      err(where, `no data source has ${fields.map((x) => `"${x}"`).join(' and ')}`);
    for (const t of targets) {
      const c = column(t, fields[0]!)!;
      if (f.type === 'daterange' && !isTimeType(c.type))
        err(where, `"${c.name}" in "${t}" is ${c.type}, not a date`);
      if (f.type === 'range' && !isNumericType(c.type))
        err(where, `"${c.name}" in "${t}" is ${c.type}, not a number`);
    }
    return { ...f, id: `filter-${fi + 1}`, datasets: targets } as ResolvedFilter;
  });

  const { sections: _s, filters: _f, ...rest } = spec;
  return { spec: { ...rest, slug: spec.slug, sections, filters }, issues };
}

export function formatIssues(issues: BuildIssue[]): string {
  return issues
    .map((i) => `- ${i.level === 'error' ? 'Error' : 'Warning'}: ${i.where}: ${i.message}`)
    .join('\n');
}
