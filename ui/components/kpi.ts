import { aggLabel, aggregate } from '../../src/dashboards/core/aggregate';
import { compactNumber, makeFormatter } from '../../src/dashboards/core/format';
import { linearScale } from '../../src/dashboards/core/scales';
import { addInterval, floorTime, periodLength, toTime } from '../../src/dashboards/core/time';
import type { Interval, Row } from '../../src/dashboards/core/types';
import { Card } from '../card';
import { columnLabel } from '../chart';
import { clear, h, icon, s } from '../dom';
import type { App, ComponentOf, Component } from '../types';

const PERIOD_TEXT: Record<string, string> = {
  '7d': 'previous 7 days',
  '30d': 'previous 30 days',
  '90d': 'previous 90 days',
  week: 'previous week',
  month: 'previous month',
  quarter: 'previous quarter',
  year: 'previous year',
};

/** The window the value covers when a delta is set: it ends at the latest row in view. */
const CURRENT_TEXT: Record<string, string> = {
  '7d': 'latest 7 days',
  '30d': 'latest 30 days',
  '90d': 'latest 90 days',
  week: 'latest week',
  month: 'latest month',
  quarter: 'latest quarter',
  year: 'latest 12 months',
};

/**
 * Stat tile: label, value (auto-compact), optional delta against the previous period and a
 * 12-point sparkline in the de-emphasis gray with the current point in the accent.
 */
export class KpiTile implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  private readonly card: Card;

  constructor(
    private readonly app: App,
    private readonly def: ComponentOf<'kpi'>,
  ) {
    this.datasets = [def.data];
    this.card = new Card({ className: `hx-kpi${def.hero ? ' hx-hero' : ''}`, locale: app.locale });
    this.el = h(
      'div',
      { class: `hx-item hx-item-kpi${def.hero ? ' hx-item-hero' : ''} w-${def.width}` },
      this.card.el,
    );
    this.update();
  }

  private formatter(): (v: unknown) => string {
    const { def, app } = this;
    const explicit = def.format ?? def.value.format;
    if (explicit) return makeFormatter(explicit, 'number', app.locale);
    const col = def.value.field ? app.store.column(def.data, def.value.field) : undefined;
    const base = makeFormatter(
      col?.format,
      def.value.agg === 'count' || def.value.agg === 'distinct' ? 'integer' : (col?.type ?? 'number'),
      app.locale,
    );
    // A column format (bytes, currency) already reads compactly; plain numbers get K and M.
    if (col?.format) return base;
    return (v) => (typeof v === 'number' && Math.abs(v) >= 10_000 ? compactNumber(v, app.locale) : base(v));
  }

  update(): void {
    const { def, app } = this;
    const rows = app.store.rows(def.data);
    const fmt = this.formatter();
    let label =
      def.title ??
      aggLabel(def.value, def.value.field ? columnLabel(app, def.data, def.value.field) : undefined);
    let value = aggregate(rows, def.value);
    let deltaEl: HTMLElement | null = null;
    if (def.delta) {
      const field = def.delta.field;
      const times = rows.map((r) => toTime(r[field])).filter((t): t is number => t !== null);
      if (times.length) {
        const end = Math.max(...times) + 1;
        const len = periodLength(def.delta.period);
        const inWindow = (from: number, to: number) =>
          rows.filter((r) => {
            const t = toTime(r[field]);
            return t !== null && t >= from && t < to;
          });
        const cur = aggregate(inWindow(end - len, end), def.value);
        const prev = aggregate(inWindow(end - 2 * len, end - len), def.value);
        value = cur;
        label += `, ${CURRENT_TEXT[def.delta.period] ?? 'latest period'}`;
        deltaEl = this.delta(cur, prev, PERIOD_TEXT[def.delta.period] ?? 'previous period');
      }
    }
    const body = this.card.body;
    clear(body);
    const parts: Array<Node | null> = [
      h('p', { class: 'hx-kpi-label' }, label),
      h('p', { class: 'hx-kpi-value' }, value === null ? 'n/a' : fmt(value)),
      deltaEl,
      def.sparkline ? this.sparkline(rows, def.sparkline.field, def.sparkline.interval as Interval) : null,
      def.subtitle ? h('p', { class: 'hx-kpi-note' }, def.subtitle) : null,
    ];
    body.append(...parts.filter((p): p is Node => p !== null));
  }

  private delta(cur: number | null, prev: number | null, period: string): HTMLElement | null {
    if (cur === null || prev === null)
      return h('p', { class: 'hx-kpi-delta neutral' }, `No data for the ${period}`);
    if (prev === 0) return h('p', { class: 'hx-kpi-delta neutral' }, `New since the ${period}`);
    const change = (cur - prev) / Math.abs(prev);
    const dir = change > 0.0005 ? 'up' : change < -0.0005 ? 'down' : 'flat';
    const good = this.def.delta!.goodDirection;
    const tone =
      dir === 'flat' || good === 'neutral' ? 'neutral' : (dir === 'up') === (good === 'up') ? 'good' : 'bad';
    const pct = `${change > 0 ? '+' : ''}${(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%`;
    const words =
      dir === 'flat' ? 'Unchanged' : `${dir === 'up' ? 'Up' : 'Down'} ${pct.replace(/^[+-]/, '')}`;
    return h(
      'p',
      { class: `hx-kpi-delta ${tone}`, 'aria-label': `${words} versus the ${period}` },
      dir === 'flat' ? null : icon(dir === 'up' ? 'up' : 'down'),
      h('span', { class: 'hx-kpi-delta-value' }, dir === 'flat' ? '0%' : pct),
      h('span', { class: 'hx-kpi-delta-period' }, `vs ${period}`),
    );
  }

  private sparkline(rows: Row[], field: string, interval: Interval): SVGSVGElement | null {
    const times = rows.map((r) => toTime(r[field])).filter((t): t is number => t !== null);
    if (times.length === 0) return null;
    const last = floorTime(Math.max(...times), interval);
    const buckets = Array.from({ length: 12 }, (_, i) => addInterval(last, interval, i - 11));
    const groups = new Map<number, Row[]>(buckets.map((b) => [b, []]));
    for (const r of rows) {
      const t = toTime(r[field]);
      if (t === null) continue;
      const g = groups.get(floorTime(t, interval));
      if (g) g.push(r);
    }
    const fill =
      this.def.value.agg === 'count' || this.def.value.agg === 'sum' || this.def.value.agg === 'distinct';
    const vals = buckets.map((b) => {
      const g = groups.get(b)!;
      return g.length ? aggregate(g, this.def.value) : fill ? 0 : null;
    });
    const present = vals.filter((v): v is number => v !== null);
    if (present.length < 2) return null;
    const w = 120;
    const hgt = 28;
    const lo = Math.min(...present);
    const hi = Math.max(...present);
    const x = linearScale([0, 11], [3, w - 5]);
    const y = linearScale([lo, hi === lo ? lo + 1 : hi], [hgt - 4, 4]);
    const pts = vals.map((v, i) => (v === null ? null : `${x(i)},${y(v)}`)).filter(Boolean);
    const svg = s('svg', {
      class: 'hx-sparkline',
      width: w,
      height: hgt,
      viewBox: `0 0 ${w} ${hgt}`,
      'aria-hidden': 'true',
    });
    svg.appendChild(s('path', { class: 'hx-spark-line', d: 'M' + pts.join('L') }));
    const lastVal = vals[11];
    if (lastVal !== null && lastVal !== undefined)
      svg.appendChild(s('circle', { class: 'hx-spark-dot', cx: x(11), cy: y(lastVal), r: 3 }));
    return svg;
  }
}
