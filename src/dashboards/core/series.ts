import { aggregate, groupBy } from './aggregate';
import { valueKey } from './filter';
import { isMissing } from './infer';
import { OTHER_SERIES, type AggSpec, type Row } from './types';

/** Categorical slots available to series; past this, the tail folds into "Other". */
export const MAX_SERIES = 8;
/** Charts where any two marks can sit side by side (scatter) validate only three slots. */
export const MAX_SCATTER_SERIES = 3;

/** Series values ranked by their aggregate over all rows, largest first. */
export function rankSeries(rows: Row[], field: string, value: AggSpec): string[] {
  const groups = groupBy(rows, (r) => valueKey(r[field]));
  return [...groups.entries()]
    .map(([k, g]) => ({ k, v: aggregate(g, value) ?? 0 }))
    .sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
    .map((x) => x.k);
}

/**
 * Keep the top `limit` series and fold the rest into "Other". Colors follow the entity: the
 * returned order is fixed from the unfiltered data, so filters never repaint survivors.
 */
export function foldSeries(ranked: string[], limit: number): { kept: string[]; folded: string[] } {
  const cap = Math.max(1, Math.min(limit, MAX_SERIES));
  if (ranked.length <= cap) return { kept: ranked, folded: [] };
  return { kept: ranked.slice(0, cap - 1), folded: ranked.slice(cap - 1) };
}

/** Map a row to its series label, given the kept series. */
export function seriesOf(row: Row, field: string | undefined, kept: Set<string>): string {
  if (!field) return '';
  const k = valueKey(row[field]);
  return kept.has(k) ? k : OTHER_SERIES;
}

/**
 * Colors that follow the entity across a whole dashboard. `pageOrder` ranks every value of the
 * field by row count over the unfiltered dataset, and each kept series takes the slot of its
 * page rank, so two charts of the same field agree even when they rank or cut series
 * differently. A kept value outside the page's top slots takes the lowest slot left free.
 */
export function assignSeriesColors(kept: string[], pageOrder: string[]): Map<string, string> {
  const out = new Map<string, string>([[OTHER_SERIES, 'var(--series-other)']]);
  const used = new Set<number>();
  const pending: string[] = [];
  for (const k of kept) {
    if (k === OTHER_SERIES) continue;
    const i = pageOrder.indexOf(k);
    if (i >= 0 && i < MAX_SERIES) {
      out.set(k, `var(--series-${i + 1})`);
      used.add(i);
    } else pending.push(k);
  }
  let slot = 0;
  for (const k of pending) {
    while (used.has(slot)) slot++;
    out.set(k, slot < MAX_SERIES ? `var(--series-${slot + 1})` : 'var(--series-other)');
    used.add(slot);
  }
  return out;
}

export function hasValue(row: Row, field: string): boolean {
  return !isMissing(row[field]);
}
