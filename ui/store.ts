import { decodeRows } from '../src/dashboards/core/encode';
import { applyFilters, isEmptyFilter } from '../src/dashboards/core/filter';
import { rankSeries } from '../src/dashboards/core/series';
import type {
  ActiveFilter,
  ColumnInfo,
  EncodedDataset,
  FilterValue,
  Row,
} from '../src/dashboards/core/types';

export interface DatasetEntry {
  info: EncodedDataset;
  rows: Row[];
  columns: Map<string, ColumnInfo>;
}

type Listener = (changed: Set<string>) => void;

/**
 * One store per dashboard: the datasets and every active filter (spec filters, facets and
 * selections made on charts). Filters scope every component bound to the same dataset, so all
 * numbers on the page agree.
 */
export class Store {
  readonly datasets = new Map<string, DatasetEntry>();
  private readonly filters = new Map<string, ActiveFilter>();
  private readonly listeners = new Set<Listener>();
  private readonly cache = new Map<string, Row[]>();
  private readonly orders = new Map<string, string[]>();
  private version = 0;
  readonly now = Date.now();

  constructor(datasets: EncodedDataset[]) {
    for (const d of datasets)
      this.datasets.set(d.name, {
        info: d,
        rows: decodeRows(d),
        columns: new Map(d.columns.map((c) => [c.name, c])),
      });
  }

  column(dataset: string, field: string): ColumnInfo | undefined {
    return this.datasets.get(dataset)?.columns.get(field);
  }

  allRows(dataset: string): Row[] {
    return this.datasets.get(dataset)?.rows ?? [];
  }

  /** Values of a field ranked by row count over the unfiltered data (fixes series colors). */
  seriesOrder(dataset: string, field: string): string[] {
    const key = `${dataset}\u0000${field}`;
    let order = this.orders.get(key);
    if (!order) {
      order = rankSeries(this.allRows(dataset), field, { agg: 'count' });
      this.orders.set(key, order);
    }
    return order;
  }

  /** Rows of `dataset` after every filter, optionally ignoring one (facets count without their own). */
  rows(dataset: string, exceptId?: string): Row[] {
    const key = `${this.version}|${dataset}|${exceptId ?? ''}`;
    let hit = this.cache.get(key);
    if (!hit) {
      hit = applyFilters(this.allRows(dataset), dataset, [...this.filters.values()], this.now, exceptId);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(key, hit);
    }
    return hit;
  }

  get(id: string): ActiveFilter | undefined {
    return this.filters.get(id);
  }

  active(): ActiveFilter[] {
    return [...this.filters.values()].filter((f) => !isEmptyFilter(f.value));
  }

  set(filter: ActiveFilter): void {
    this.filters.set(filter.id, filter);
    this.bump(filter.datasets);
  }

  update(id: string, value: FilterValue): void {
    const f = this.filters.get(id);
    if (!f) return;
    this.filters.set(id, { ...f, value });
    this.bump(f.datasets);
  }

  remove(id: string): void {
    const f = this.filters.get(id);
    if (!f) return;
    this.filters.delete(id);
    this.bump(f.datasets);
  }

  /** Reset every filter: spec filters return to empty, chart and facet selections go away. */
  clearAll(keep: (f: ActiveFilter) => boolean): void {
    const touched = new Set<string>();
    for (const [id, f] of [...this.filters]) {
      f.datasets.forEach((d) => touched.add(d));
      if (keep(f)) this.filters.set(id, { ...f, value: emptyOf(f.value) });
      else this.filters.delete(id);
    }
    this.bump([...touched]);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Serializable state of non-empty filters (for the URL). */
  snapshot(): Record<string, FilterValue> {
    const out: Record<string, FilterValue> = {};
    for (const f of this.active()) out[f.id] = f.value;
    return out;
  }

  private bump(datasets: string[]): void {
    this.version++;
    const changed = new Set(datasets);
    for (const l of this.listeners) l(changed);
  }
}

function emptyOf(v: FilterValue): FilterValue {
  switch (v.kind) {
    case 'values':
      return { kind: 'values', values: [] };
    case 'range':
      return { kind: 'range' };
    case 'time':
      return { kind: 'time', preset: 'all' };
    case 'search':
      return { kind: 'search', text: '' };
  }
}

/** URL hash state: `#f=<base64url JSON>`. Unknown or malformed hashes are ignored. */
export function encodeState(state: Record<string, FilterValue>): string {
  const json = JSON.stringify(state);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(hash: string): Record<string, FilterValue> | null {
  const m = /(?:^#|&)f=([A-Za-z0-9_-]+)/.exec(hash);
  if (!m) return null;
  try {
    const b64 = m[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, FilterValue>) : null;
  } catch {
    return null;
  }
}
