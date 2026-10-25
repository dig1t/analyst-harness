import { aggLabel, aggregate } from '../../src/dashboards/core/aggregate';
import { formatTime, makeFormatter } from '../../src/dashboards/core/format';
import { isTimeType } from '../../src/dashboards/core/infer';
import { linearScale, valueDomain } from '../../src/dashboards/core/scales';
import { foldSeries, rankSeries, seriesOf } from '../../src/dashboards/core/series';
import { autoInterval, floorTime, timeBuckets, toTime } from '../../src/dashboards/core/time';
import { OTHER_SERIES, type Interval, type Row } from '../../src/dashboards/core/types';
import type { TableData } from '../card';
import {
  aggFormatter,
  ChartComponent,
  columnLabel,
  drawNumberAxis,
  drawTimeAxis,
  drawYAxis,
  frame,
  isFilledAgg,
  keyLabel,
  legend,
  seriesPalette,
  tickFormatter,
  yLabelWidth,
} from '../chart';
import { s, textWidth } from '../dom';
import { hideTooltip, showTooltip, type TooltipRow } from '../overlay';
import type { ComponentOf } from '../types';

interface Series {
  key: string;
  label: string;
  color: string;
  values: Array<number | null>;
  /** Stack base and top per bucket (equal to [0, value] when not stacked). */
  base: number[];
  top: Array<number | null>;
}

interface Model {
  buckets: number[];
  interval: Interval | null;
  series: Series[];
  bucketLabel: (b: number) => string;
}

export class LineChart extends ChartComponent<ComponentOf<'line'> | ComponentOf<'area'>> {
  private model?: Model;

  private build(rows: Row[], width: number): Model | null {
    const { def, app } = this;
    const store = app.store;
    const xCol = store.column(def.data, def.x.field);
    const time = !!xCol && isTimeType(xCol.type);
    const xOf = (r: Row): number | null => {
      const v = r[def.x.field];
      if (time) return toTime(v);
      const n = typeof v === 'number' ? v : Number(v);
      return v === null || v === undefined || !Number.isFinite(n) ? null : n;
    };
    const sField = def.series?.field;
    let keys = [''];
    let kept = new Set<string>();
    if (sField) {
      const ranked = rankSeries(store.allRows(def.data), sField, def.y);
      const folded = foldSeries(ranked, def.series?.top ?? 8);
      keys = folded.folded.length ? [...folded.kept, OTHER_SERIES] : folded.kept;
      kept = new Set(folded.kept);
    }
    const order = keys.filter((k) => k !== OTHER_SERIES);
    const colorOf = sField ? seriesPalette(app, def.data, sField, order) : () => 'var(--series-1)';
    const seriesLabel = sField ? keyLabel(app, def.data, sField) : (k: string) => k;
    const xs = rows.map(xOf).filter((v): v is number => v !== null);
    if (xs.length === 0) return null;
    const lo = Math.min(...xs);
    const hi = Math.max(...xs);
    const interval: Interval | null = time
      ? def.x.interval && def.x.interval !== 'auto'
        ? (def.x.interval as Interval)
        : autoInterval(lo, hi, Math.max(12, Math.min(180, Math.floor(width / 7))))
      : null;
    const bucketOf = (v: number) => (interval ? floorTime(v, interval) : v);
    const groups = new Map<string, Map<number, Row[]>>();
    for (const r of rows) {
      const xv = xOf(r);
      if (xv === null) continue;
      const k = sField ? seriesOf(r, sField, kept) : '';
      let byBucket = groups.get(k);
      if (!byBucket) groups.set(k, (byBucket = new Map()));
      const b = bucketOf(xv);
      const g = byBucket.get(b);
      if (g) g.push(r);
      else byBucket.set(b, [r]);
    }
    const buckets = interval
      ? timeBuckets(lo, hi, interval)
      : [...new Set([...groups.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => a - b);
    const fill = isFilledAgg(def.y);
    const yName =
      def.y.label ?? aggLabel(def.y, def.y.field ? columnLabel(app, def.data, def.y.field) : undefined);
    const series: Series[] = keys
      .filter((k) => groups.has(k))
      .map((k) => {
        const byBucket = groups.get(k)!;
        const values = buckets.map((b) => {
          const g = byBucket.get(b);
          return g ? aggregate(g, def.y) : fill ? 0 : null;
        });
        return {
          key: k,
          label: k ? seriesLabel(k) : yName,
          color: colorOf(k),
          values,
          base: buckets.map(() => 0),
          top: values,
        };
      });
    if (def.type === 'area' && def.stack && series.length > 1) {
      const acc = buckets.map(() => 0);
      for (const sr of series) {
        sr.base = [...acc];
        sr.top = sr.values.map((v, i) => (acc[i] = acc[i]! + (v ?? 0)));
      }
    }
    const fmtX = interval
      ? (b: number) => formatTime(b, interval, app.locale)
      : (b: number) => makeFormatter(def.x.format, xCol?.type ?? 'number', app.locale)(b);
    return { buckets, interval, series, bucketLabel: fmtX };
  }

  protected draw(rows: Row[], width: number): void {
    const { def, app } = this;
    const model = this.build(rows, width);
    this.model = model ?? undefined;
    if (!model) {
      this.plot.appendChild(s('svg', { width: 0, height: 0 }));
      this.card.setNote(`No values in ${def.x.field}`);
      return;
    }
    const { buckets, series } = model;
    const height = this.height;
    const includeZero = def.type === 'area' || isFilledAgg(def.y);
    const tops = series.flatMap((sr) => sr.top.filter((v): v is number => v !== null));
    const refs = def.reference.map((r) => r.value);
    const { ticks, step } = valueDomain(
      [...tops, ...refs],
      includeZero,
      Math.max(3, Math.floor(height / 60)),
    );
    const tickFmt = tickFormatter(app, def.y.format);
    const valueFmt = aggFormatter(app, def.data, def.y);
    const multi = series.length > 1;
    // Direct labels: the end value for one series, series names for up to four.
    const lastIdx = (sr: Series) => {
      for (let i = sr.top.length - 1; i >= 0; i--) if (sr.top[i] !== null) return i;
      return -1;
    };
    const endText = (sr: Series) => {
      const i = lastIdx(sr);
      return i < 0 ? '' : multi ? sr.label : valueFmt(sr.values[i]);
    };
    const wantEndLabels = series.length <= 4;
    const endWidth = wantEndLabels ? Math.max(0, ...series.map((sr) => textWidth(endText(sr), 11))) : 0;
    const f = frame(
      width,
      height,
      yLabelWidth(ticks, step, tickFmt),
      wantEndLabels ? Math.min(160, endWidth + 14) : 12,
    );
    const x0 = buckets[0]!;
    const x1 = buckets.length > 1 ? buckets[buckets.length - 1]! : x0 + 1;
    const x = linearScale([x0, x1], [f.x0, f.x1]);
    const y = linearScale([ticks[0]!, ticks[ticks.length - 1]!], [f.y0, f.y1]);
    const svg = this.newSvg(
      width,
      height,
      `${series.length} series over ${buckets.length} points, ${model.bucketLabel(x0)} to ${model.bucketLabel(buckets[buckets.length - 1]!)}.`,
    );
    svg.style.touchAction = 'pan-y';
    const axes = s('g', { class: 'hx-axes' });
    svg.appendChild(axes);
    drawYAxis(axes, f, y, ticks, step, tickFmt);
    if (model.interval) drawTimeAxis(axes, f, x, x0, buckets[buckets.length - 1]!, app.locale);
    else drawNumberAxis(axes, f, x, (v, st) => tickFormatter(app, def.x.format)(v, st));

    for (const ref of def.reference) {
      const py = Math.round(y(ref.value)) + 0.5;
      svg.appendChild(s('line', { class: 'hx-reference', x1: f.x0, x2: f.x1, y1: py, y2: py }));
      svg.appendChild(
        s('text', { class: 'hx-reference-label', x: f.x1, y: py - 5, 'text-anchor': 'end' }, ref.label),
      );
    }

    const emphasis = this.isolated ?? def.emphasis ?? null;
    const drawOrder = [...series].reverse();
    const marks = s('g', { class: 'hx-marks' });
    svg.appendChild(marks);
    for (const sr of drawOrder) {
      const dim = emphasis !== null && sr.key !== emphasis && sr.label !== emphasis;
      const color = dim ? 'var(--series-other)' : sr.color;
      const segments: Array<Array<[number, number, number]>> = [];
      let cur: Array<[number, number, number]> = [];
      sr.top.forEach((v, i) => {
        if (v === null) {
          if (cur.length) segments.push(cur);
          cur = [];
        } else cur.push([x(buckets[i]!), y(v), y(sr.base[i] ?? 0)]);
      });
      if (cur.length) segments.push(cur);
      for (const seg of segments) {
        if (def.type === 'area') {
          const top = seg.map(([px, py]) => `${px},${py}`).join('L');
          const bottom = [...seg]
            .reverse()
            .map(([px, , pb]) => `${px},${pb}`)
            .join('L');
          marks.appendChild(
            s('path', { class: 'hx-area', d: `M${top}L${bottom}Z`, style: `fill: ${color}` }),
          );
        }
        if (seg.length === 1) {
          marks.appendChild(
            s('circle', { class: 'hx-dot', cx: seg[0]![0], cy: seg[0]![1], r: 3, style: `fill: ${color}` }),
          );
        } else {
          marks.appendChild(
            s('path', {
              class: `hx-line${dim ? ' dim' : ''}`,
              d: 'M' + seg.map(([px, py]) => `${px},${py}`).join('L'),
              style: `stroke: ${color}`,
            }),
          );
        }
      }
      const li = lastIdx(sr);
      if (li >= 0 && !dim)
        marks.appendChild(
          s('circle', {
            class: 'hx-end-dot',
            cx: x(buckets[li]!),
            cy: y(sr.top[li]!),
            r: 4,
            style: `fill: ${color}`,
          }),
        );
    }

    if (wantEndLabels) {
      const placed = series
        .map((sr) => ({ sr, i: lastIdx(sr) }))
        .filter((p) => p.i >= 0)
        .map((p) => ({ text: endText(p.sr), py: y(p.sr.top[p.i]!), px: x(buckets[p.i]!) }))
        .sort((a, b) => a.py - b.py);
      const collide = placed.some((p, i) => i > 0 && p.py - placed[i - 1]!.py < 13);
      if (!collide)
        for (const p of placed)
          svg.appendChild(
            s('text', { class: 'hx-end-label', x: p.px + 8, y: p.py, 'dominant-baseline': 'middle' }, p.text),
          );
    }

    if (multi)
      this.legendSlot.appendChild(
        legend(
          series.map((sr) => ({
            key: sr.key,
            label: sr.label,
            color: sr.color,
            kind: def.type === 'area' ? 'rect' : 'line',
          })),
          this.isolated,
          (k) => this.toggleIsolation(k),
        )!,
      );
    if (def.series && series.some((sr) => sr.key === OTHER_SERIES))
      this.card.setNote(
        `Top ${series.length - 1} ${columnLabel(app, def.data, def.series.field)} values; the rest are combined as Other`,
      );
    else this.card.setNote(null);

    this.interact(svg, f, x, y, model, valueFmt);
  }

  private interact(
    svg: SVGSVGElement,
    f: ReturnType<typeof frame>,
    x: ReturnType<typeof linearScale>,
    y: ReturnType<typeof linearScale>,
    model: Model,
    valueFmt: (v: unknown) => string,
  ): void {
    const { buckets, series } = model;
    const cross = s('g', { class: 'hx-crosshair', visibility: 'hidden' });
    const rule = s('line', { class: 'hx-cross-rule', y1: f.y1, y2: f.y0 });
    cross.appendChild(rule);
    const dots = series.map((sr) => {
      const c = s('circle', { class: 'hx-cross-dot', r: 4, style: `fill: ${sr.color}` });
      cross.appendChild(c);
      return c;
    });
    const brush = s('rect', {
      class: 'hx-brush',
      y: f.y1,
      height: f.y0 - f.y1,
      width: 0,
      visibility: 'hidden',
    });
    const overlay = s('rect', {
      class: 'hx-overlay',
      x: f.x0,
      y: f.y1,
      width: f.x1 - f.x0,
      height: f.y0 - f.y1,
    });
    svg.append(cross, brush, overlay);
    let index = -1;
    const nearest = (px: number) => {
      const v = x.invert(px);
      let lo = 0;
      let hi = buckets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (buckets[mid]! < v) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0 && Math.abs(buckets[lo - 1]! - v) < Math.abs(buckets[lo]! - v)) lo--;
      return lo;
    };
    const show = (i: number, clientX?: number, clientY?: number) => {
      index = i;
      const b = buckets[i]!;
      const px = x(b);
      rule.setAttribute('x1', String(px));
      rule.setAttribute('x2', String(px));
      series.forEach((sr, si) => {
        const v = sr.top[i];
        const dot = dots[si]!;
        if (v === null || v === undefined) {
          dot.setAttribute('visibility', 'hidden');
        } else {
          dot.setAttribute('visibility', 'visible');
          dot.setAttribute('cx', String(px));
          dot.setAttribute('cy', String(y(v)));
        }
      });
      // One tooltip, every series at this x: largest first, missing values last.
      const rows: TooltipRow[] = series
        .map((sr) => ({ sr, v: sr.values[i] ?? null }))
        .sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))
        .map(({ sr, v }) => ({
          label: sr.label,
          value: v === null ? 'no data' : valueFmt(v),
          color: sr.color,
          key: 'line' as const,
          muted: v === null,
        }));
      cross.setAttribute('visibility', 'visible');
      const box = svg.getBoundingClientRect();
      showTooltip(
        clientX ?? box.left + px,
        clientY ?? box.top + f.y1,
        model.bucketLabel(b),
        rows,
        model.interval ? 'Drag across the chart to filter this range' : undefined,
      );
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      hideTooltip();
    };
    let dragStart: number | null = null;
    const local = (ev: PointerEvent) => ev.clientX - svg.getBoundingClientRect().left;
    overlay.addEventListener('pointermove', (ev) => {
      const px = Math.max(f.x0, Math.min(f.x1, local(ev)));
      if (dragStart !== null && model.interval) {
        const a = Math.min(dragStart, px);
        brush.setAttribute('x', String(a));
        brush.setAttribute('width', String(Math.abs(px - dragStart)));
        brush.setAttribute('visibility', Math.abs(px - dragStart) > 4 ? 'visible' : 'hidden');
      }
      show(nearest(px), ev.clientX, ev.clientY);
    });
    overlay.addEventListener('pointerleave', () => {
      if (dragStart === null) hide();
    });
    overlay.addEventListener('pointerdown', (ev) => {
      if (!model.interval || ev.button !== 0) return;
      dragStart = Math.max(f.x0, Math.min(f.x1, local(ev)));
      overlay.setPointerCapture(ev.pointerId);
    });
    overlay.addEventListener('pointerup', (ev) => {
      if (dragStart === null) return;
      const end = Math.max(f.x0, Math.min(f.x1, local(ev)));
      const start = dragStart;
      dragStart = null;
      brush.setAttribute('visibility', 'hidden');
      if (Math.abs(end - start) > 8 && model.interval) {
        const i0 = nearest(Math.min(start, end));
        const i1 = nearest(Math.max(start, end));
        const from = buckets[i0]!;
        const to = buckets[Math.min(buckets.length - 1, i1)]!;
        const toExclusive =
          i1 + 1 < buckets.length ? buckets[i1 + 1]! : to + (to - (buckets[i1 - 1] ?? to - 1));
        hide();
        this.app.setTimeRange(
          this.def.data,
          this.def.x.field,
          from,
          toExclusive,
          `${model.bucketLabel(from)} to ${model.bucketLabel(to)}`,
        );
      }
    });
    svg.addEventListener('keydown', (ev) => {
      if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
        ev.preventDefault();
        const next =
          index < 0
            ? ev.key === 'ArrowRight'
              ? 0
              : buckets.length - 1
            : Math.max(0, Math.min(buckets.length - 1, index + (ev.key === 'ArrowRight' ? 1 : -1)));
        show(next);
      } else if (ev.key === 'Escape') hide();
    });
    svg.addEventListener('blur', hide);
  }

  protected tableData(rows: Row[]): TableData {
    const model = this.model ?? this.build(rows, this.plot.clientWidth || 600);
    const { def, app } = this;
    if (!model) return { columns: [], rows: [] };
    const xLabel = def.x.label ?? columnLabel(app, def.data, def.x.field);
    const yFormat = def.y.format;
    const yType = def.y.agg === 'count' || def.y.agg === 'distinct' ? 'integer' : 'number';
    return {
      columns: [
        { key: '__x', label: xLabel, type: 'string' },
        ...model.series.map((sr, i) => ({
          key: `s${i}`,
          label: sr.label,
          type: yType as 'integer' | 'number',
          format: yFormat,
        })),
      ],
      rows: model.buckets.map((b, bi) => {
        const r: Row = { __x: model.bucketLabel(b) };
        model.series.forEach((sr, i) => (r[`s${i}`] = sr.values[bi]));
        return r;
      }),
    };
  }
}
