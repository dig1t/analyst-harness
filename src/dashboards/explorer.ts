import { isNumericType, isTimeType, profileColumn } from './core/infer';
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

/**
 * A complete explorer dashboard for one dataset, chosen from the data's shape: a KPI row, a
 * timeline, facets for the low-cardinality text columns, distributions of the main measures, a
 * searchable record table with links, and a profile of every column.
 */
export function explorerSpec(input: ExplorerInput): DashboardSpecInput {
  const { dataset, columns, rows } = input;
  const visible = columns.filter((c) => c.name !== '_hash');
  const profiles = new Map(visible.map((c) => [c.name, profileColumn(c, rows, 5)]));
  const n = rows.length || 1;
  const time = timeColumn(visible);
  const categorical = visible
    .filter(
      (c) => (c.type === 'string' || c.type === 'boolean') && !c.name.startsWith('_') && !ID_RE.test(c.name),
    )
    .filter((c) => {
      const p = profiles.get(c.name)!;
      return p.distinct >= 2 && p.distinct <= 60 && p.distinct / n <= 0.5;
    })
    .sort((a, b) => profiles.get(a.name)!.distinct - profiles.get(b.name)!.distinct)
    .slice(0, 4);
  const measures = visible
    .filter((c) => isNumericType(c.type) && !ID_RE.test(c.name) && !c.name.startsWith('_'))
    .filter((c) => (profiles.get(c.name)!.distinct ?? 0) > 2)
    .slice(0, 2);
  const text = visible.filter(
    (c) => c.type === 'string' && !categorical.includes(c) && !c.name.startsWith('_'),
  );
  const titleCol = text.find((c) => TITLE_RE.test(c.name)) ?? text[0];
  const urlCol = visible.find((c) => c.type === 'url');

  const kpis: NonNullable<DashboardSpecInput['sections']>[number]['items'] = [
    {
      type: 'kpi',
      title: 'Records',
      value: { agg: 'count' },
      ...(time ? { sparkline: { field: time.name, interval: 'day' as const } } : {}),
    },
  ];
  for (const m of measures.slice(0, 2))
    kpis.push({ type: 'kpi', title: `Median ${m.label ?? m.name}`, value: { agg: 'median', field: m.name } });
  if (categorical[0])
    kpis.push({
      type: 'kpi',
      title: `Distinct ${categorical[0].label ?? categorical[0].name}`,
      value: { agg: 'distinct', field: categorical[0].name },
    });
  const kpiWidth = Math.max(3, Math.floor(12 / kpis.length));
  for (const k of kpis) (k as { width?: number }).width = kpiWidth;

  const overview: typeof kpis = [...kpis];
  if (time)
    overview.push({
      type: categorical.length ? 'area' : 'line',
      title: `Records by ${time.label ?? time.name}`,
      x: { field: time.name },
      y: { agg: 'count' },
      width: categorical.length ? 9 : 12,
    } as (typeof kpis)[number]);
  if (categorical.length)
    overview.push({
      type: 'facets',
      title: 'Refine',
      fields: categorical.map((c) => c.name),
      width: time ? 3 : 12,
    });

  const distributions: typeof kpis = [];
  for (const m of measures)
    distributions.push({
      type: 'histogram',
      title: `${m.label ?? m.name} distribution`,
      field: m.name,
      width: 6,
    });
  if (categorical[0])
    distributions.push({
      type: 'bar',
      title: `Most common ${categorical[0].label ?? categorical[0].name}`,
      x: { field: categorical[0].name, top: 15 },
      y: { agg: 'count' },
      width: 6,
    });

  const tableCols = [
    ...(titleCol ? [{ field: titleCol.name, ...(urlCol ? { link: urlCol.name } : {}) }] : []),
    ...visible
      .filter((c) => c !== titleCol && c.name !== '_hash' && c.name !== '_scraper' && c.name !== '_key')
      .filter((c) => !(urlCol && titleCol && c === urlCol))
      .slice(0, 10)
      .map((c) => (isNumericType(c.type) && measures.includes(c) ? { field: c.name, bar: true } : c.name)),
  ];

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
  if (time) filters.push({ type: 'daterange', field: time.name, label: time.label ?? time.name });
  const searchable = [titleCol, ...text.filter((c) => c !== titleCol)]
    .filter((c): c is ColumnInfo => !!c)
    .slice(0, 3);
  if (searchable.length)
    filters.push({
      type: 'search',
      fields: searchable.map((c) => c.name),
      placeholder: `Search ${searchable.map((c) => c.label ?? c.name).join(', ')}`,
    });

  return {
    title: `${dataset} explorer`,
    slug: `explore-${dataset}`.slice(0, 64),
    description:
      input.description ??
      `Every record in the ${dataset} dataset, with filters, facets and column profiles. Rebuilt when the scraper writes new data.`,
    data: { [dataset.replace(/[^A-Za-z0-9_-]/g, '_')]: { dataset, limit: 20_000 } },
    filters,
    sections,
  };
}
