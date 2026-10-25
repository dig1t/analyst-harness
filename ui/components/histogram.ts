import { binLog, binWithTail, prefersLog, type Bin, type Tail } from '../../src/dashboards/core/bins';
import { makeFormatter } from '../../src/dashboards/core/format';
import { quantile } from '../../src/dashboards/core/infer';
import { linearScale, logScale, valueDomain } from '../../src/dashboards/core/scales';
import type { Row } from '../../src/dashboards/core/types';
import type { TableData } from '../card';
import {
  barPath,
  ChartComponent,
  columnLabel,
  drawLogAxis,
  drawNumberAxis,
  drawYAxis,
  frame,
  tickFormatter,
  yLabelWidth,
} from '../chart';
import { s, textWidth } from '../dom';
import { hideTooltip, showTooltip } from '../overlay';
import type { ComponentOf } from '../types';

/**
 * Distribution of one numeric field. Positive data spanning orders of magnitude (sizes,
 * prices, counts) switches to a log axis; a few extreme values fold into a labeled last bar.
 */
export class HistogramChart extends ChartComponent<ComponentOf<'histogram'>> {
  private bins: Bin[] = [];
  private tail: Tail | null = null;

  protected draw(rows: Row[], width: number): void {
    const { def, app } = this;
    const values = rows
      .map((r) => r[def.field])
      .filter((v) => v !== null && v !== undefined && v !== '')
      .map(Number)
      .filter(Number.isFinite);
    const log = def.scale === 'log' || (def.scale === 'auto' && prefersLog(values));
    const positive = log ? values.filter((v) => v > 0) : values;
    const binned = log ? { bins: binLog(positive), tail: null } : binWithTail(values, def.bins);
    this.bins = binned.bins;
    this.tail = binned.tail;
    const bins = binned.bins;
    if (bins.length === 0) {
      this.card.setNote(`No numeric values in ${def.field}`);
      return;
    }
    const counts = [...bins.map((b) => b.count), this.tail?.count ?? 0];
    const { ticks, step } = valueDomain(counts, true, Math.max(3, Math.floor(this.height / 60)));
    const yFmt = tickFormatter(app, undefined);
    const f = frame(width, this.height, yLabelWidth(ticks, step, yFmt));
    const tailWidth = this.tail ? Math.max(14, (f.x1 - f.x0) / (bins.length + 1)) : 0;
    const xDomain: [number, number] = [bins[0]!.x0, bins[bins.length - 1]!.x1];
    const px = (log ? logScale : linearScale)(xDomain, [f.x0, f.x1 - tailWidth]);
    const y = linearScale([ticks[0]!, ticks[ticks.length - 1]!], [f.y0, f.y1]);
    const label = def.label ?? columnLabel(app, def.data, def.field);
    const svg = this.newSvg(
      width,
      this.height,
      `Distribution of ${label} in ${bins.length} bins${log ? ' on a log scale' : ''}.`,
    );
    const axes = s('g', { class: 'hx-axes' });
    svg.appendChild(axes);
    drawYAxis(axes, f, y, ticks, step, yFmt);
    const fmt = makeFormatter(
      def.format,
      app.store.column(def.data, def.field)?.type ?? 'number',
      app.locale,
    );
    const tickFmt = tickFormatter(app, def.format);
    if (log) drawLogAxis(axes, f, px, tickFmt);
    else drawNumberAxis(axes, f, px, tickFmt);
    const marks = s('g', { class: 'hx-marks' });
    const hits = s('g', { class: 'hx-hits' });
    svg.append(marks, hits);
    const total = values.length;
    const bar = (x0: number, w: number, count: number, title: string) => {
      if (count > 0)
        marks.appendChild(
          s('path', {
            class: 'hx-bar',
            d: barPath(x0 + 1, y(count), Math.max(1, w - 2), Math.max(1, y(0) - y(count)), 'vertical'),
            style: 'fill: var(--series-1)',
          }),
        );
      const hit = s('rect', { class: 'hx-hit', x: x0, y: f.y1, width: Math.max(1, w), height: f.y0 - f.y1 });
      hit.addEventListener('pointermove', (ev) => {
        hit.classList.add('hover');
        showTooltip(ev.clientX, ev.clientY, title, [
          { label: 'rows', value: count.toLocaleString(app.locale), color: 'var(--series-1)', key: 'rect' },
          { label: 'of all values', value: `${((count / Math.max(1, total)) * 100).toFixed(1)}%` },
        ]);
      });
      hit.addEventListener('pointerleave', () => {
        hit.classList.remove('hover');
        hideTooltip();
      });
      hits.appendChild(hit);
    };
    for (const b of bins) bar(px(b.x0), px(b.x1) - px(b.x0), b.count, `${fmt(b.x0)} to ${fmt(b.x1)}`);
    if (this.tail) {
      const x0 = f.x1 - tailWidth + 3;
      bar(x0, tailWidth - 3, this.tail.count, `Above ${fmt(this.tail.from)} (largest ${fmt(this.tail.max)})`);
      axes.appendChild(
        s(
          'text',
          { class: 'hx-tick', x: x0 + (tailWidth - 3) / 2, y: f.y0 + 16, 'text-anchor': 'middle' },
          `${tickFmt(this.tail.from, this.tail.from)}+`,
        ),
      );
    }
    const median = quantile(
      [...values].sort((a, b) => a - b),
      0.5,
    );
    if (median !== undefined && (!log || median > 0)) {
      const m = Math.round(px(Math.min(median, bins[bins.length - 1]!.x1))) + 0.5;
      svg.insertBefore(s('line', { class: 'hx-reference', x1: m, x2: m, y1: f.y1, y2: f.y0 }), hits);
      const labelText = `Median ${fmt(median)}`;
      const anchorEnd = m + textWidth(labelText, 11) + 8 > f.x1;
      svg.insertBefore(
        s(
          'text',
          {
            class: 'hx-reference-label',
            x: anchorEnd ? m - 5 : m + 5,
            y: f.y1 + 10,
            'text-anchor': anchorEnd ? 'end' : 'start',
          },
          labelText,
        ),
        hits,
      );
    }
    const notes = [`${total.toLocaleString(app.locale)} values`];
    if (log) notes.push('log scale');
    if (log && positive.length < values.length)
      notes.push(`${values.length - positive.length} at or below zero not shown`);
    if (this.tail) notes.push(`the last bar holds ${this.tail.count} values above the 99th percentile`);
    this.card.setNote(notes.join('; '));
  }

  protected tableData(): TableData {
    const { def, app } = this;
    const fmt = makeFormatter(
      def.format,
      app.store.column(def.data, def.field)?.type ?? 'number',
      app.locale,
    );
    const rows = this.bins.map((b) => ({ range: `${fmt(b.x0)} to ${fmt(b.x1)}`, count: b.count }));
    if (this.tail) rows.push({ range: `Above ${fmt(this.tail.from)}`, count: this.tail.count });
    return {
      columns: [
        { key: 'range', label: def.label ?? columnLabel(app, def.data, def.field), type: 'string' },
        { key: 'count', label: 'Rows', type: 'integer' },
      ],
      rows,
    };
  }
}
