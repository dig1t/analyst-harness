import type { ColumnInfo, EncodedDataset, Row } from './types';

/** Rows as arrays in column order (about half the size of objects once serialized). */
export function encodeRows(columns: ColumnInfo[], rows: Row[]): unknown[][] {
  return rows.map((r) => columns.map((c) => (r[c.name] === undefined ? null : r[c.name])));
}

export function decodeRows(dataset: Pick<EncodedDataset, 'columns' | 'rows'>): Row[] {
  const names = dataset.columns.map((c) => c.name);
  return dataset.rows.map((arr) => {
    const r: Row = {};
    for (let i = 0; i < names.length; i++) r[names[i]!] = arr[i] ?? null;
    return r;
  });
}

/**
 * JSON that is safe inside `<script type="application/json">`: `<`, `>`, `&` and the line
 * separators are escaped, so data can never close the tag or start markup.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
