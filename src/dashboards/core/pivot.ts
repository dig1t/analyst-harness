import { aggregate, groupBy } from './aggregate';
import { valueKey } from './filter';
import type { AggSpec, Row } from './types';

export interface PivotResult {
  rowKeys: string[];
  colKeys: string[];
  /** cells[row][col] */
  cells: Map<string, Map<string, number | null>>;
  rowTotals: Map<string, number | null>;
  colTotals: Map<string, number | null>;
  total: number | null;
}

/**
 * Cross-tabulate rows by one or two fields. Totals re-aggregate the underlying rows (a median
 * of medians would be wrong). Row and column keys sort by their totals, largest first.
 */
export function pivot(
  rows: Row[],
  rowField: string,
  colField: string | undefined,
  value: AggSpec,
  limits: { rows?: number; cols?: number } = {},
): PivotResult {
  const byRow = groupBy(rows, (r) => valueKey(r[rowField]));
  const rowTotals = new Map<string, number | null>();
  for (const [k, g] of byRow) rowTotals.set(k, aggregate(g, value));
  const rowKeys = [...rowTotals.keys()]
    .sort((a, b) => (rowTotals.get(b) ?? -Infinity) - (rowTotals.get(a) ?? -Infinity) || a.localeCompare(b))
    .slice(0, limits.rows ?? 50);
  const colTotals = new Map<string, number | null>();
  let colKeys: string[] = [];
  if (colField) {
    const byCol = groupBy(rows, (r) => valueKey(r[colField]));
    for (const [k, g] of byCol) colTotals.set(k, aggregate(g, value));
    colKeys = [...colTotals.keys()]
      .sort((a, b) => (colTotals.get(b) ?? -Infinity) - (colTotals.get(a) ?? -Infinity) || a.localeCompare(b))
      .slice(0, limits.cols ?? 20);
  }
  const cells = new Map<string, Map<string, number | null>>();
  for (const rk of rowKeys) {
    const rowCells = new Map<string, number | null>();
    const g = byRow.get(rk) ?? [];
    if (colField) {
      const byCol = groupBy(g, (r) => valueKey(r[colField]));
      for (const ck of colKeys) rowCells.set(ck, byCol.has(ck) ? aggregate(byCol.get(ck)!, value) : null);
    }
    cells.set(rk, rowCells);
  }
  return { rowKeys, colKeys, cells, rowTotals, colTotals, total: aggregate(rows, value) };
}
