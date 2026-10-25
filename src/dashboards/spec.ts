import { z } from 'zod';
import { FORMAT_NAMES, isValidFormat } from './core/format';
import type { AggName } from './core/types';
import { ConfigError } from '../util/errors';

const AGGS = [
  'count',
  'sum',
  'mean',
  'median',
  'min',
  'max',
  'distinct',
  'p10',
  'p90',
  'first',
  'last',
] as const satisfies readonly AggName[];
const INTERVALS = ['auto', 'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
const PRESETS = ['all', 'today', '7d', '30d', '90d', 'mtd', 'ytd', '12m'] as const;

const field = z.string().min(1).max(200);
const format = z.string().refine(isValidFormat, {
  message: `unknown format; use ${FORMAT_NAMES.join(', ')} (decimal:N, percent:N, currency:EUR[:N])`,
});
const text = (max: number) => z.string().max(max);

/** `count`, `sum(score)`, `last(rate)`: shorthand for aggregate objects. */
function parseAggShorthand(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const m = /^\s*([a-z0-9]+)\s*(?:\(\s*([^)]*?)\s*\))?\s*$/i.exec(v);
  if (!m) return v;
  return m[2] ? { agg: m[1]!.toLowerCase(), field: m[2] } : { agg: m[1]!.toLowerCase() };
}

const AggSchema = z.preprocess(
  parseAggShorthand,
  z
    .object({
      agg: z.enum(AGGS),
      field: field.optional(),
      orderBy: field.optional(),
      label: text(80).optional(),
      format: format.optional(),
    })
    .strict()
    .refine((a) => a.agg === 'count' || a.field !== undefined, { message: 'this aggregate needs a field' }),
);

const XSchema = z
  .object({
    field,
    label: text(80).optional(),
    interval: z.enum(INTERVALS).optional(),
    sort: z.enum(['value-desc', 'value-asc', 'label', 'none']).optional(),
    top: z.number().int().min(1).max(100).optional(),
    format: format.optional(),
  })
  .strict();

const NumericAxisSchema = z
  .object({
    field,
    label: text(80).optional(),
    format: format.optional(),
    scale: z.enum(['linear', 'log']).default('linear'),
  })
  .strict();

const SeriesSchema = z
  .object({ field, top: z.number().int().min(1).max(8).optional(), label: text(80).optional() })
  .strict();

const ReferenceSchema = z.object({ value: z.number(), label: text(60) }).strict();

const base = {
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
    .optional(),
  title: text(120).optional(),
  subtitle: text(300).optional(),
  data: z.string().optional(),
  width: z.number().int().min(1).max(12).optional(),
};

const height = z.number().int().min(120).max(720).optional();

const KpiSchema = z
  .object({
    ...base,
    type: z.literal('kpi'),
    value: AggSchema,
    format: format.optional(),
    hero: z.boolean().default(false),
    delta: z
      .object({
        field,
        period: z.enum(['7d', '30d', '90d', 'week', 'month', 'quarter', 'year']).default('30d'),
        goodDirection: z.enum(['up', 'down', 'neutral']).default('up'),
      })
      .strict()
      .optional(),
    sparkline: z
      .object({ field, interval: z.enum(['day', 'week', 'month']).default('day') })
      .strict()
      .optional(),
  })
  .strict();

const LineSchema = z
  .object({
    ...base,
    type: z.enum(['line', 'area']),
    x: XSchema,
    y: AggSchema,
    series: SeriesSchema.optional(),
    stack: z.boolean().default(false),
    emphasis: z.string().optional(),
    reference: z.array(ReferenceSchema).max(4).default([]),
    height,
  })
  .strict();

const BarSchema = z
  .object({
    ...base,
    type: z.literal('bar'),
    x: XSchema,
    y: AggSchema,
    series: SeriesSchema.optional(),
    stack: z.boolean().default(false),
    orientation: z.enum(['auto', 'horizontal', 'vertical']).default('auto'),
    labels: z.enum(['auto', 'always', 'never']).default('auto'),
    emphasis: z.string().optional(),
    height,
  })
  .strict();

const ScatterSchema = z
  .object({
    ...base,
    type: z.literal('scatter'),
    x: NumericAxisSchema,
    y: NumericAxisSchema,
    series: SeriesSchema.optional(),
    label: field.optional(),
    trend: z.boolean().default(false),
    limit: z.number().int().min(10).max(20_000).default(5000),
    height,
  })
  .strict();

const HistogramSchema = z
  .object({
    ...base,
    type: z.literal('histogram'),
    field,
    bins: z.number().int().min(5).max(80).optional(),
    /** auto picks a log axis for positive data spanning orders of magnitude. */
    scale: z.enum(['auto', 'linear', 'log']).default('auto'),
    label: text(80).optional(),
    format: format.optional(),
    height,
  })
  .strict();

const HeatmapSchema = z
  .object({
    ...base,
    type: z.literal('heatmap'),
    x: XSchema,
    y: XSchema,
    value: AggSchema,
    format: format.optional(),
    height,
  })
  .strict();

const TableColumnSchema = z.union([
  field,
  z
    .object({
      field,
      label: text(80).optional(),
      format: format.optional(),
      /** A URL field, or a template like `https://news.ycombinator.com/item?id={id}`. */
      link: z.string().max(500).optional(),
      /** Draw an in-cell data bar for numeric columns. */
      bar: z.boolean().optional(),
      width: z.enum(['narrow', 'normal', 'wide']).optional(),
    })
    .strict(),
]);

const TableSchema = z
  .object({
    ...base,
    type: z.literal('table'),
    columns: z.array(TableColumnSchema).max(60).optional(),
    pageSize: z.union([z.literal(10), z.literal(25), z.literal(50), z.literal(100)]).default(25),
    sort: z
      .object({ field, direction: z.enum(['asc', 'desc']).default('desc') })
      .strict()
      .optional(),
    search: z.boolean().default(true),
    details: z.boolean().default(true),
  })
  .strict();

const FacetsSchema = z
  .object({
    ...base,
    type: z.literal('facets'),
    fields: z.array(field).min(1).max(8),
    limit: z.number().int().min(3).max(50).default(8),
  })
  .strict();

const MarkdownSchema = z.object({ ...base, type: z.literal('markdown'), text: text(20_000) }).strict();

const ProfileSchema = z
  .object({ ...base, type: z.literal('profile'), columns: z.array(field).max(80).optional() })
  .strict();

const PivotSchema = z
  .object({
    ...base,
    type: z.literal('pivot'),
    rows: XSchema,
    columns: XSchema.optional(),
    value: AggSchema,
    format: format.optional(),
    heat: z.boolean().default(true),
    totals: z.boolean().default(true),
  })
  .strict();

export const COMPONENT_TYPES = [
  'kpi',
  'line',
  'area',
  'bar',
  'scatter',
  'histogram',
  'heatmap',
  'table',
  'facets',
  'markdown',
  'profile',
  'pivot',
] as const;

const ComponentSchema = z.union([
  KpiSchema,
  LineSchema,
  BarSchema,
  ScatterSchema,
  HistogramSchema,
  HeatmapSchema,
  TableSchema,
  FacetsSchema,
  MarkdownSchema,
  ProfileSchema,
  PivotSchema,
]);

const ColumnMetaSchema = z
  .object({
    label: text(80).optional(),
    format: format.optional(),
    description: text(500).optional(),
    type: z.enum(['number', 'integer', 'boolean', 'date', 'datetime', 'string', 'url', 'json']).optional(),
  })
  .strict();

const DataSourceSchema = z
  .object({
    /** DuckDB SQL over workspace files and scraped datasets (`datasets/<name>/*.jsonl`). */
    sql: z.string().max(20_000).optional(),
    /** A scraped dataset by name: its JSONL files, newest rows first up to the limit. */
    dataset: z.string().optional(),
    /** A workspace file: .csv, .json, .jsonl or .ndjson (.parquet needs DuckDB). */
    file: z.string().optional(),
    /** Rows written inline. */
    values: z.array(z.record(z.string(), z.unknown())).max(20_000).optional(),
    limit: z.number().int().min(1).max(200_000).default(50_000),
    description: text(500).optional(),
    columns: z.record(z.string(), ColumnMetaSchema).optional(),
  })
  .strict()
  .refine((d) => [d.sql, d.dataset, d.file, d.values].filter((x) => x !== undefined).length === 1, {
    message: 'give exactly one of sql, dataset, file or values',
  });

const FilterSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('daterange'),
      field,
      data: z.union([z.string(), z.array(z.string())]).optional(),
      label: text(60).optional(),
      default: z.enum(PRESETS).default('all'),
    })
    .strict(),
  z
    .object({
      type: z.literal('select'),
      field,
      data: z.union([z.string(), z.array(z.string())]).optional(),
      label: text(60).optional(),
      default: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('range'),
      field,
      data: z.union([z.string(), z.array(z.string())]).optional(),
      label: text(60).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('search'),
      fields: z.array(field).min(1).max(10),
      data: z.union([z.string(), z.array(z.string())]).optional(),
      label: text(60).optional(),
      placeholder: text(80).optional(),
    })
    .strict(),
]);

const SectionSchema = z
  .object({
    title: text(120).optional(),
    description: text(1000).optional(),
    items: z.array(ComponentSchema).min(1).max(40),
  })
  .strict();

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;

const DashboardObjectSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: text(2000).optional(),
    slug: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
      .optional(),
    theme: z.enum(['auto', 'light', 'dark']).default('auto'),
    locale: z.string().max(35).default('en-US'),
    data: z
      .record(z.string().regex(NAME_RE, 'data names are letters, digits, _ and -'), DataSourceSchema)
      .refine((d) => Object.keys(d).length >= 1 && Object.keys(d).length <= 20, {
        message: 'give between 1 and 20 data sources',
      }),
    filters: z.array(FilterSchema).max(8).default([]),
    sections: z.array(SectionSchema).min(1).max(30),
    sources: z.array(text(500)).max(20).default([]),
    refresh: z.enum(['on-new-data', 'manual']).default('on-new-data'),
  })
  .strict();

export const DashboardSpecSchema = z.preprocess((v) => {
  // A flat `items` list is shorthand for one untitled section.
  if (v && typeof v === 'object' && !Array.isArray(v) && 'items' in v && !('sections' in v)) {
    const { items, ...rest } = v as Record<string, unknown>;
    return { ...rest, sections: [{ items }] };
  }
  return v;
}, DashboardObjectSchema);

export type DashboardSpec = z.infer<typeof DashboardSpecSchema>;
export type DashboardSpecInput = z.input<typeof DashboardObjectSchema>;
export type DashboardComponent = z.infer<typeof ComponentSchema>;
export type DashboardFilter = z.infer<typeof FilterSchema>;
export type DataSourceSpec = z.infer<typeof DataSourceSchema>;
export type AggValue = z.infer<typeof AggSchema>;

function issuePath(p: ReadonlyArray<PropertyKey>): string {
  return p.map((s, i) => (typeof s === 'number' ? `[${s}]` : i === 0 ? String(s) : `.${String(s)}`)).join('');
}

/** Parse a spec, turning zod issues into one readable message an agent can act on. */
export function parseDashboardSpec(input: unknown): DashboardSpec {
  const parsed = DashboardSpecSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const lines = parsed.error.issues.slice(0, 12).map((i) => {
    const where = issuePath(i.path) || '(root)';
    let msg = i.message;
    if (i.code === 'invalid_union' && where.match(/items\[\d+\]$/)) {
      const raw = getAt(input, i.path) as { type?: unknown } | undefined;
      msg =
        raw && typeof raw === 'object' && !COMPONENT_TYPES.includes(raw.type as never)
          ? `unknown component type ${JSON.stringify(raw.type)}; use one of ${COMPONENT_TYPES.join(', ')}`
          : `invalid ${String(raw?.type ?? 'component')}: ${firstUnionIssue(i)}`;
    }
    return `- ${where}: ${msg}`;
  });
  throw new ConfigError(`Invalid dashboard spec:\n${lines.join('\n')}`);
}

function getAt(obj: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let cur: unknown = obj;
  for (const p of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[p];
  }
  if (cur === undefined && path.length && typeof obj === 'object') {
    // The preprocess step may have moved `items` under a section.
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.items) && path[0] === 'sections')
      return getAt({ sections: [{ items: o.items }] }, path);
  }
  return cur;
}

function firstUnionIssue(issue: z.core.$ZodIssue): string {
  const errors = (issue as { errors?: z.core.$ZodIssue[][] }).errors ?? [];
  // Pick the branch with the fewest problems: it is the one the author meant.
  const best = [...errors].sort((a, b) => a.length - b.length)[0] ?? [];
  return best
    .slice(0, 3)
    .map((e) => `${issuePath(e.path) || '(component)'} ${e.message}`)
    .join('; ');
}

export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'dashboard'
  );
}
