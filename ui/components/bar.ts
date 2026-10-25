import { aggLabel, aggregate } from '../../src/dashboards/core/aggregate';
import { valueKey } from '../../src/dashboards/core/filter';
import { formatTime } from '../../src/dashboards/core/format';
import { isTimeType } from '../../src/dashboards/core/infer';
import { bandScale, linearScale, valueDomain } from '../../src/dashboards/core/scales';
import { foldSeries, rankSeries, seriesOf } from '../../src/dashboards/core/series';
import { addInterval, autoInterval, floorTime, toTime } from '../../src/dashboards/core/time';
import { OTHER_SERIES, type Interval, type Row } from '../../src/dashboards/core/types';
import type { TableData } from '../card';
import {
  aggFormatter,
  AXIS_FONT,
  barPath,
  ChartComponent,
  columnLabel,
  drawBandAxis,
  drawYAxis,
  frame,
  keyLabel,
  legend,
  seriesPalette,
  tickFormatter,
  yLabelWidth,
} from '../chart';
import { s, textWidth } from '../dom';
import { hideTooltip, showTooltip } from '../overlay';
import type { ComponentOf } from '../types';

const MAX_THICKNESS = 24;
const GAP = 2;

interface BarModel {
  cats: string[];
  labels: Map<string, string>;
  series: Array<{ key: string; label: string; color: string; values: Map<string, number | null> }>;
  total: number;
  interval: Interval | null;
}

export class BarChart extends ChartComponent<ComponentOf<'bar'>> {
  private model?: BarModel;

  /** The filter a click on this chart's bars sets (a spec select filter on the field, if any). */
  private get selectionId(): string {
    return (
      this.app.selectionFor(this.def.data, this.def.x.field)?.id ??
      `values:${this.def.data}:${this.def.x.field}`
    );
  }

  private build(rows: Row[]): BarModel {
    const { def, app } = this;
    const store = app.store;
    const xCol = store.column(def.data, def.x.field);
    const time = !!xCol && isTimeType(xCol.type);
    let interval: Interval | null = null;
    if (time) {
      const ts = rows.map((r) => toTime(r[def.x.field])).filter((t): t is number => t !== null);
      const lo = ts.length ? Math.min(...ts) : 0;
      const hi = ts.length ? Math.max(...ts) : 0;
      interval =
        def.x.interval && def.x.interval !== 'auto' ? (def.x.interval as Interval) : autoInterval(lo, hi, 40);
    }
    const catOf = (r: Row): string | null => {
      if (!interval) return valueKey(r[def.x.field]);
      const t = toTime(r[def.x.field]);
      return t === null ? null : String(floorTime(t, interval));
    };
    const sField = def.series?.field;
    let keys = [''];
    let kept = new Set<string>();
    if (sField) {
      const folded = foldSeries(rankSeries(store.allRows(def.data), sField, def.y), def.series?.top ?? 8);
      keys = folded.folded.length ? [...folded.kept, OTHER_SERIES] : folded.kept;
      kept = new Set(folded.kept);
    }
    const order = keys.filter((k) => k !== OTHER_SERIES);
    const byCat = new Map<string, Row[]>();
    for (const r of rows) {
      const c = catOf(r);
      if (c === null) continue;
      const g = byCat.get(c);
      if (g) g.push(r);
      else byCat.set(c, [r]);
    }
    const totals = new Map([...byCat].map(([c, g]) => [c, aggregate(g, def.y) ?? 0]));
    let cats = [...byCat.keys()];
    const sort = def.x.sort ?? (interval ? 'none' : 'value-desc');
    if (interval) cats.sort((a, b) => Number(a) - Number(b));
    else if (sort === 'value-desc')
      cats.sort((a, b) => totals.get(b)! - totals.get(a)! || a.localeCompare(b));
    else if (sort === 'value-asc') cats.sort((a, b) => totals.get(a)! - totals.get(b)! || a.localeCompare(b));
    else if (sort === 'label') cats.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const total = cats.length;
    const top = def.x.top ?? (interval ? 400 : 20);
    if (cats.length > top) cats = interval ? cats.slice(-top) : cats.slice(0, top);
    const colorOf = sField ? seriesPalette(app, def.data, sField, order) : () => 'var(--series-1)';
    const catLabel = keyLabel(app, def.data, def.x.field);
    const seriesLabel = sField ? keyLabel(app, def.data, sField) : (k: string) => k;
    const labels = new Map(
      cats.map((c) => [c, interval ? formatTime(Number(c), interval, app.locale) : catLabel(c)]),
    );
    const yName =
      def.y.label ?? aggLabel(def.y, def.y.field ? columnLabel(app, def.data, def.y.field) : undefined);
    const series = keys.map((k) => {
      const values = new Map<string, number | null>();
      for (const c of cats) {
        const g = (byCat.get(c) ?? []).filter((r) => !sField || seriesOf(r, sField, kept) === k);
        values.set(c, g.length ? aggregate(g, def.y) : null);
      }
      return {
        key: k,
        label: k ? seriesLabel(k) : yName,
        color: colorOf(k),
        values,
      };
    });
    return {
      cats,
      labels,
      series: series.filter((sr) => [...sr.values.values()].some((v) => v !== null)),
      total,
      interval,
    };
  }

  protected draw(_rows: Row[], width: number): void {
    const { def, app } = this;
    // A bar chart doubles as a selector: it ignores its own selection and dims the bars left out.
    const rows = app.store.rows(def.data, this.selectionId);
    const model = this.build(rows);
    this.model = model;
    const { cats, series } = model;
    if (cats.length === 0) return;
    const stacked = def.stack && series.length > 1;
    const maxLabel = Math.max(...cats.map((c) => (model.labels.get(c) ?? c).length));
    const horizontal =
      def.orientation === 'horizontal' ||
      (def.orientation === 'auto' && !model.interval && (cats.length > 8 || maxLabel > 10));
    const valueFmt = aggFormatter(app, def.data, def.y);
    const tickFmt = tickFormatter(app, def.y.format);
    const values = stacked
      ? cats.map((c) => series.reduce((sum, sr) => sum + (sr.values.get(c) ?? 0), 0))
      : series.flatMap((sr) => [...sr.values.values()].filter((v): v is number => v !== null));
    const single = series.length === 1;
    const showLabels = single && (def.labels === 'always' || (def.labels === 'auto' && cats.length <= 15));
    const selected = (c: string) => app.isSelected(def.data, def.x.field, c);
    const anySelected = !model.interval && cats.some(selected);
    const multi = series.length > 1;

    let svg: SVGSVGElement;
    let f: ReturnType<typeof frame>;
    const marks = s('g', { class: 'hx-marks' });
    const hits = s('g', { class: 'hx-hits' });
    const labelsG = s('g', { class: 'hx-value-labels' });

    if (horizontal) {
      const band = Math.max(
        MAX_THICKNESS + 10,
        multi && !stacked ? series.length * (MAX_THICKNESS / 2 + GAP) + 12 : MAX_THICKNESS + 10,
      );
      const height = Math.max(this.height, cats.length * band + 36);
      const catWidth = Math.min(
        220,
        Math.ceil(Math.max(...cats.map((c) => textWidth(model.labels.get(c) ?? c, AXIS_FONT)))) + 14,
      );
      const { ticks, step } = valueDomain(values, true, Math.max(2, Math.floor(width / 110)));
      const valueRoom = showLabels
        ? Math.ceil(Math.max(...values.map((v) => textWidth(valueFmt(v), AXIS_FONT)))) + 10
        : 12;
      f = frame(width, height, catWidth, valueRoom);
      const x = linearScale([ticks[0]!, ticks[ticks.length - 1]!], [f.x0, f.x1]);
      const yb = bandScale(cats, [f.y1, f.y0], 0.25, 0.1);
      svg = this.newSvg(width, height, `${cats.length} bars${multi ? `, ${series.length} series` : ''}.`);
      const axes = s('g', { class: 'hx-axes' });
      svg.appendChild(axes);
      for (const t of ticks) {
        const px = Math.round(x(t)) + 0.5;
        axes.appendChild(
          s('line', { class: t === 0 ? 'hx-baseline' : 'hx-gridline', x1: px, x2: px, y1: f.y1, y2: f.y0 }),
        );
        axes.appendChild(
          s('text', { class: 'hx-tick', x: px, y: f.y0 + 16, 'text-anchor': 'middle' }, tickFmt(t, step)),
        );
      }
      for (const c of cats) {
        const by = yb(c)!;
        const label = model.labels.get(c) ?? c;
        axes.appendChild(
          s(
            'text',
            {
              class: 'hx-tick hx-cat',
              x: f.x0 - 8,
              y: by + yb.bandwidth / 2,
              'text-anchor': 'end',
              'dominant-baseline': 'middle',
            },
            truncateTo(label, catWidth - 14),
          ),
        );
        const thickness = Math.min(MAX_THICKNESS, yb.bandwidth);
        const grouped = multi && !stacked;
        const t = grouped
          ? Math.min(16, (yb.bandwidth - (series.length - 1) * GAP) / series.length)
          : thickness;
        const groupHeight = grouped ? series.length * t + (series.length - 1) * GAP : thickness;
        let offset = by + (yb.bandwidth - groupHeight) / 2;
        let stackX = x(0);
        series.forEach((sr, si) => {
          const v = sr.values.get(c);
          if (v === null || v === undefined) return;
          const dim = (anySelected && !selected(c)) || (this.isolated !== null && this.isolated !== sr.key);
          const color = dim ? 'var(--series-other)' : sr.color;
          if (stacked) {
            const w = Math.max(0, x(v) - x(0) - (si > 0 ? GAP : 0));
            const isLast = si === series.length - 1;
            marks.appendChild(
              s('path', {
                class: 'hx-bar',
                d: barPath(
                  stackX + (si > 0 ? GAP : 0),
                  by + (yb.bandwidth - thickness) / 2,
                  w,
                  thickness,
                  'horizontal',
                  true,
                  isLast ? 4 : 0,
                ),
                style: `fill: ${color}`,
              }),
            );
            stackX += w + (si > 0 ? GAP : 0);
          } else {
            const x0p = x(Math.min(0, v));
            const w = Math.abs(x(v) - x(0));
            marks.appendChild(
              s('path', {
                class: 'hx-bar',
                d: barPath(x0p, offset, Math.max(1, w), t, 'horizontal', v >= 0),
                style: `fill: ${color}`,
              }),
            );
            if (showLabels)
              labelsG.appendChild(
                s(
                  'text',
                  {
                    class: 'hx-value-label',
                    x: v >= 0 ? x(v) + 6 : x(v) - 6,
                    y: offset + t / 2,
                    'dominant-baseline': 'middle',
                    'text-anchor': v >= 0 ? 'start' : 'end',
                  },
                  valueFmt(v),
                ),
              );
            offset += t + GAP;
          }
        });
        hits.appendChild(
          this.hit(
            c,
            f.x0 - catWidth + 4,
            by - 2,
            f.x1 - f.x0 + catWidth - 4,
            yb.bandwidth + 4,
            model,
            valueFmt,
          ),
        );
      }
    } else {
      const { ticks, step } = valueDomain(values, true, Math.max(3, Math.floor(this.height / 60)));
      f = frame(width, this.height, yLabelWidth(ticks, step, tickFmt));
      const y = linearScale([ticks[0]!, ticks[ticks.length - 1]!], [f.y0, f.y1]);
      const xb = bandScale(cats, [f.x0, f.x1], model.interval ? 0.2 : 0.3, 0.1);
      svg = this.newSvg(
        width,
        this.height,
        `${cats.length} columns${multi ? `, ${series.length} series` : ''}.`,
      );
      const axes = s('g', { class: 'hx-axes' });
      svg.appendChild(axes);
      drawYAxis(axes, f, y, ticks, step, tickFmt);
      drawBandAxis(axes, f, xb, model.labels);
      for (const c of cats) {
        const bx = xb(c)!;
        const groupWidth =
          multi && !stacked
            ? Math.min(xb.bandwidth, series.length * MAX_THICKNESS + (series.length - 1) * GAP)
            : Math.min(MAX_THICKNESS, xb.bandwidth);
        let offset = bx + (xb.bandwidth - groupWidth) / 2;
        const each =
          multi && !stacked ? (groupWidth - (series.length - 1) * GAP) / series.length : groupWidth;
        let stackY = y(0);
        series.forEach((sr, si) => {
          const v = sr.values.get(c);
          if (v === null || v === undefined) return;
          const dim = (anySelected && !selected(c)) || (this.isolated !== null && this.isolated !== sr.key);
          const color = dim ? 'var(--series-other)' : sr.color;
          if (stacked) {
            const hgt = Math.max(0, y(0) - y(v) - (si > 0 ? GAP : 0));
            const top = stackY - hgt - (si > 0 ? GAP : 0);
            const isLast = si === series.length - 1;
            marks.appendChild(
              s('path', {
                class: 'hx-bar',
                d: barPath(offset, top, groupWidth, hgt, 'vertical', true, isLast ? 4 : 0),
                style: `fill: ${color}`,
              }),
            );
            stackY = top;
          } else {
            const top = y(Math.max(0, v));
            const hgt = Math.max(1, Math.abs(y(v) - y(0)));
            marks.appendChild(
              s('path', {
                class: 'hx-bar',
                d: barPath(offset, top, each, hgt, 'vertical', v >= 0),
                style: `fill: ${color}`,
              }),
            );
            if (showLabels && textWidth(valueFmt(v), AXIS_FONT) < xb.step + 8)
              labelsG.appendChild(
                s(
                  'text',
                  {
                    class: 'hx-value-label',
                    x: offset + each / 2,
                    y: v >= 0 ? top - 6 : top + hgt + 13,
                    'text-anchor': 'middle',
                  },
                  valueFmt(v),
                ),
              );
            offset += each + GAP;
          }
        });
        hits.appendChild(
          this.hit(c, bx - (xb.step - xb.bandwidth) / 2, f.y1, xb.step, f.y0 - f.y1 + 22, model, valueFmt),
        );
      }
    }
    svg.append(marks, labelsG, hits);
    if (multi)
      this.legendSlot.appendChild(
        legend(
          series.map((sr) => ({ key: sr.key, label: sr.label, color: sr.color, kind: 'rect' as const })),
          this.isolated,
          (k) => this.toggleIsolation(k),
        )!,
      );
    const notes: string[] = [];
    if (model.total > cats.length)
      notes.push(
        model.interval
          ? `Latest ${cats.length} of ${model.total} periods`
          : `Top ${cats.length} of ${model.total} by value`,
      );
    if (series.some((sr) => sr.key === OTHER_SERIES)) notes.push('smaller series combined as Other');
    this.card.setNote(notes.join('; ') || null);
  }

  private hit(
    c: string,
    x: number,
    y: number,
    w: number,
    hgt: number,
    model: BarModel,
    valueFmt: (v: unknown) => string,
  ): SVGRectElement {
    const { def, app } = this;
    const label = model.labels.get(c) ?? c;
    const rect = s('rect', {
      class: 'hx-hit',
      x,
      y,
      width: Math.max(0, w),
      height: Math.max(0, hgt),
      tabindex: -1,
    });
    const tip = (cx: number, cy: number) => {
      const rows = model.series
        .map((sr) => ({ sr, v: sr.values.get(c) ?? null }))
        .filter((r) => r.v !== null)
        .map(({ sr, v }) => ({ label: sr.label, value: valueFmt(v), color: sr.color, key: 'rect' as const }));
      showTooltip(
        cx,
        cy,
        label,
        rows,
        model.interval
          ? 'Click to filter this period'
          : app.isSelected(def.data, def.x.field, c)
            ? 'Click to remove this filter'
            : 'Click to filter',
      );
    };
    rect.addEventListener('pointermove', (ev) => {
      rect.classList.add('hover');
      tip(ev.clientX, ev.clientY);
    });
    rect.addEventListener('pointerleave', () => {
      rect.classList.remove('hover');
      hideTooltip();
    });
    rect.addEventListener('click', () => {
      hideTooltip();
      if (model.interval) {
        const from = Number(c);
        app.setTimeRange(def.data, def.x.field, from, addInterval(from, model.interval), label);
      } else
        app.toggleValue(def.data, def.x.field, c, `${columnLabel(app, def.data, def.x.field)}: ${label}`);
    });
    return rect;
  }

  protected tableData(): TableData {
    const model = this.model ?? this.build(this.app.store.rows(this.def.data, this.selectionId));
    const { def, app } = this;
    const yType =
      def.y.agg === 'count' || def.y.agg === 'distinct' ? ('integer' as const) : ('number' as const);
    return {
      columns: [
        { key: '__x', label: def.x.label ?? columnLabel(app, def.data, def.x.field), type: 'string' },
        ...model.series.map((sr, i) => ({
          key: `s${i}`,
          label: sr.label,
          type: yType,
          format: def.y.format,
        })),
      ],
      rows: model.cats.map((c) => {
        const r: Row = { __x: model.labels.get(c) ?? c };
        model.series.forEach((sr, i) => (r[`s${i}`] = sr.values.get(c) ?? null));
        return r;
      }),
    };
  }
}

function truncateTo(label: string, px: number): string {
  if (textWidth(label, AXIS_FONT) <= px) return label;
  let out = label;
  while (out.length > 1 && textWidth(out + '\u2026', AXIS_FONT) > px) out = out.slice(0, -1);
  return out + '\u2026';
}
