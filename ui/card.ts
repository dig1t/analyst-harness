import type { ColumnInfo, Row } from '../src/dashboards/core/types';
import { makeFormatter } from '../src/dashboards/core/format';
import { clear, h, iconButton, uid } from './dom';
import { openMenu, type MenuItem } from './overlay';

export interface TableData {
  columns: Array<{ key: string; label: string; type: ColumnInfo['type']; format?: string }>;
  rows: Row[];
}

export interface CardOptions {
  title?: string;
  subtitle?: string;
  className?: string;
  /** Show the table-view toggle (every chart has one: its accessible twin). */
  tableToggle?: boolean;
  menu?: () => MenuItem[];
  locale: string;
}

/** A dashboard card: title, subtitle, actions, a body, and an optional table view of the same data. */
export class Card {
  readonly el: HTMLElement;
  readonly body: HTMLDivElement;
  readonly table: HTMLDivElement;
  readonly note: HTMLParagraphElement;
  readonly titleId = uid('title');
  private showingTable = false;
  private tableToggle?: HTMLButtonElement;
  private tableSource?: () => TableData;

  constructor(private readonly opts: CardOptions) {
    const actions = h('div', { class: 'hx-card-actions' });
    if (opts.tableToggle) {
      this.tableToggle = iconButton('table', 'Show as table', () => this.setTableView(!this.showingTable), {
        'aria-pressed': 'false',
      });
      actions.appendChild(this.tableToggle);
    }
    if (opts.menu) {
      const btn = iconButton('more', 'More actions', () => openMenu(btn, opts.menu!()), {
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
      });
      actions.appendChild(btn);
    }
    this.note = h('p', { class: 'hx-card-note', hidden: true });
    const header =
      opts.title || opts.subtitle || actions.childNodes.length
        ? h(
            'header',
            { class: 'hx-card-header' },
            h(
              'div',
              { class: 'hx-card-heading' },
              opts.title ? h('h3', { class: 'hx-card-title', id: this.titleId }, opts.title) : null,
              opts.subtitle ? h('p', { class: 'hx-card-subtitle' }, opts.subtitle) : null,
              this.note,
            ),
            actions,
          )
        : null;
    this.body = h('div', { class: 'hx-card-body' });
    this.table = h('div', { class: 'hx-card-table', hidden: true });
    this.el = h(
      'article',
      { class: `hx-card ${opts.className ?? ''}`, 'aria-labelledby': opts.title ? this.titleId : undefined },
      header,
      this.body,
      this.table,
    );
  }

  setNote(text: string | null): void {
    this.note.textContent = text ?? '';
    this.note.hidden = !text;
  }

  /** Register where the table view gets its rows; refreshed whenever it is visible. */
  setTableSource(source: () => TableData): void {
    this.tableSource = source;
    if (this.showingTable) this.renderTable();
  }

  setTableView(on: boolean): void {
    this.showingTable = on;
    this.body.hidden = on;
    this.table.hidden = !on;
    this.tableToggle?.setAttribute('aria-pressed', String(on));
    this.tableToggle?.setAttribute('aria-label', on ? 'Show as chart' : 'Show as table');
    if (this.tableToggle) this.tableToggle.title = on ? 'Show as chart' : 'Show as table';
    if (on) this.renderTable();
  }

  refreshTable(): void {
    if (this.showingTable) this.renderTable();
  }

  private renderTable(): void {
    clear(this.table);
    if (!this.tableSource) return;
    const data = this.tableSource();
    const fmts = data.columns.map((c) => makeFormatter(c.format, c.type, this.opts.locale));
    const numeric = data.columns.map((c) => c.type === 'number' || c.type === 'integer');
    const rows = data.rows.slice(0, 500);
    this.table.appendChild(
      h(
        'div',
        { class: 'hx-table-scroll' },
        h(
          'table',
          { class: 'hx-table hx-table-compact' },
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              data.columns.map((c, i) =>
                h('th', { scope: 'col', class: numeric[i] ? 'num' : undefined }, c.label),
              ),
            ),
          ),
          h(
            'tbody',
            null,
            rows.map((r) =>
              h(
                'tr',
                null,
                data.columns.map((c, i) =>
                  h('td', { class: numeric[i] ? 'num' : undefined }, fmts[i]!(r[c.key])),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    if (data.rows.length > rows.length)
      this.table.appendChild(
        h('p', { class: 'hx-card-note' }, `Showing the first ${rows.length} of ${data.rows.length} rows`),
      );
  }
}

export function emptyState(message: string, action?: { label: string; onClick: () => void }): HTMLElement {
  return h(
    'div',
    { class: 'hx-empty' },
    h('p', null, message),
    action ? h('button', { type: 'button', class: 'hx-btn', onclick: action.onClick }, action.label) : null,
  );
}

export function errorState(message: string): HTMLElement {
  return h('div', { class: 'hx-empty hx-error', role: 'alert' }, h('p', null, message));
}
