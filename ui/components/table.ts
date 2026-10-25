import { valueKey } from '../../src/dashboards/core/filter';
import { makeFormatter, type Formatter } from '../../src/dashboards/core/format';
import { isMissing, isNumericType, isTimeType } from '../../src/dashboards/core/infer';
import { toTime } from '../../src/dashboards/core/time';
import type { ColumnInfo, Row } from '../../src/dashboards/core/types';
import { Card, emptyState } from '../card';
import { clear, debounce, h, icon, iconButton, safeUrl, uid } from '../dom';
import { copyText, download, fileSlug, rowsToCsv } from '../export';
import { openPopoverAt } from '../overlay';
import type { App, ComponentOf, Component } from '../types';

interface Col {
  field: string;
  label: string;
  type: ColumnInfo['type'];
  fmt: Formatter;
  numeric: boolean;
  link?: string;
  bar: boolean;
  width: 'narrow' | 'normal' | 'wide';
  visible: boolean;
}

function compare(a: unknown, b: unknown, type: ColumnInfo['type']): number {
  const ma = isMissing(a);
  const mb = isMissing(b);
  if (ma || mb) return ma === mb ? 0 : ma ? 1 : -1;
  if (isNumericType(type)) return Number(a) - Number(b);
  if (isTimeType(type)) return (toTime(a) ?? 0) - (toTime(b) ?? 0);
  if (type === 'boolean') return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Resolve a column's link: a URL field, or a template like `https://x.test/item?id={id}`. */
function linkFor(row: Row, col: Col): string | null {
  if (col.link) {
    if (!col.link.includes('{')) return safeUrl(row[col.link]);
    const url = col.link.replace(/\{([^}]+)\}/g, (_m, f: string) => encodeURIComponent(String(row[f] ?? '')));
    return safeUrl(url);
  }
  return col.type === 'url' ? safeUrl(row[col.field]) : null;
}

export class DataTable implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  private readonly card: Card;
  private readonly cols: Col[];
  private sort: { field: string; dir: 1 | -1 } | null;
  private page = 0;
  private pageSize: number;
  private query = '';
  private readonly content: HTMLDivElement;
  private readonly countEl: HTMLSpanElement;

  constructor(
    private readonly app: App,
    private readonly def: ComponentOf<'table'>,
  ) {
    this.datasets = [def.data];
    const store = app.store;
    const dataset = store.datasets.get(def.data);
    const specCols = def.columns ?? (dataset?.info.columns ?? []).map((c) => c.name);
    this.cols = specCols.map((c) => {
      const conf = typeof c === 'string' ? { field: c } : c;
      const info = store.column(def.data, conf.field);
      const type = info?.type ?? 'string';
      return {
        field: conf.field,
        label: ('label' in conf && conf.label) || info?.label || conf.field,
        type,
        fmt: makeFormatter(('format' in conf && conf.format) || info?.format, type, app.locale),
        numeric: isNumericType(type),
        link: 'link' in conf ? conf.link : undefined,
        bar: ('bar' in conf && conf.bar) || false,
        width: ('width' in conf && conf.width) || (type === 'string' ? 'wide' : 'normal'),
        visible: !(conf.field.startsWith('_') && !def.columns),
      };
    });
    this.sort = def.sort ? { field: def.sort.field, dir: def.sort.direction === 'asc' ? 1 : -1 } : null;
    this.pageSize = def.pageSize;
    this.countEl = h('span', { class: 'hx-table-count', 'aria-live': 'polite' });
    const searchId = uid('search');
    const toolbar = h(
      'div',
      { class: 'hx-table-toolbar' },
      def.search
        ? h(
            'label',
            { class: 'hx-search', for: searchId },
            icon('search'),
            h('input', {
              id: searchId,
              type: 'search',
              placeholder: 'Find in table',
              'aria-label': `Find in ${def.title ?? 'table'}`,
              oninput: debounce((ev: Event) => {
                this.query = (ev.target as HTMLInputElement).value;
                this.page = 0;
                this.renderBody();
              }, 150),
            }),
          )
        : null,
      this.countEl,
      h('span', { class: 'hx-spacer' }),
      iconButton('columns', 'Choose columns', (ev) => this.chooseColumns(ev.currentTarget as HTMLElement), {
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      }),
    );
    this.card = new Card({
      title: def.title,
      subtitle: def.subtitle,
      className: 'hx-table-card',
      menu: () => this.menu(),
      locale: app.locale,
    });
    this.content = h('div', { class: 'hx-table-content' });
    this.card.body.append(toolbar, this.content);
    this.el = h('div', { class: `hx-item w-${def.width}` }, this.card.el);
    this.update();
  }

  private visibleCols(): Col[] {
    return this.cols.filter((c) => c.visible);
  }

  private rows(): Row[] {
    let rows = this.app.store.rows(this.def.data);
    if (this.query.trim()) {
      const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
      const cols = this.visibleCols();
      rows = rows.filter((r) => {
        const hay = cols.map((c) => `${c.fmt(r[c.field])} ${valueKey(r[c.field])}`.toLowerCase()).join(' ');
        return terms.every((t) => hay.includes(t));
      });
    }
    if (this.sort) {
      const col = this.cols.find((c) => c.field === this.sort!.field);
      const dir = this.sort.dir;
      if (col)
        rows = [...rows].sort((a, b) => {
          const c = compare(a[col.field], b[col.field], col.type);
          // Missing values stay last in both directions.
          return isMissing(a[col.field]) || isMissing(b[col.field]) ? c : c * dir;
        });
    }
    return rows;
  }

  update(): void {
    this.page = 0;
    this.renderBody();
  }

  private renderBody(): void {
    clear(this.content);
    const rows = this.rows();
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / this.pageSize));
    this.page = Math.min(this.page, pages - 1);
    const start = this.page * this.pageSize;
    const slice = rows.slice(start, start + this.pageSize);
    const fmtN = (n: number) => n.toLocaleString(this.app.locale);
    this.countEl.textContent = total === 0 ? 'No rows' : `${fmtN(total)} row${total === 1 ? '' : 's'}`;
    if (total === 0) {
      this.content.appendChild(
        emptyState(
          this.query
            ? `Nothing in this table matches "${this.query}".`
            : 'No rows match the current filters.',
          this.app.store.active().length
            ? { label: 'Clear filters', onClick: () => this.app.clearFilters() }
            : undefined,
        ),
      );
      return;
    }
    const cols = this.visibleCols();
    const maxes = new Map(
      cols
        .filter((c) => c.bar)
        .map((c) => [c.field, Math.max(...rows.map((r) => Math.abs(Number(r[c.field]) || 0)), 1)]),
    );
    const head = h(
      'tr',
      null,
      cols.map((c) => {
        const sorted = this.sort?.field === c.field;
        const ariaSort = sorted ? (this.sort!.dir === 1 ? 'ascending' : 'descending') : 'none';
        return h(
          'th',
          { scope: 'col', class: `${c.numeric ? 'num' : ''} w-${c.width}`, 'aria-sort': ariaSort },
          h(
            'button',
            {
              type: 'button',
              class: 'hx-sort',
              onclick: () => this.toggleSort(c.field),
              title: `Sort by ${c.label}`,
            },
            h('span', null, c.label),
            h(
              'span',
              { class: `hx-sort-mark${sorted ? ' on' : ''}`, 'aria-hidden': 'true' },
              sorted ? (this.sort!.dir === 1 ? '\u2191' : '\u2193') : '\u2195',
            ),
          ),
        );
      }),
    );
    const body = slice.map((r) =>
      h(
        'tr',
        {
          tabindex: this.def.details ? 0 : undefined,
          class: this.def.details ? 'clickable' : undefined,
          onclick: this.def.details
            ? (ev: Event) => {
                if ((ev.target as HTMLElement).closest('a')) return;
                this.details(r, ev.currentTarget as HTMLElement);
              }
            : undefined,
          onkeydown: this.def.details
            ? (ev: Event) => {
                const k = (ev as KeyboardEvent).key;
                if (k === 'Enter' || k === ' ') {
                  ev.preventDefault();
                  this.details(r, ev.currentTarget as HTMLElement);
                }
              }
            : undefined,
        },
        cols.map((c) => this.cell(r, c, maxes.get(c.field))),
      ),
    );
    this.content.appendChild(
      h(
        'div',
        { class: 'hx-table-scroll' },
        h('table', { class: 'hx-table' }, h('thead', null, head), h('tbody', null, body)),
      ),
    );
    if (total > this.pageSize || this.pageSize !== this.def.pageSize) {
      const sizeId = uid('pagesize');
      this.content.appendChild(
        h(
          'div',
          { class: 'hx-pager' },
          h(
            'span',
            null,
            `${fmtN(start + 1)} to ${fmtN(Math.min(total, start + this.pageSize))} of ${fmtN(total)}`,
          ),
          h('span', { class: 'hx-spacer' }),
          h('label', { for: sizeId, class: 'hx-pager-size' }, 'Rows per page'),
          h(
            'select',
            {
              id: sizeId,
              onchange: (ev: Event) => {
                this.pageSize = Number((ev.target as HTMLSelectElement).value);
                this.page = 0;
                this.renderBody();
              },
            },
            [10, 25, 50, 100].map((n) => h('option', { value: n, selected: n === this.pageSize }, String(n))),
          ),
          h(
            'button',
            { type: 'button', class: 'hx-btn', disabled: this.page === 0, onclick: () => this.go(-1) },
            'Previous',
          ),
          h(
            'button',
            { type: 'button', class: 'hx-btn', disabled: this.page >= pages - 1, onclick: () => this.go(1) },
            'Next',
          ),
        ),
      );
    }
  }

  private cell(r: Row, c: Col, max?: number): HTMLTableCellElement {
    const v = r[c.field];
    if (isMissing(v)) return h('td', { class: `${c.numeric ? 'num' : ''} hx-null` }, 'null');
    const text = c.fmt(v);
    const href = linkFor(r, c);
    const content = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text) : text;
    const attrs: Record<string, string> = { class: `${c.numeric ? 'num' : ''} w-${c.width}` };
    if (text.length > 60) attrs.title = text;
    if (c.bar && max) {
      // The bar sits beside the number, so it never covers the digits it stands for.
      const share = Math.max(0, Math.min(1, Math.abs(Number(v)) / max));
      return h(
        'td',
        { ...attrs, class: `${attrs.class} hx-bar-cell` },
        h(
          'span',
          { class: 'hx-bar-wrap' },
          h(
            'span',
            { class: 'hx-bar-track', 'aria-hidden': 'true' },
            h('span', { class: 'hx-bar-fill', style: `width: ${(share * 100).toFixed(1)}%` }),
          ),
          h('span', { class: 'hx-bar-value' }, content),
        ),
      );
    }
    return h('td', attrs, content);
  }

  private go(delta: number): void {
    this.page += delta;
    this.renderBody();
    this.content.querySelector('table')?.scrollIntoView({ block: 'nearest' });
  }

  /** A new column starts largest or newest first (text A to Z); clicking it again flips. */
  private toggleSort(field: string): void {
    if (this.sort?.field === field) this.sort = { field, dir: this.sort.dir === 1 ? -1 : 1 };
    else {
      const type = this.cols.find((c) => c.field === field)?.type ?? 'string';
      this.sort = { field, dir: isNumericType(type) || isTimeType(type) ? -1 : 1 };
    }
    this.renderBody();
  }

  private chooseColumns(anchor: HTMLElement): void {
    const list = h(
      'div',
      { class: 'hx-choose' },
      h('p', { class: 'hx-popover-title' }, 'Columns'),
      this.cols.map((c) => {
        const id = uid('col');
        return h(
          'label',
          { class: 'hx-check-row', for: id },
          h('input', {
            id,
            type: 'checkbox',
            checked: c.visible,
            onchange: (ev: Event) => {
              c.visible = (ev.target as HTMLInputElement).checked;
              if (!this.cols.some((x) => x.visible)) c.visible = true;
              this.renderBody();
            },
          }),
          h('span', null, c.label),
        );
      }),
    );
    openPopoverAt(anchor, list, { width: 260 });
  }

  private exportRows(): Row[] {
    return this.rows();
  }

  private menu() {
    const name = fileSlug(this.def.title ?? this.def.data);
    const cols = this.visibleCols();
    const csv = () =>
      rowsToCsv(
        this.exportRows(),
        cols.map((c) => c.field),
      );
    return [
      {
        label: 'Download CSV',
        onSelect: () => download(`${name}.csv`, csv(), 'text/csv'),
        hidden: !this.app.downloads,
      },
      {
        label: 'Download JSON',
        onSelect: () =>
          download(
            `${name}.json`,
            JSON.stringify(
              this.exportRows().map((r) => Object.fromEntries(cols.map((c) => [c.field, r[c.field]]))),
              null,
              2,
            ),
            'application/json',
          ),
        hidden: !this.app.downloads,
      },
      {
        label: 'Copy as CSV',
        onSelect: () => void copyText(csv(), `Copied ${this.exportRows().length} rows`),
      },
    ];
  }

  private details(row: Row, from: HTMLElement): void {
    const all = this.app.store.datasets.get(this.def.data)?.info.columns ?? [];
    const titleCol = this.cols.find((c) => c.type === 'string' && !isMissing(row[c.field]));
    const close = () => {
      panel.remove();
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      from.focus();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') close();
    };
    const titleId = uid('drawer');
    const closeBtn = iconButton('close', 'Close details', close);
    const panel = h(
      'div',
      { class: 'hx-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h(
        'header',
        { class: 'hx-drawer-header' },
        h('h3', { id: titleId }, titleCol ? titleCol.fmt(row[titleCol.field]) : 'Row details'),
        closeBtn,
      ),
      h(
        'dl',
        { class: 'hx-fields' },
        all.map((c) => {
          const col = this.cols.find((x) => x.field === c.name);
          const v = row[c.name];
          const fmt = col?.fmt ?? makeFormatter(c.format, c.type, this.app.locale);
          let value: Node | string;
          if (isMissing(v)) value = h('span', { class: 'hx-null' }, 'null');
          else if (c.type === 'json') value = h('pre', null, JSON.stringify(v, null, 2));
          else {
            const href = col ? linkFor(row, col) : c.type === 'url' ? safeUrl(v) : null;
            value = href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, fmt(v)) : fmt(v);
          }
          return [h('dt', null, c.label ?? c.name), h('dd', null, value)];
        }),
      ),
      h(
        'footer',
        { class: 'hx-drawer-footer' },
        h(
          'button',
          {
            type: 'button',
            class: 'hx-btn',
            onclick: () => void copyText(JSON.stringify(row, null, 2), 'Copied the row as JSON'),
          },
          'Copy as JSON',
        ),
      ),
    );
    const backdrop = h('div', { class: 'hx-backdrop', onclick: close });
    document.body.append(backdrop, panel);
    document.addEventListener('keydown', onKey, true);
    closeBtn.focus();
  }
}
