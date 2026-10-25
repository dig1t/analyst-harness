/**
 * Types shared by the dashboard renderer (Node) and the dashboard components (browser).
 * Everything under core/ is plain TypeScript with no Node or DOM APIs, so both sides bundle it.
 */
export type ColumnType = 'number' | 'integer' | 'boolean' | 'date' | 'datetime' | 'string' | 'url' | 'json';

export interface ColumnInfo {
  name: string;
  type: ColumnType;
  label?: string;
  format?: string;
  description?: string;
}

export type Row = Record<string, unknown>;

/** A dataset as embedded in a page: column metadata plus rows as arrays (smaller than objects). */
export interface EncodedDataset {
  name: string;
  columns: ColumnInfo[];
  rows: unknown[][];
  description?: string;
  source?: { kind: 'sql' | 'dataset' | 'file' | 'values'; text: string };
  /** True when the source had more rows than the dataset's limit. */
  truncated?: boolean;
  totalRows?: number;
}

export type AggName =
  'count' | 'sum' | 'mean' | 'median' | 'min' | 'max' | 'distinct' | 'p10' | 'p90' | 'first' | 'last';

export interface AggSpec {
  agg: AggName;
  field?: string;
  /** For first/last: the field that orders rows (default: data order). */
  orderBy?: string;
}

export type Interval = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

export type TimePreset = 'all' | 'today' | '7d' | '30d' | '90d' | 'mtd' | 'ytd' | '12m';

/** The value of one active filter. */
export type FilterValue =
  | { kind: 'values'; values: string[] }
  | { kind: 'range'; min?: number; max?: number }
  | { kind: 'time'; preset?: TimePreset; from?: number; to?: number }
  | { kind: 'search'; text: string };

export interface ActiveFilter {
  id: string;
  /** Datasets the filter applies to. */
  datasets: string[];
  /** Fields it reads (several for a search filter). */
  fields: string[];
  value: FilterValue;
  /** Shown on the filter chip. */
  label?: string;
}

/** The string used for missing values in facets and filters. */
export const EMPTY_VALUE = '(empty)';
export const OTHER_SERIES = 'Other';
