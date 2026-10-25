import { aggregate } from '../src/dashboards/core/aggregate';
import {
  formatBytes,
  formatDuration,
  formatTick,
  formatTimeTick,
  makeFormatter,
  type Formatter,
} from '../src/dashboards/core/format';
import { isNumericType } from '../src/dashboards/core/infer';
import { assignSeriesColors } from '../src/dashboards/core/series';
import {
  logTicks,
  niceTicks,
  timeTicks,
  type BandScale,
  type LinearScale,
} from '../src/dashboards/core/scales';
import type { AggSpec, ColumnType, Row } from '../src/dashboards/core/types';
import type { AggValue } from '../src/dashboards/spec';
import { Card, emptyState, errorState, type TableData } from './card';
import { clear, h, s, textWidth } from './dom';
import { download, copyText, downloadPng, fileSlug, rowsToCsv, svgMarkup } from './export';
import { hideTooltip, type MenuItem } from './overlay';
import type { App, ClientComponent, Component } from './types';

export const AXIS_FONT = 11;
export const MARGIN = { top: 10, right: 12, bottom: 26 };

export interface Frame {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** plot area */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export function frame(
  width: number,
  height: number,
  left: number,
  right = MARGIN.right,
  bottom = MARGIN.bottom,
): Frame {
  return {
    width,
    height,
    left,
    right,
    top: MARGIN.top,
    bottom,
    x0: left,
    x1: Math.max(left + 10, width - right),
    y0: Math.max(MARGIN.top + 10, height - bottom),
    y1: MARGIN.top,
  };
}

/** The formatter for an aggregate's values: explicit format, column format, or by type. */
export function aggFormatter(app: App, data: string, agg: AggValue | AggSpec, explicit?: string): Formatter {
  const a = agg as AggValue;
  const col = a.field ? app.store.column(data, a.field) : undefined;
  const type: ColumnType = a.agg === 'count' || a.agg === 'distinct' ? 'integer' : (col?.type ?? 'number');
  return makeFormatter(
    explicit ?? a.format ?? (a.agg === 'count' || a.agg === 'distinct' ? undefined : col?.format),
    type,
    app.locale,
  );
}

export function tickFormatter(app: App, format: string | undefined): (v: number, step: number) => string {
  if (format === 'bytes') return (v) => formatBytes(v);
  if (format === 'duration') return (v) => formatDuration(v);
  if (format && /^(percent|currency)/.test(format)) {
    const f = makeFormatter(
      format.replace(/:\d$/, '') + (format.startsWith('percent') ? ':0' : ''),
      'number',
      app.locale,
    );
    return (v) => f(v);
  }
  return (v, step) => formatTick(v, step, app.locale);
}

/** Display text for a category key: Yes and No for booleans, the key itself otherwise. */
export function keyLabel(app: App, data: string, field: string): (key: string) => string {
  const col = app.store.column(data, field);
  if (col?.type !== 'boolean') return (k) => k;
  return (k) => (k === 'true' ? 'Yes' : k === 'false' ? 'No' : k);
}

/** Series colors for a chart, consistent with every other chart of the same field. */
export function seriesPalette(
  app: App,
  data: string,
  field: string,
  kept: string[],
): (key: string) => string {
  const colors = assignSeriesColors(kept, app.store.seriesOrder(data, field));
  return (k) => colors.get(k) ?? 'var(--series-other)';
}

export function columnLabel(app: App, data: string, field: string): string {
  return app.store.column(data, field)?.label ?? field;
}

/** Y axis: hairline solid gridlines across the plot and right-aligned tick labels. */
export function drawYAxis(
  g: SVGGElement,
  f: Frame,
  y: LinearScale,
  ticks: number[],
  step: number,
  fmt: (v: number, step: number) => string,
): void {
  for (const t of ticks) {
    const py = Math.round(y(t)) + 0.5;
    g.appendChild(
      s('line', { class: t === 0 ? 'hx-baseline' : 'hx-gridline', x1: f.x0, x2: f.x1, y1: py, y2: py }),
    );
    g.appendChild(
      s(
        'text',
        { class: 'hx-tick', x: f.x0 - 8, y: py, 'text-anchor': 'end', 'dominant-baseline': 'middle' },
        fmt(t, step),
      ),
    );
  }
}

/** Left margin wide enough for the longest tick label. */
export function yLabelWidth(ticks: number[], step: number, fmt: (v: number, step: number) => string): number {
  return Math.ceil(Math.max(16, ...ticks.map((t) => textWidth(fmt(t, step), AXIS_FONT)))) + 14;
}

export function drawTimeAxis(
  g: SVGGElement,
  f: Frame,
  x: LinearScale,
  from: number,
  to: number,
  locale: string,
): void {
  const maxTicks = Math.max(2, Math.floor((f.x1 - f.x0) / 90));
  const { ticks, level } = timeTicks(from, to, maxTicks);
  ticks.forEach((t, i) => {
    const px = x(t);
    g.appendChild(s('line', { class: 'hx-tick-mark', x1: px, x2: px, y1: f.y0, y2: f.y0 + 4 }));
    g.appendChild(
      s(
        'text',
        {
          class: 'hx-tick',
          x: px,
          y: f.y0 + 16,
          'text-anchor': i === 0 && px - f.x0 < 30 ? 'start' : 'middle',
        },
        formatTimeTick(t, level, i === 0, locale),
      ),
    );
  });
}

export function drawNumberAxis(
  g: SVGGElement,
  f: Frame,
  x: LinearScale,
  fmt: (v: number, step: number) => string,
): void {
  const count = Math.max(2, Math.floor((f.x1 - f.x0) / 80));
  const { ticks, step } = niceTicks(x.domain[0], x.domain[1], count);
  for (const t of ticks) {
    if (t < x.domain[0] - 1e-9 || t > x.domain[1] + 1e-9) continue;
    const px = x(t);
    g.appendChild(s('line', { class: 'hx-tick-mark', x1: px, x2: px, y1: f.y0, y2: f.y0 + 4 }));
    g.appendChild(
      s('text', { class: 'hx-tick', x: px, y: f.y0 + 16, 'text-anchor': 'middle' }, fmt(t, step)),
    );
  }
}

/** X axis on a log scale: decade (or 1-2-5) ticks, labels skipped where they would collide. */
export function drawLogAxis(
  g: SVGGElement,
  f: Frame,
  x: LinearScale,
  fmt: (v: number, step: number) => string,
): void {
  let lastRight = -Infinity;
  for (const v of logTicks(x.domain[0], x.domain[1])) {
    const px = x(v);
    const text = fmt(v, v);
    const w = textWidth(text, AXIS_FONT);
    g.appendChild(s('line', { class: 'hx-tick-mark', x1: px, x2: px, y1: f.y0, y2: f.y0 + 4 }));
    if (px - w / 2 > lastRight + 6) {
      g.appendChild(s('text', { class: 'hx-tick', x: px, y: f.y0 + 16, 'text-anchor': 'middle' }, text));
      lastRight = px + w / 2;
    }
  }
}

/** Category labels under bands, thinned so they never collide. */
export function drawBandAxis(g: SVGGElement, f: Frame, x: BandScale, labels: Map<string, string>): void {
  const widest = Math.max(...[...labels.values()].map((l) => textWidth(l, AXIS_FONT)), 1);
  const every = Math.max(1, Math.ceil((widest + 10) / Math.max(1, x.step)));
  x.domain.forEach((d, i) => {
    if (i % every !== 0) return;
    const px = (x(d) ?? 0) + x.bandwidth / 2;
    g.appendChild(
      s('text', { class: 'hx-tick', x: px, y: f.y0 + 16, 'text-anchor': 'middle' }, labels.get(d) ?? d),
    );
  });
}

/** A bar with a 4px rounded data end and a square end at the baseline. */
export function barPath(
  x: number,
  y: number,
  w: number,
  hgt: number,
  orientation: 'vertical' | 'horizontal',
  positive = true,
  radius = 4,
): string {
  const r = Math.max(
    0,
    Math.min(radius, (orientation === 'vertical' ? w : hgt) / 2, orientation === 'vertical' ? hgt : w),
  );
  if (orientation === 'vertical') {
    if (positive)
      return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`;
    return `M${x},${y}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w - r}Q${x + w},${y + hgt} ${x + w},${y + hgt - r}V${y}Z`;
  }
  if (positive)
    return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt - r}Q${x + w},${y + hgt} ${x + w - r},${y + hgt}H${x}Z`;
  return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + hgt - r}Q${x},${y + hgt} ${x + r},${y + hgt}H${x + w}Z`;
}

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  kind: 'line' | 'rect';
}

/** Legend (for 2+ series): toggle an item to isolate it; toggle again to show all. */
export function legend(
  items: LegendItem[],
  isolated: string | null,
  onToggle: (key: string) => void,
): HTMLElement | null {
  if (items.length < 2) return null;
  return h(
    'div',
    { class: 'hx-legend', role: 'group', 'aria-label': 'Series' },
    items.map((it) =>
      h(
        'button',
        {
          type: 'button',
          class: `hx-legend-item${isolated && isolated !== it.key ? ' dim' : ''}`,
          'aria-pressed': String(isolated === it.key),
          title: isolated === it.key ? 'Show all series' : `Show only ${it.label}`,
          onclick: () => onToggle(it.key),
        },
        h('span', { class: `hx-key hx-key-${it.kind}`, style: `--key: ${it.color}`, 'aria-hidden': 'true' }),
        it.label,
      ),
    ),
  );
}

export function valueOf(rows: Row[], agg: AggSpec): number | null {
  return aggregate(rows, agg);
}

export function isFilledAgg(agg: AggSpec): boolean {
  return agg.agg === 'count' || agg.agg === 'sum' || agg.agg === 'distinct';
}

export function numericColumn(app: App, data: string, field: string): boolean {
  const c = app.store.column(data, field);
  return !!c && isNumericType(c.type);
}

/**
 * Shared chart scaffolding: card, legend slot, plot area that redraws on resize and filter
 * changes, empty and error states, the table-view twin and export actions.
 */
export abstract class ChartComponent<D extends ClientComponent = ClientComponent> implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  protected readonly card: Card;
  protected readonly plot: HTMLDivElement;
  protected readonly legendSlot: HTMLDivElement;
  protected svg?: SVGSVGElement;
  protected isolated: string | null = null;
  /** Line, area, scatter and histogram plots grow to the height a taller card gives the row. */
  protected readonly fills: boolean;
  private drawHeight?: number;
  private lastWidth = 0;
  private lastHeight = 0;
  private frameRequest = 0;

  constructor(
    protected readonly app: App,
    protected readonly def: D,
  ) {
    this.datasets = [def.data];
    this.card = new Card({
      title: def.title,
      subtitle: def.subtitle,
      className: `hx-chart hx-chart-${def.type}`,
      tableToggle: true,
      menu: () => this.menuItems(),
      locale: app.locale,
    });
    this.fills = ['line', 'area', 'scatter', 'histogram'].includes(def.type);
    this.legendSlot = h('div', { class: 'hx-legend-slot' });
    this.plot = h('div', { class: `hx-plot${this.fills ? ' hx-plot-fill' : ''}` });
    if (this.fills) this.plot.style.minHeight = `${this.baseHeight}px`;
    this.card.body.append(this.legendSlot, this.plot);
    this.card.setTableSource(() => this.tableData(this.app.store.rows(this.def.data)));
    this.el = h('div', { class: `hx-item w-${def.width}` }, this.card.el);
    const ro = new ResizeObserver(() => {
      const w = Math.floor(this.plot.clientWidth);
      const hgt = Math.floor(this.plot.clientHeight);
      if (w && (w !== this.lastWidth || (this.fills && hgt !== this.lastHeight))) this.schedule();
    });
    ro.observe(this.plot);
  }

  private get baseHeight(): number {
    return (this.def as { height?: number }).height ?? 280;
  }

  /** The plot height for this draw: the spec height, grown to fill the row (at most 2.5x). */
  protected get height(): number {
    return this.drawHeight ?? this.baseHeight;
  }

  private schedule(): void {
    cancelAnimationFrame(this.frameRequest);
    this.frameRequest = requestAnimationFrame(() => this.render());
  }

  update(): void {
    this.schedule();
  }

  render(): void {
    const width = Math.floor(this.plot.clientWidth);
    if (!width) return;
    this.lastWidth = width;
    this.lastHeight = Math.floor(this.plot.clientHeight);
    this.drawHeight = this.fills
      ? Math.min(Math.round(this.baseHeight * 2.5), Math.max(this.baseHeight, this.lastHeight))
      : this.baseHeight;
    hideTooltip();
    clear(this.plot);
    clear(this.legendSlot);
    const rows = this.app.store.rows(this.def.data);
    if (rows.length === 0) {
      this.plot.appendChild(
        emptyState(
          this.app.store.allRows(this.def.data).length
            ? 'No rows match the current filters.'
            : 'No data yet.',
          this.app.store.active().length
            ? { label: 'Clear filters', onClick: () => this.app.clearFilters() }
            : undefined,
        ),
      );
      this.card.refreshTable();
      return;
    }
    try {
      this.draw(rows, width);
    } catch (err) {
      this.plot.appendChild(errorState(`This chart could not be drawn: ${(err as Error).message}`));
    }
    this.card.refreshTable();
  }

  /** Create the chart SVG with an accessible name (the table view carries the values). */
  protected newSvg(width: number, height: number, summary: string): SVGSVGElement {
    const svg = s('svg', {
      class: 'hx-svg',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': `${this.def.title ?? 'Chart'}. ${summary} Use "Show as table" for the values.`,
      tabindex: 0,
    });
    this.svg = svg;
    this.plot.appendChild(svg);
    return svg;
  }

  protected toggleIsolation(key: string): void {
    this.isolated = this.isolated === key ? null : key;
    this.render();
  }

  protected abstract draw(rows: Row[], width: number): void;
  protected abstract tableData(rows: Row[]): TableData;

  protected menuItems(): MenuItem[] {
    const name = fileSlug(this.def.title ?? this.def.id);
    const data = () => this.tableData(this.app.store.rows(this.def.data));
    const csv = () => {
      const t = data();
      return rowsToCsv(
        t.rows,
        t.columns.map((c) => c.key),
      );
    };
    return [
      {
        label: 'Download CSV',
        onSelect: () => download(`${name}.csv`, csv(), 'text/csv'),
        hidden: !this.app.downloads,
      },
      { label: 'Copy data as CSV', onSelect: () => void copyText(csv(), 'Copied the chart data') },
      {
        label: 'Download SVG',
        onSelect: () => this.svg && download(`${name}.svg`, svgMarkup(this.svg), 'image/svg+xml'),
        hidden: !this.app.downloads || !this.svg,
      },
      {
        label: 'Download PNG',
        onSelect: () => this.svg && downloadPng(this.svg, `${name}.png`),
        hidden: !this.app.downloads || !this.svg,
      },
    ];
  }
}
