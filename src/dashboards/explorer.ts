import { humanizeName, isNumericType, isTimeType, profileColumn } from './core/infer';
import { toTime } from './core/time';
import type { ColumnInfo, Row } from './core/types';
import type { DashboardSpecInput } from './spec';

const ID_RE = /(^|_)(id|uuid|key|hash)$/i;
const TITLE_RE = /^(title|name|headline|label|subject|summary)$/i;
const DOMAIN_TIME_RE = /(date|time|published|created|updated|posted|day|at)$/i;

export interface ExplorerInput {
  dataset: string;
  columns: ColumnInfo[];
  rows: Row[];
  description?: string;
}

/** Pick a time column: the data's own dates first, the scrape time as a fallback. */
function timeColumn(cols: ColumnInfo[]): ColumnInfo | undefined {
  const times = cols.filter((c) => isTimeType(c.type));
  return (
    times.find((c) => !c.name.startsWith('_') && DOMAIN_TIME_RE.test(c.name)) ??
    times.find((c) => !c.name.startsWith('_')) ??
    times[0]
  );
}

/** Sparkline buckets that show a dozen meaningful steps over the data's time span. */
function sparkInterval(rows: Row[], field: string): 'day' | 'week' | 'month' {
  const ts = rows.map((r) => toTime(r[field])).filter((v): v is number => v !== null);
  if (ts.length < 2) return 'day';
  const days = (Math.max(...ts) - Math.min(...ts)) / 86_400_000;
  return days > 730 ? 'month' : days > 90 ? 'week' : 'day';
}

/**
 * A complete explorer dashboard for one dataset, chosen from the data's shape: a KPI row, a
 * timeline (stacked by a small category when there is one), facets for the navigational text
 * columns, distributions of the main measures, the most common values, a searchable record
 * table with links and data bars, and a profile of every column.
 */
export function explorerSpec(input: ExplorerInput): DashboardSpecInput {
  const { dataset, columns, rows } = input;
  const visible = columns.filter((c) => c.name !== '_hash');
  const profiles = new Map(visible.map((c) => [c.name, profileColumn(c, rows, 5)]));
  const distinct = (c: ColumnInfo) => profiles.get(c.name)!.distinct;
  // The format already shows the unit, so "size_bytes" reads as "Size".
  const label = (c: ColumnInfo) =>
    c.label ??
    humanizeName(
      c.format === 'bytes'
        ? c.name.replace(/_?bytes$/i, '') || c.name
        : c.format === 'duration'
          ? c.name.replace(/_?(seconds|secs|sec)$/i, '') || c.name
          : c.name,
    );
  const n = rows.length || 1;
  const time = timeColumn(visible);
  const own = visible.filter((c) => !c.name.startsWith('_'));
  const filled = (c: ColumnInfo) => {
    const p = profiles.get(c.name)!;
    return p.count ? (p.count - p.nulls) / p.count : 0;
  };
  // Mostly filled text first (a handful to a few dozen values), then yes/no, then sparse text.
  const rank = (c: ColumnInfo) => (c.type === 'boolean' ? 1 : filled(c) >= 0.8 ? 0 : 2);
  const categorical = own
    .filter((c) => (c.type === 'string' || c.type === 'boolean') && !ID_RE.test(c.name))
    .filter((c) => distinct(c) >= 2 && distinct(c) <= 60 && distinct(c) / n <= 0.5)
    .sort((a, b) => rank(a) - rank(b) || distinct(a) - distinct(b))
    .slice(0, 4);
  const textCats = categorical.filter((c) => c.type === 'string');
  // The main dimension: mostly filled, then the most values (packages over a sparse column).
  const widest = [...textCats].sort(
    (a, b) => Number(filled(b) >= 0.8) - Number(filled(a) >= 0.8) || distinct(b) - distinct(a),
  )[0];
  const small = textCats.find((c) => distinct(c) >= 2 && distinct(c) <= 6);
  const measures = own
    .filter((c) => isNumericType(c.type) && !ID_RE.test(c.name) && distinct(c) > 2)
    .slice(0, 2);
  const text = own.filter((c) => c.type === 'string' && !categorical.includes(c));
  const titleCol = text.find((c) => TITLE_RE.test(c.name)) ?? text[0];
  const urlCol = visible.find((c) => c.type === 'url');
  const linkCol = titleCol ?? widest;

  type Item = NonNullable<DashboardSpecInput['sections']>[number]['items'][number];
  const kpis: Item[] = [
    {
      type: 'kpi',
      title: 'Records',
      value: { agg: 'count' },
      ...(time ? { sparkline: { field: time.name, interval: sparkInterval(rows, time.name) } } : {}),
    },
  ];
  for (const m of measures)
    kpis.push({
      type: 'kpi',
      title: `Median ${label(m).toLowerCase()}`,
      value: { agg: 'median', field: m.name },
    });
  if (widest)
    kpis.push({
      type: 'kpi',
      title: `Distinct ${label(widest).toLowerCase()}`,
      value: { agg: 'distinct', field: widest.name },
    });
  const kpiWidth = Math.max(3, Math.floor(12 / kpis.length));
  for (const k of kpis) (k as { width?: number }).width = kpiWidth;

  const overview: Item[] = [...kpis];
  if (time)
    overview.push({
      type: 'area',
      title: `Records by ${label(time).toLowerCase()}`,
      ...(small ? { subtitle: `Stacked by ${label(small).toLowerCase()}` } : {}),
      x: { field: time.name },
      y: { agg: 'count' },
      ...(small ? { series: { field: small.name, top: 6 }, stack: true } : {}),
      width: categorical.length ? 9 : 12,
    } as Item);
  if (categorical.length)
    overview.push({
      type: 'facets',
      title: 'Refine',
      fields: categorical.map((c) => c.name),
      width: time ? 3 : 12,
    });

  const distributions: Item[] = measures.map((m) => ({
    type: 'histogram',
    title: `${label(m)} distribution`,
    field: m.name,
    width: 6,
  }));
  if (widest)
    distributions.push({
      type: 'bar',
      title: `Most common ${label(widest).toLowerCase()}`,
      x: { field: widest.name, top: 15 },
      y: { agg: 'count' },
      width: measures.length % 2 === 0 ? 12 : 6,
    });

  const bookkeeping = new Set(['_hash', '_scraper', '_key', '_change']);
  const tableCols = visible
    .filter((c) => !bookkeeping.has(c.name) && !(urlCol && linkCol && c === urlCol))
    .slice(0, 10)
    .map((c) =>
      c === linkCol && urlCol
        ? { field: c.name, link: urlCol.name }
        : measures.includes(c)
          ? { field: c.name, bar: true }
          : c.name,
    );

  const sections: NonNullable<DashboardSpecInput['sections']> = [{ title: 'Overview', items: overview }];
  if (distributions.length) sections.push({ title: 'Distributions', items: distributions });
  sections.push({
    title: 'Records',
    items: [
      {
        type: 'table',
        title: 'All records',
        columns: tableCols,
        ...(time ? { sort: { field: time.name, direction: 'desc' as const } } : {}),
        pageSize: 25,
      },
    ],
  });
  sections.push({ title: 'Columns', items: [{ type: 'profile', title: 'Column profiles' }] });

  const filters: NonNullable<DashboardSpecInput['filters']> = [];
  if (time) filters.push({ type: 'daterange', field: time.name, label: label(time) });
  const searchable = [...new Set([titleCol, widest, ...text].filter((c): c is ColumnInfo => !!c))].slice(
    0,
    3,
  );
  if (searchable.length)
    filters.push({
      type: 'search',
      fields: searchable.map((c) => c.name),
      placeholder: `Search ${searchable.map((c) => label(c).toLowerCase()).join(', ')}`,
    });

  // Readable labels for every column; explicit labels and formats from the data still win.
  const columnMeta = Object.fromEntries(
    visible
      .filter((c) => !c.name.startsWith('_'))
      .map((c) => [c.name, { label: label(c), ...(c.format ? { format: c.format } : {}) }]),
  );
  return {
    title: `${dataset} explorer`,
    slug: explorerSlug(dataset),
    description:
      input.description ??
      `Every record in the ${dataset} dataset, with filters, facets and column profiles. Rebuilt when the scraper writes new data.`,
    data: { [dataset.replace(/[^A-Za-z0-9_-]/g, '_')]: { dataset, limit: 20_000, columns: columnMeta } },
    filters,
    sections,
  };
}

/** The explorer's slug for a dataset (dataset names may contain `_`, slugs may not). */
export function explorerSlug(dataset: string): string {
  return `explore-${dataset.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`.slice(0, 64).replace(/-+$/, '');
}
