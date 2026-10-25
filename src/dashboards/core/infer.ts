import { toTime } from './time';
import type { ColumnInfo, ColumnType, Row } from './types';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const URL_RE = /^https?:\/\/\S+$/i;

export function isMissing(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

/** Infer a column type from sample values. Strings that all look numeric become numbers. */
export function inferType(values: unknown[]): ColumnType {
  const present = values.filter((v) => !isMissing(v)).slice(0, 1000);
  if (present.length === 0) return 'string';
  const all = (pred: (v: unknown) => boolean) => present.every(pred);
  if (all((v) => typeof v === 'boolean' || v === 'true' || v === 'false')) return 'boolean';
  if (all((v) => typeof v === 'number' || (typeof v === 'string' && NUMBER_RE.test(v.trim())))) {
    return all((v) => Number.isInteger(Number(v))) ? 'integer' : 'number';
  }
  if (all((v) => typeof v === 'string' && DATE_RE.test(v))) return 'date';
  if (all((v) => typeof v === 'string' && (DATETIME_RE.test(v) || DATE_RE.test(v)))) return 'datetime';
  if (all((v) => typeof v === 'object')) return 'json';
  if (all((v) => typeof v === 'string' && URL_RE.test(v))) return 'url';
  return 'string';
}

/** Convert a raw value to the column's type (numbers from strings, booleans, ISO dates). */
export function coerceValue(v: unknown, type: ColumnType): unknown {
  if (isMissing(v)) return null;
  switch (type) {
    case 'number':
    case 'integer': {
      const n = typeof v === 'number' ? v : Number(String(v).trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'boolean':
      return v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
    case 'date':
    case 'datetime': {
      if (typeof v === 'string' && (DATE_RE.test(v) || DATETIME_RE.test(v))) return v;
      const t = toTime(v);
      if (t === null) return null;
      const iso = new Date(t).toISOString();
      return type === 'date' ? iso.slice(0, 10) : iso;
    }
    case 'json':
      return v;
    default:
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
  }
}

/** Columns in first-seen order with inferred types; `overrides` set labels, formats or types. */
export function inferColumns(
  rows: Row[],
  overrides: Record<string, Partial<Omit<ColumnInfo, 'name'>>> = {},
): ColumnInfo[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 2000))
    for (const k of Object.keys(r))
      if (!seen.has(k)) {
        seen.add(k);
        names.push(k);
      }
  for (const k of Object.keys(overrides)) if (!seen.has(k)) names.push(k);
  return names.map((name) => {
    const o = overrides[name] ?? {};
    const sample = rows.length > 1000 ? sampleEvenly(rows, 1000) : rows;
    return {
      name,
      type: o.type ?? inferType(sample.map((r) => r[name])),
      ...(o.label ? { label: o.label } : {}),
      ...(o.format ? { format: o.format } : {}),
      ...(o.description ? { description: o.description } : {}),
    };
  });
}

function sampleEvenly<T>(items: T[], n: number): T[] {
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)]!);
}

/** Coerce every row to the inferred column types (rows keep only known columns). */
export function normalizeRows(rows: Row[], columns: ColumnInfo[]): Row[] {
  return rows.map((r) => {
    const out: Row = {};
    for (const c of columns) out[c.name] = coerceValue(r[c.name], c.type);
    return out;
  });
}

export function isNumericType(t: ColumnType): boolean {
  return t === 'number' || t === 'integer';
}

export function isTimeType(t: ColumnType): boolean {
  return t === 'date' || t === 'datetime';
}

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  count: number;
  nulls: number;
  distinct: number;
  min?: number | string;
  max?: number | string;
  mean?: number;
  median?: number;
  top: Array<{ value: string; count: number }>;
  /** Sample of distinct values, for text columns. */
  examples: string[];
}

export function quantile(sorted: number[], q: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Summary statistics for one column: completeness, cardinality, range and top values. */
export function profileColumn(column: ColumnInfo, rows: Row[], topN = 5): ColumnProfile {
  const values = rows.map((r) => r[column.name]);
  const present = values.filter((v) => !isMissing(v));
  const counts = new Map<string, number>();
  for (const v of present) {
    const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([value, count]) => ({ value, count }));
  const profile: ColumnProfile = {
    name: column.name,
    type: column.type,
    count: values.length,
    nulls: values.length - present.length,
    distinct: counts.size,
    top,
    examples: [...counts.keys()].slice(0, 3),
  };
  if (isNumericType(column.type)) {
    const nums = present
      .map(Number)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (nums.length) {
      profile.min = nums[0];
      profile.max = nums[nums.length - 1];
      profile.mean = nums.reduce((s, n) => s + n, 0) / nums.length;
      profile.median = quantile(nums, 0.5);
    }
  } else if (isTimeType(column.type)) {
    const times = present.map(toTime).filter((t): t is number => t !== null);
    if (times.length) {
      const lo = Math.min(...times);
      const hi = Math.max(...times);
      const iso = (t: number) =>
        column.type === 'date' ? new Date(t).toISOString().slice(0, 10) : new Date(t).toISOString();
      profile.min = iso(lo);
      profile.max = iso(hi);
    }
  }
  return profile;
}

/** A compact, model-readable profile of a dataset (used by the profile_data tool). */
export function describeProfile(name: string, columns: ColumnInfo[], rows: Row[]): string {
  const lines = [`Dataset ${name}: ${rows.length.toLocaleString('en-US')} rows, ${columns.length} columns`];
  for (const c of columns) {
    const p = profileColumn(c, rows, 3);
    const filled = p.count ? Math.round(((p.count - p.nulls) / p.count) * 100) : 0;
    let detail = `${p.distinct} distinct`;
    if (p.min !== undefined) detail += `, min ${p.min}, max ${p.max}`;
    if (p.mean !== undefined) detail += `, mean ${Number(p.mean.toPrecision(4))}`;
    if (!isNumericType(c.type) && !isTimeType(c.type) && p.top.length)
      detail += `, top: ${p.top.map((t) => `${truncate(t.value, 40)} (${t.count})`).join('; ')}`;
    lines.push(`- ${c.name} [${c.type}] ${filled}% filled, ${detail}`);
  }
  return lines.join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '\u2026' : s;
}
