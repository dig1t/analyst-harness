import { formatTime } from '../../src/dashboards/core/format';
import { isTimeType } from '../../src/dashboards/core/infer';
import { sequentialStep } from '../../src/dashboards/core/palette';
import { pivot } from '../../src/dashboards/core/pivot';
import { autoInterval, floorTime, toTime } from '../../src/dashboards/core/time';
import type { Interval, Row } from '../../src/dashboards/core/types';
import { Card, emptyState } from '../card';
import { aggFormatter, columnLabel, keyLabel } from '../chart';
import { copyText, download, fileSlug, rowsToCsv } from '../export';
import { clear, h } from '../dom';
import type { App, ComponentOf, Component } from '../types';

/** Pivot table: rows by columns with re-aggregated totals and an optional sequential heat fill. */
export class PivotTable implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  private readonly card: Card;
  private lastCsv = '';

  constructor(
    private readonly app: App,
    private readonly def: ComponentOf<'pivot'>,
  ) {
    this.datasets = [def.data];
    this.card = new Card({
      title: def.title,
      subtitle: def.subtitle,
      className: 'hx-pivot',
      locale: app.locale,
      menu: () => [
        {
          label: 'Download CSV',
          onSelect: () => download(`${fileSlug(def.title ?? 'pivot')}.csv`, this.lastCsv, 'text/csv'),
          hidden: !app.downloads,
        },
        { label: 'Copy as CSV', onSelect: () => void copyText(this.lastCsv, 'Copied the pivot table') },
      ],
    });
    this.el = h('div', { class: `hx-item w-${def.width}` }, this.card.el);
    this.update();
  }

  /** Time fields pivot by period; the derived key is stored on a copy of each row. */
  private keyed(
    rows: Row[],
    field: string,
    interval: string | undefined,
  ): { rows: Row[]; field: string; label: (k: string) => string } {
    const col = this.app.store.column(this.def.data, field);
    if (!col || !isTimeType(col.type))
      return { rows, field, label: keyLabel(this.app, this.def.data, field) };
    const ts = rows.map((r) => toTime(r[field])).filter((t): t is number => t !== null);
    const iv: Interval =
      interval && interval !== 'auto'
        ? (interval as Interval)
        : autoInterval(Math.min(...ts), Math.max(...ts), 24);
    const key = `__${field}_${iv}`;
    return {
      rows: rows.map((r) => {
        const t = toTime(r[field]);
        return { ...r, [key]: t === null ? null : String(floorTime(t, iv)) };
      }),
      field: key,
      label: (k) => (k === '(empty)' ? k : formatTime(Number(k), iv, this.app.locale)),
    };
  }

  update(): void {
    const { app, def } = this;
    clear(this.card.body);
    let rows = app.store.rows(def.data);
    if (rows.length === 0) {
      this.card.body.appendChild(
        emptyState('No rows match the current filters.', {
          label: 'Clear filters',
          onClick: () => app.clearFilters(),
        }),
      );
      return;
    }
    const r = this.keyed(rows, def.rows.field, def.rows.interval);
    rows = r.rows;
    const c = def.columns ? this.keyed(rows, def.columns.field, def.columns.interval) : undefined;
    if (c) rows = c.rows;
    const result = pivot(rows, r.field, c?.field, def.value, {
      rows: def.rows.top ?? 25,
      cols: def.columns?.top ?? 12,
    });
    if (c && isTimeType(app.store.column(def.data, def.columns!.field)?.type ?? 'string'))
      result.colKeys.sort((a, b) => Number(a) - Number(b));
    if (isTimeType(app.store.column(def.data, def.rows.field)?.type ?? 'string'))
      result.rowKeys.sort((a, b) => Number(a) - Number(b));
    const fmt = aggFormatter(app, def.data, def.value, def.format);
    const values = [...result.cells.values()]
      .flatMap((m) => [...m.values()])
      .filter((v): v is number => v !== null);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const heat = (v: number | null) => {
      if (!def.heat || v === null || !c) return undefined;
      const step = sequentialStep(hi === lo ? 0.5 : (v - lo) / (hi - lo));
      return { style: `--cell: var(--seq-${step})`, cls: step >= 7 ? 'heat hi' : 'heat lo' };
    };
    const rowName = def.rows.label ?? columnLabel(app, def.data, def.rows.field);
    const colName = def.columns
      ? (def.columns.label ?? columnLabel(app, def.data, def.columns.field))
      : 'Value';
    const csvRows = result.rowKeys.map((rk) => {
      const o: Row = { [rowName]: r.label(rk) };
      if (c) for (const ck of result.colKeys) o[c.label(ck)] = result.cells.get(rk)?.get(ck) ?? null;
      o.Total = result.rowTotals.get(rk) ?? null;
      return o;
    });
    this.lastCsv = rowsToCsv(csvRows, [
      rowName,
      ...(c ? result.colKeys.map((k) => c.label(k)) : []),
      'Total',
    ]);
    const table = h(
      'table',
      { class: 'hx-table hx-pivot-table' },
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, c ? `${rowName} by ${colName}` : rowName),
          c ? result.colKeys.map((k) => h('th', { scope: 'col', class: 'num' }, c.label(k))) : null,
          def.totals || !c ? h('th', { scope: 'col', class: 'num total' }, c ? 'Total' : 'Value') : null,
        ),
      ),
      h(
        'tbody',
        null,
        result.rowKeys.map((rk) =>
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, r.label(rk)),
            c
              ? result.colKeys.map((ck) => {
                  const v = result.cells.get(rk)?.get(ck) ?? null;
                  const hcell = heat(v);
                  return h(
                    'td',
                    { class: `num ${hcell?.cls ?? ''}`, style: hcell?.style },
                    v === null ? '' : fmt(v),
                  );
                })
              : null,
            def.totals || !c ? h('td', { class: 'num total' }, fmt(result.rowTotals.get(rk))) : null,
          ),
        ),
      ),
      def.totals && c
        ? h(
            'tfoot',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'row' }, 'Total'),
              result.colKeys.map((ck) => h('td', { class: 'num total' }, fmt(result.colTotals.get(ck)))),
              h('td', { class: 'num total' }, fmt(result.total)),
            ),
          )
        : null,
    );
    this.card.body.appendChild(h('div', { class: 'hx-table-scroll' }, table));
    if (def.heat && c && values.length)
      this.card.body.appendChild(
        h(
          'div',
          { class: 'hx-scale-legend' },
          h('span', null, fmt(lo)),
          h('span', { class: 'hx-scale-ramp', 'aria-hidden': 'true' }),
          h('span', null, fmt(hi)),
        ),
      );
  }
}
