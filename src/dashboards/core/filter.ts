import { isMissing } from './infer';
import { presetRange, toTime } from './time';
import { EMPTY_VALUE, type ActiveFilter, type FilterValue, type Row } from './types';

/** The string a value filters and facets under (missing values group as "(empty)"). */
export function valueKey(v: unknown): string {
  if (isMissing(v)) return EMPTY_VALUE;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function isEmptyFilter(value: FilterValue): boolean {
  switch (value.kind) {
    case 'values':
      return value.values.length === 0;
    case 'range':
      return value.min === undefined && value.max === undefined;
    case 'time':
      return (!value.preset || value.preset === 'all') && value.from === undefined && value.to === undefined;
    case 'search':
      return value.text.trim() === '';
  }
}

/** Resolve a time filter to absolute bounds; `to` is exclusive. */
export function timeBounds(
  value: FilterValue & { kind: 'time' },
  now: number,
): { from?: number; to?: number } {
  if (value.from !== undefined || value.to !== undefined) return { from: value.from, to: value.to };
  return value.preset ? presetRange(value.preset, now) : {};
}

export function matchesFilter(row: Row, filter: ActiveFilter, now: number): boolean {
  const v = filter.value;
  switch (v.kind) {
    case 'values': {
      const set = new Set(v.values);
      return filter.fields.some((f) => set.has(valueKey(row[f])));
    }
    case 'range': {
      const n = Number(row[filter.fields[0]!]);
      if (isMissing(row[filter.fields[0]!]) || !Number.isFinite(n)) return false;
      return (v.min === undefined || n >= v.min) && (v.max === undefined || n <= v.max);
    }
    case 'time': {
      const { from, to } = timeBounds(v, now);
      const t = toTime(row[filter.fields[0]!]);
      if (t === null) return false;
      return (from === undefined || t >= from) && (to === undefined || t < to);
    }
    case 'search': {
      const terms = v.text.toLowerCase().split(/\s+/).filter(Boolean);
      const hay = filter.fields.map((f) => valueKey(row[f]).toLowerCase()).join(' \u0000 ');
      return terms.every((t) => hay.includes(t));
    }
  }
}

/** Keep the rows that pass every filter that applies to `dataset`, optionally skipping one. */
export function applyFilters(
  rows: Row[],
  dataset: string,
  filters: ActiveFilter[],
  now: number,
  exceptId?: string,
): Row[] {
  const active = filters.filter(
    (f) => f.id !== exceptId && f.datasets.includes(dataset) && !isEmptyFilter(f.value),
  );
  if (active.length === 0) return rows;
  return rows.filter((r) => active.every((f) => matchesFilter(r, f, now)));
}

/** Value counts for a facet, descending, ties alphabetical. */
export function facetCounts(rows: Row[], field: string): Array<{ value: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const k = valueKey(r[field]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
