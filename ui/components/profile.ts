import { binLog, binWithTail, prefersLog } from '../../src/dashboards/core/bins';
import { makeFormatter } from '../../src/dashboards/core/format';
import { isMissing, isNumericType, isTimeType, profileColumn } from '../../src/dashboards/core/infer';
import { autoInterval, floorTime, toTime } from '../../src/dashboards/core/time';
import type { ColumnInfo, Row } from '../../src/dashboards/core/types';
import { Card } from '../card';
import { clear, h, s } from '../dom';
import type { App, ComponentOf, Component } from '../types';

const TYPE_LABEL: Record<ColumnInfo['type'], string> = {
  number: 'number',
  integer: 'integer',
  boolean: 'yes/no',
  date: 'date',
  datetime: 'date and time',
  string: 'text',
  url: 'link',
  json: 'nested',
};

/** A share as a whole percent that never rounds a real share to 0% or 100%. */
function shareText(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.01) return '<1%';
  if (share >= 1) return '100%';
  if (share > 0.99) return '>99%';
  return `${Math.round(share * 100)}%`;
}

/** Mini histogram: 20 thin columns with 2px gaps, no axes (the numbers sit beside it). */
function miniBars(counts: number[]): SVGSVGElement {
  const w = 160;
  const hgt = 32;
  const max = Math.max(1, ...counts);
  const bw = w / Math.max(1, counts.length);
  const svg = s('svg', {
    class: 'hx-mini',
    width: w,
    height: hgt,
    viewBox: `0 0 ${w} ${hgt}`,
    'aria-hidden': 'true',
  });
  counts.forEach((c, i) => {
    const bh = c === 0 ? 0 : Math.max(1, (c / max) * (hgt - 2));
    if (bh)
      svg.appendChild(
        s('rect', { x: i * bw + 1, y: hgt - bh, width: Math.max(1, bw - 2), height: bh, rx: 1 }),
      );
  });
  return svg;
}

/** Column profiles: completeness, cardinality, range and shape, like a data-profiling report. */
export class ProfileGrid implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  private readonly card: Card;

  constructor(
    private readonly app: App,
    private readonly def: ComponentOf<'profile'>,
  ) {
    this.datasets = [def.data];
    this.card = new Card({
      title: def.title ?? 'Columns',
      subtitle: def.subtitle,
      className: 'hx-profile',
      locale: app.locale,
    });
    this.el = h('div', { class: `hx-item w-${def.width}` }, this.card.el);
    this.update();
  }

  update(): void {
    const { app, def } = this;
    const info = app.store.datasets.get(def.data)?.info;
    const rows = app.store.rows(def.data);
    const names = def.columns ?? info?.columns.map((c) => c.name) ?? [];
    // Scraper bookkeeping (_scraped_at, _change, _scraper) only shows when asked for by name.
    const hidden = def.columns ? [] : names.filter((n) => n.startsWith('_'));
    const cols = names
      .filter((n) => !hidden.includes(n))
      .map((n) => app.store.column(def.data, n))
      .filter((c): c is ColumnInfo => !!c);
    clear(this.card.body);
    this.card.setNote(
      `${rows.length.toLocaleString(app.locale)} rows in view` +
        (hidden.length ? `; scraper columns not shown: ${hidden.join(', ')}` : ''),
    );
    this.card.body.appendChild(
      h(
        'div',
        { class: 'hx-profile-grid' },
        cols.map((c) => this.column(c, rows)),
      ),
    );
  }

  private column(c: ColumnInfo, rows: Row[]): HTMLElement {
    const { app } = this;
    const p = profileColumn(c, rows, 5);
    const present = p.count - p.nulls;
    const filled = p.count ? present / p.count : 0;
    const fmt = makeFormatter(c.format, c.type, app.locale);
    const n = (v: number) => v.toLocaleString(app.locale);
    // [label, value, spans the card] rows of the stats grid.
    const stats: Array<[string, string, boolean?]> = [
      ['Filled', `${(filled * 100).toFixed(filled === 1 || filled === 0 ? 0 : 1)}%`],
      ['Distinct', n(p.distinct)],
    ];
    const shape: Node[] = [];
    const caption = (text: string) => h('p', { class: 'hx-mini-caption' }, text);
    const display = (v: string) => (c.type === 'boolean' ? fmt(v === 'true') : fmt(v));
    if (p.distinct === 1) {
      stats.push(['Value', display(p.top[0]!.value), true]);
      shape.push(
        caption(present === p.count ? 'Every row has this value' : 'Every filled row has this value'),
      );
    } else if (isNumericType(c.type) && p.min !== undefined) {
      stats.push(['Min', fmt(p.min)], ['Median', fmt(p.median)], ['Mean', fmt(p.mean)], ['Max', fmt(p.max)]);
      const values = rows
        .map((r) => r[c.name])
        .filter((v) => !isMissing(v))
        .map(Number)
        .filter(Number.isFinite);
      const log = prefersLog(values);
      const binned = log ? { bins: binLog(values), tail: null } : binWithTail(values, 20);
      const counts = binned.bins.map((b) => b.count);
      if (binned.tail) counts.push(binned.tail.count);
      shape.push(miniBars(counts));
      if (log) shape.push(caption('Log scale'));
      else if (binned.tail)
        shape.push(caption(`Last bar: ${n(binned.tail.count)} values above ${fmt(binned.tail.from)}`));
    } else if (isTimeType(c.type) && p.min !== undefined) {
      const day = makeFormatter('date', c.type, app.locale);
      stats.push(['First', day(p.min), true], ['Last', day(p.max), true]);
      const ts = rows.map((r) => toTime(r[c.name])).filter((t): t is number => t !== null);
      if (ts.length > 1) {
        const lo = Math.min(...ts);
        const hi = Math.max(...ts);
        const iv = autoInterval(lo, hi, 24);
        const counts = new Map<number, number>();
        for (const t of ts) counts.set(floorTime(t, iv), (counts.get(floorTime(t, iv)) ?? 0) + 1);
        const keys = [...counts.keys()].sort((a, b) => a - b);
        shape.push(miniBars(keys.map((k) => counts.get(k)!)), caption(`Rows per ${iv}`));
      }
    } else if (
      c.type !== 'boolean' &&
      p.examples.length &&
      (p.distinct >= present * 0.9 || (p.top[0]?.count ?? 0) / Math.max(1, present) < 0.02)
    ) {
      // No value is common enough for a top-values list to say anything.
      shape.push(
        caption(p.distinct >= present * 0.9 ? 'Mostly unique. Examples:' : 'No common values. Examples:'),
        h(
          'ul',
          { class: 'hx-examples' },
          p.examples.map((e) => h('li', { title: e }, display(e))),
        ),
      );
    } else if (p.top.length) {
      const total = present || 1;
      shape.push(
        h(
          'ul',
          { class: 'hx-top-values' },
          p.top.map((t) =>
            h(
              'li',
              { style: `--share: ${((t.count / total) * 100).toFixed(1)}%` },
              h('span', { class: 'hx-top-label', title: t.value }, display(t.value)),
              h('span', { class: 'hx-top-count' }, shareText(t.count / total)),
            ),
          ),
        ),
      );
    }
    return h(
      'article',
      { class: 'hx-col-card' },
      h(
        'header',
        null,
        h('h4', { title: c.description ?? c.name }, c.label ?? c.name),
        h('span', { class: 'hx-badge' }, TYPE_LABEL[c.type]),
      ),
      h('div', {
        class: 'hx-fill',
        role: 'img',
        'aria-label': `${(filled * 100).toFixed(0)}% of rows have a value`,
        style: `--fill: ${(filled * 100).toFixed(1)}%`,
      }),
      h(
        'dl',
        { class: 'hx-col-stats' },
        stats.map(([k, v, wide]) =>
          h('div', { class: wide ? 'wide' : undefined }, h('dt', null, k), h('dd', { title: v }, v)),
        ),
      ),
      ...shape,
    );
  }
}
