import { makeFormatter } from '../../src/dashboards/core/format';
import { isTimeType } from '../../src/dashboards/core/infer';
import { linearScale, logDomain, logScale, logTicks, niceTicks } from '../../src/dashboards/core/scales';
import { foldSeries, MAX_SCATTER_SERIES, rankSeries, seriesOf } from '../../src/dashboards/core/series';
import { toTime } from '../../src/dashboards/core/time';
import { OTHER_SERIES, type Row } from '../../src/dashboards/core/types';
import type { TableData } from '../card';
import {
  ChartComponent,
  columnLabel,
  drawLogAxis,
  drawNumberAxis,
  drawTimeAxis,
  drawYAxis,
  frame,
  keyLabel,
  legend,
  seriesPalette,
  tickFormatter,
  yLabelWidth,
} from '../chart';
import { s, uid } from '../dom';
import { hideTooltip, showTooltip } from '../overlay';
import type { ComponentOf } from '../types';

interface Point {
  x: number;
  y: number;
  series: string;
  row: Row;
}

/** Pearson correlation and least-squares line. */
export function fit(
  points: Array<{ x: number; y: number }>,
): { slope: number; intercept: number; r: number } | null {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0;
  let sy = 0;
  for (const p of points) {
    sx += p.x;
    sy += p.y;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
    sxy += (p.x - mx) * (p.y - my);
  }
  if (sxx === 0 || syy === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r: sxy / Math.sqrt(sxx * syy) };
}

export class ScatterChart extends ChartComponent<ComponentOf<'scatter'>> {
  private points: Point[] = [];

  protected draw(rows: Row[], width: number): void {
    const { def, app } = this;
    const store = app.store;
    const xCol = store.column(def.data, def.x.field);
    const xTime = !!xCol && isTimeType(xCol.type);
    const num = (v: unknown): number | null => {
      const n = typeof v === 'number' ? v : Number(v);
      return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n;
    };
    const sField = def.series?.field;
    let order: string[] = [];
    let kept = new Set<string>();
    if (sField) {
      const folded = foldSeries(
        rankSeries(store.allRows(def.data), sField, { agg: 'count' }),
        Math.min(def.series?.top ?? MAX_SCATTER_SERIES, MAX_SCATTER_SERIES) + 1,
      );
      order = folded.kept.slice(0, MAX_SCATTER_SERIES);
      kept = new Set(order);
    }
    const xLog = !xTime && def.x.scale === 'log';
    const yLog = def.y.scale === 'log';
    let pts: Point[] = [];
    let nonPositive = 0;
    for (const r of rows) {
      const x = xTime ? toTime(r[def.x.field]) : num(r[def.x.field]);
      const y = num(r[def.y.field]);
      if (x === null || y === null) continue;
      if ((xLog && x <= 0) || (yLog && y <= 0)) {
        nonPositive++;
        continue;
      }
      pts.push({ x, y, series: sField ? seriesOf(r, sField, kept) : '', row: r });
    }
    const total = pts.length;
    if (pts.length > def.limit) {
      const step = pts.length / def.limit;
      pts = Array.from({ length: def.limit }, (_, i) => pts[Math.floor(i * step)]!);
    }
    this.points = pts;
    if (pts.length === 0) {
      this.card.setNote(`No rows have both ${def.x.field} and ${def.y.field}`);
      return;
    }
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const yLo = Math.min(...ys);
    const yHi = Math.max(...ys);
    const baseYFmt = tickFormatter(app, def.y.format);
    // On a log axis each tick sets its own precision (0.01, 0.1, 1, 10).
    const yFmt = yLog ? (v: number) => baseYFmt(v, v) : baseYFmt;
    // Log ticks run from decade to decade, so the outer ticks bound the domain either way.
    const yTicks = yLog
      ? { ticks: logTicks(...logDomain(yLo, yHi)), step: 1 }
      : niceTicks(yLo, yHi, Math.max(3, Math.floor(this.height / 60)));
    const yDomain: [number, number] = [yTicks.ticks[0]!, yTicks.ticks[yTicks.ticks.length - 1]!];
    const f = frame(width, this.height, yLabelWidth(yTicks.ticks, yTicks.step, yFmt));
    const xLo = Math.min(...xs);
    const xHi = Math.max(...xs) === xLo ? xLo + 1 : Math.max(...xs);
    const xDomain: [number, number] = xTime
      ? [xLo, xHi]
      : xLog
        ? logDomain(xLo, xHi)
        : (() => {
            const t = niceTicks(xLo, xHi, Math.max(2, Math.floor(width / 90))).ticks;
            return [t[0]!, t[t.length - 1]!];
          })();
    const x = (xLog ? logScale : linearScale)(xDomain, [f.x0, f.x1]);
    const y = (yLog ? logScale : linearScale)(yDomain, [f.y0, f.y1]);
    const scaleText =
      xLog && yLog
        ? ' Both axes use a log scale.'
        : xLog
          ? ' The x axis uses a log scale.'
          : yLog
            ? ' The y axis uses a log scale.'
            : '';
    const svg = this.newSvg(width, this.height, `${pts.length} points.${scaleText}`);
    const axes = s('g', { class: 'hx-axes' });
    svg.appendChild(axes);
    drawYAxis(axes, f, y, yTicks.ticks, yTicks.step, yFmt);
    if (xTime) drawTimeAxis(axes, f, x, xDomain[0], xDomain[1], app.locale);
    else if (xLog) drawLogAxis(axes, f, x, tickFormatter(app, def.x.format));
    else drawNumberAxis(axes, f, x, tickFormatter(app, def.x.format));
    const colorOf = sField ? seriesPalette(app, def.data, sField, order) : () => 'var(--series-1)';
    const seriesLabel = sField ? keyLabel(app, def.data, sField) : (k: string) => k;
    const marks = s('g', { class: 'hx-marks' });
    svg.appendChild(marks);
    // "Other" sits behind the named series.
    const sorted = [...pts].sort(
      (a, b) => Number(b.series === OTHER_SERIES) - Number(a.series === OTHER_SERIES),
    );
    for (const p of sorted) {
      const dim = this.isolated !== null && this.isolated !== p.series;
      marks.appendChild(
        s('circle', {
          class: 'hx-point',
          cx: x(p.x),
          cy: y(p.y),
          r: 4,
          style: `fill: ${dim ? 'var(--series-other)' : colorOf(p.series)}${dim ? '; opacity: 0.35' : ''}`,
        }),
      );
    }
    const notes: string[] = [];
    if (total > pts.length)
      notes.push(
        `Showing ${pts.length.toLocaleString(app.locale)} of ${total.toLocaleString(app.locale)} points`,
      );
    if (xLog || yLog) notes.push(`log scale on ${xLog && yLog ? 'both axes' : xLog ? 'x' : 'y'}`);
    if (nonPositive) notes.push(`${nonPositive.toLocaleString(app.locale)} at or below zero not shown`);
    if (def.trend) {
      // Fit in the plotted space, so the line is straight on log axes too.
      const tx = (v: number) => (xLog ? Math.log10(v) : v);
      const ty = (v: number) => (yLog ? Math.log10(v) : v);
      const line = fit(pts.map((p) => ({ x: tx(p.x), y: ty(p.y) })));
      if (line) {
        const at = (v: number) => {
          const out = line.slope * tx(v) + line.intercept;
          return yLog ? 10 ** out : out;
        };
        const clipId = uid('clip');
        svg.appendChild(
          s(
            'clipPath',
            { id: clipId },
            s('rect', { x: f.x0, y: f.y1, width: f.x1 - f.x0, height: f.y0 - f.y1 }),
          ),
        );
        svg.appendChild(
          s('line', {
            class: 'hx-trend',
            'clip-path': `url(#${clipId})`,
            x1: x(xDomain[0]),
            y1: y(at(xDomain[0])),
            x2: x(xDomain[1]),
            y2: y(at(xDomain[1])),
          }),
        );
        notes.push(
          `trend line: least squares${xLog || yLog ? ' on the log values' : ''}, r = ${line.r.toFixed(2)}`,
        );
      }
    }
    this.card.setNote(notes.length ? notes.join('; ').replace(/^./, (c) => c.toUpperCase()) : null);
    if (sField) {
      const items = [...order, ...(pts.some((p) => p.series === OTHER_SERIES) ? [OTHER_SERIES] : [])].map(
        (k) => ({ key: k, label: seriesLabel(k), color: colorOf(k), kind: 'rect' as const }),
      );
      const lg = legend(items, this.isolated, (k) => this.toggleIsolation(k));
      if (lg) this.legendSlot.appendChild(lg);
    }
    const ring = s('circle', { class: 'hx-cross-dot', r: 6, visibility: 'hidden' });
    const overlay = s('rect', {
      class: 'hx-overlay',
      x: f.x0 - 8,
      y: f.y1 - 8,
      width: f.x1 - f.x0 + 16,
      height: f.y0 - f.y1 + 16,
    });
    svg.append(ring, overlay);
    const xFmt = makeFormatter(def.x.format, xCol?.type ?? 'number', app.locale);
    const yValFmt = makeFormatter(
      def.y.format,
      store.column(def.data, def.y.field)?.type ?? 'number',
      app.locale,
    );
    const xName = def.x.label ?? columnLabel(app, def.data, def.x.field);
    const yName = def.y.label ?? columnLabel(app, def.data, def.y.field);
    overlay.addEventListener('pointermove', (ev) => {
      const box = svg.getBoundingClientRect();
      const mx = ev.clientX - box.left;
      const my = ev.clientY - box.top;
      let best: Point | undefined;
      let bestD = 24 * 24;
      for (const p of pts) {
        const d = (x(p.x) - mx) ** 2 + (y(p.y) - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = p;
        }
      }
      if (!best) {
        ring.setAttribute('visibility', 'hidden');
        hideTooltip();
        return;
      }
      ring.setAttribute('cx', String(x(best.x)));
      ring.setAttribute('cy', String(y(best.y)));
      ring.setAttribute('style', `fill: ${colorOf(best.series)}`);
      ring.setAttribute('visibility', 'visible');
      const title = def.label ? String(best.row[def.label] ?? '') : seriesLabel(best.series);
      showTooltip(ev.clientX, ev.clientY, title, [
        { label: yName, value: yValFmt(best.y) },
        { label: xName, value: xFmt(xTime ? new Date(best.x).toISOString() : best.x) },
        ...(sField && def.label
          ? [
              {
                label: columnLabel(app, def.data, sField),
                value: seriesLabel(best.series),
                color: colorOf(best.series),
                key: 'rect' as const,
              },
            ]
          : []),
      ]);
    });
    overlay.addEventListener('pointerleave', () => {
      ring.setAttribute('visibility', 'hidden');
      hideTooltip();
    });
  }

  protected tableData(): TableData {
    const { def, app } = this;
    const store = app.store;
    const cols: TableData['columns'] = [];
    if (def.label)
      cols.push({
        key: def.label,
        label: columnLabel(app, def.data, def.label),
        type: store.column(def.data, def.label)?.type ?? 'string',
      });
    cols.push(
      {
        key: def.x.field,
        label: def.x.label ?? columnLabel(app, def.data, def.x.field),
        type: store.column(def.data, def.x.field)?.type ?? 'number',
        format: def.x.format,
      },
      {
        key: def.y.field,
        label: def.y.label ?? columnLabel(app, def.data, def.y.field),
        type: store.column(def.data, def.y.field)?.type ?? 'number',
        format: def.y.format,
      },
    );
    if (def.series)
      cols.push({
        key: def.series.field,
        label: columnLabel(app, def.data, def.series.field),
        type: 'string',
      });
    return { columns: cols, rows: this.points.map((p) => p.row) };
  }
}
