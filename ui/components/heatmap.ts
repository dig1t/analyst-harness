import { aggregate, groupBy } from '../../src/dashboards/core/aggregate';
import { valueKey } from '../../src/dashboards/core/filter';
import { formatTime } from '../../src/dashboards/core/format';
import { isTimeType } from '../../src/dashboards/core/infer';
import { sequentialStep } from '../../src/dashboards/core/palette';
import { bandScale } from '../../src/dashboards/core/scales';
import { autoInterval, floorTime, toTime } from '../../src/dashboards/core/time';
import type { Interval, Row } from '../../src/dashboards/core/types';
import type { TableData } from '../card';
import {
  aggFormatter,
  AXIS_FONT,
  ChartComponent,
  columnLabel,
  drawBandAxis,
  frame,
  keyLabel,
} from '../chart';
import { h, s, textWidth } from '../dom';
import { hideTooltip, showTooltip } from '../overlay';
import type { App, ComponentOf } from '../types';

const GAP = 2;

interface Axis {
  keys: string[];
  labels: Map<string, string>;
  keyOf: (r: Row) => string | null;
}

function axisFor(
  app: App,
  data: string,
  rows: Row[],
  field: string,
  interval: string | undefined,
  top: number | undefined,
  value: Parameters<typeof aggregate>[1],
): Axis {
  const col = app.store.column(data, field);
  if (col && isTimeType(col.type)) {
    const ts = rows.map((r) => toTime(r[field])).filter((t): t is number => t !== null);
    const iv: Interval =
      interval && interval !== 'auto'
        ? (interval as Interval)
        : autoInterval(Math.min(...ts), Math.max(...ts), 36);
    const keyOf = (r: Row) => {
      const t = toTime(r[field]);
      return t === null ? null : String(floorTime(t, iv));
    };
    const keys = [...new Set(rows.map(keyOf).filter((k): k is string => k !== null))].sort(
      (a, b) => Number(a) - Number(b),
    );
    const kept = top ? keys.slice(-top) : keys;
    return {
      keys: kept,
      labels: new Map(kept.map((k) => [k, formatTime(Number(k), iv, app.locale)])),
      keyOf,
    };
  }
  const keyOf = (r: Row) => valueKey(r[field]);
  const groups = groupBy(rows, keyOf);
  const keys = [...groups.entries()]
    .map(([k, g]) => ({ k, v: aggregate(g, value) ?? 0 }))
    .sort((a, b) => b.v - a.v || a.k.localeCompare(b.k))
    .map((x) => x.k)
    .slice(0, top ?? 25);
  const label = keyLabel(app, data, field);
  return { keys, labels: new Map(keys.map((k) => [k, label(k)])), keyOf };
}

export class HeatmapChart extends ChartComponent<ComponentOf<'heatmap'>> {
  private cells: Array<{ x: string; y: string; v: number | null }> = [];
  private axes?: { x: Axis; y: Axis };

  protected draw(rows: Row[], width: number): void {
    const { def, app } = this;
    const xa = axisFor(app, def.data, rows, def.x.field, def.x.interval, def.x.top, def.value);
    const ya = axisFor(app, def.data, rows, def.y.field, def.y.interval, def.y.top ?? 20, def.value);
    this.axes = { x: xa, y: ya };
    const grid = new Map<string, Row[]>();
    for (const r of rows) {
      const kx = xa.keyOf(r);
      const ky = ya.keyOf(r);
      if (kx === null || ky === null) continue;
      const k = `${ky}\u0000${kx}`;
      const g = grid.get(k);
      if (g) g.push(r);
      else grid.set(k, [r]);
    }
    this.cells = [];
    for (const ky of ya.keys)
      for (const kx of xa.keys) {
        const g = grid.get(`${ky}\u0000${kx}`);
        this.cells.push({ x: kx, y: ky, v: g ? aggregate(g, def.value) : null });
      }
    const vals = this.cells.map((c) => c.v).filter((v): v is number => v !== null);
    if (!vals.length) return;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const labelWidth = Math.min(
      200,
      Math.ceil(Math.max(...ya.keys.map((k) => textWidth(ya.labels.get(k) ?? k, AXIS_FONT)))) + 14,
    );
    const rowH = Math.max(18, Math.min(34, Math.floor((this.height - 40) / Math.max(1, ya.keys.length))));
    const height = Math.max(this.height, ya.keys.length * rowH + 40);
    const f = frame(width, height, labelWidth);
    const xb = bandScale(xa.keys, [f.x0, f.x1], 0, 0);
    const yb = bandScale(ya.keys, [f.y1, f.y0], 0, 0);
    const fmt = aggFormatter(app, def.data, def.value, def.format);
    const svg = this.newSvg(
      width,
      height,
      `${ya.keys.length} rows by ${xa.keys.length} columns, darker means larger.`,
    );
    const axes = s('g', { class: 'hx-axes' });
    svg.appendChild(axes);
    drawBandAxis(axes, f, xb, xa.labels);
    for (const k of ya.keys)
      axes.appendChild(
        s(
          'text',
          {
            class: 'hx-tick hx-cat',
            x: f.x0 - 8,
            y: yb(k)! + yb.bandwidth / 2,
            'text-anchor': 'end',
            'dominant-baseline': 'middle',
          },
          ya.labels.get(k) ?? k,
        ),
      );
    const marks = s('g', { class: 'hx-marks' });
    svg.appendChild(marks);
    const xName = def.x.label ?? columnLabel(app, def.data, def.x.field);
    const yName = def.y.label ?? columnLabel(app, def.data, def.y.field);
    for (const c of this.cells) {
      const cx = xb(c.x)!;
      const cy = yb(c.y)!;
      const w = Math.max(1, xb.bandwidth - GAP);
      const hgt = Math.max(1, yb.bandwidth - GAP);
      const step = c.v === null ? -1 : sequentialStep(hi === lo ? 1 : (c.v - lo) / (hi - lo));
      const rect = s('rect', {
        class: `hx-cell${c.v === null ? ' empty' : ''}`,
        x: cx + GAP / 2,
        y: cy + GAP / 2,
        width: w,
        height: hgt,
        rx: 2,
        style: c.v === null ? undefined : `fill: var(--seq-${step})`,
      });
      rect.addEventListener('pointermove', (ev) => {
        rect.classList.add('hover');
        showTooltip(ev.clientX, ev.clientY, `${ya.labels.get(c.y)} \u00b7 ${xa.labels.get(c.x)}`, [
          {
            label: '',
            value: c.v === null ? 'no data' : fmt(c.v),
            color: c.v === null ? undefined : `var(--seq-${step})`,
            key: 'rect',
          },
          { label: yName, value: ya.labels.get(c.y) ?? c.y, muted: true },
          { label: xName, value: xa.labels.get(c.x) ?? c.x, muted: true },
        ]);
      });
      rect.addEventListener('pointerleave', () => {
        rect.classList.remove('hover');
        hideTooltip();
      });
      marks.appendChild(rect);
      if (c.v !== null) {
        const text = fmt(c.v);
        if (textWidth(text, 10.5) + 8 < w && hgt >= 16)
          marks.appendChild(
            s(
              'text',
              {
                class: `hx-cell-label ${step >= 7 ? 'hi' : 'lo'}`,
                x: cx + GAP / 2 + w / 2,
                y: cy + GAP / 2 + hgt / 2,
                'text-anchor': 'middle',
                'dominant-baseline': 'central',
              },
              text,
            ),
          );
      }
    }
    this.legendSlot.appendChild(
      h(
        'div',
        { class: 'hx-scale-legend', 'aria-label': `Color scale from ${fmt(lo)} to ${fmt(hi)}` },
        h('span', null, fmt(lo)),
        h('span', { class: 'hx-scale-ramp', 'aria-hidden': 'true' }),
        h('span', null, fmt(hi)),
      ),
    );
  }

  protected tableData(): TableData {
    const { def, app } = this;
    const fmtType =
      def.value.agg === 'count' || def.value.agg === 'distinct' ? ('integer' as const) : ('number' as const);
    const ax = this.axes;
    return {
      columns: [
        { key: 'y', label: def.y.label ?? columnLabel(app, def.data, def.y.field), type: 'string' },
        { key: 'x', label: def.x.label ?? columnLabel(app, def.data, def.x.field), type: 'string' },
        { key: 'v', label: def.title ?? 'Value', type: fmtType, format: def.format ?? def.value.format },
      ],
      rows: this.cells
        .filter((c) => c.v !== null)
        .map((c) => ({ y: ax?.y.labels.get(c.y) ?? c.y, x: ax?.x.labels.get(c.x) ?? c.x, v: c.v })),
    };
  }
}
