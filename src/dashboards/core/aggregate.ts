import { isMissing, quantile } from './infer';
import { toTime } from './time';
import type { AggSpec, Row } from './types';

function numbers(rows: Row[], field: string): number[] {
  const out: number[] = [];
  for (const r of rows) {
    const v = r[field];
    if (isMissing(v)) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function ordered(rows: Row[], orderBy?: string): Row[] {
  if (!orderBy) return rows;
  return rows
    .map((r, i) => ({ r, i, t: toTime(r[orderBy]) ?? (typeof r[orderBy] === 'number' ? r[orderBy] : null) }))
    .filter((x) => x.t !== null)
    .sort((a, b) => (a.t as number) - (b.t as number) || a.i - b.i)
    .map((x) => x.r);
}

/** Aggregate rows to one number. Empty input gives 0 for count/sum/distinct and null otherwise. */
export function aggregate(rows: Row[], spec: AggSpec): number | null {
  const { agg, field } = spec;
  if (agg === 'count') return field ? rows.filter((r) => !isMissing(r[field])).length : rows.length;
  if (!field) return null;
  if (agg === 'distinct') {
    const set = new Set<string>();
    for (const r of rows) if (!isMissing(r[field])) set.add(String(r[field]));
    return set.size;
  }
  if (agg === 'first' || agg === 'last') {
    const seq = ordered(rows, spec.orderBy).filter((r) => !isMissing(r[field]));
    const pick = agg === 'first' ? seq[0] : seq[seq.length - 1];
    if (!pick) return null;
    const n = Number(pick[field]);
    return Number.isFinite(n) ? n : null;
  }
  const nums = numbers(rows, field);
  if (agg === 'sum') return nums.reduce((s, n) => s + n, 0);
  if (nums.length === 0) return null;
  switch (agg) {
    case 'mean':
      return nums.reduce((s, n) => s + n, 0) / nums.length;
    case 'min':
      return nums.reduce((m, n) => (n < m ? n : m), Infinity);
    case 'max':
      return nums.reduce((m, n) => (n > m ? n : m), -Infinity);
    default: {
      const sorted = [...nums].sort((a, b) => a - b);
      const q = agg === 'median' ? 0.5 : agg === 'p10' ? 0.1 : 0.9;
      return quantile(sorted, q) ?? null;
    }
  }
}

/** Group rows by a key function, keeping first-seen key order. */
export function groupBy<K>(rows: Row[], key: (r: Row) => K): Map<K, Row[]> {
  const groups = new Map<K, Row[]>();
  for (const r of rows) {
    const k = key(r);
    const g = groups.get(k);
    if (g) g.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

export function aggLabel(spec: AggSpec, fieldLabel?: string): string {
  const name = fieldLabel ?? spec.field ?? '';
  switch (spec.agg) {
    case 'count':
      return spec.field ? `Count of ${name}` : 'Rows';
    case 'distinct':
      return `Distinct ${name}`;
    case 'sum':
      return `Total ${name}`;
    case 'mean':
      return `Average ${name}`;
    case 'median':
      return `Median ${name}`;
    case 'min':
      return `Minimum ${name}`;
    case 'max':
      return `Maximum ${name}`;
    case 'p10':
      return `10th percentile ${name}`;
    case 'p90':
      return `90th percentile ${name}`;
    case 'first':
      return `First ${name}`;
    case 'last':
      return `Latest ${name}`;
  }
}
