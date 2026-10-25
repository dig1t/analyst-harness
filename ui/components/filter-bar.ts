import { facetCounts, isEmptyFilter } from '../../src/dashboards/core/filter';
import { makeFormatter } from '../../src/dashboards/core/format';
import { PRESET_LABELS } from '../../src/dashboards/core/time';
import type { ActiveFilter, TimePreset } from '../../src/dashboards/core/types';
import type { ResolvedFilter } from '../../src/dashboards/validate';
import { keyLabel } from '../chart';
import { clear, debounce, h, icon, uid } from '../dom';
import { closePopover, openPopoverAt } from '../overlay';
import type { App } from '../types';

const PRESET_ORDER: TimePreset[] = ['all', 'today', '7d', '30d', '90d', 'mtd', 'ytd', '12m'];

function fieldLabel(app: App, f: ResolvedFilter): string {
  if (f.label) return f.label;
  const field = f.type === 'search' ? f.fields[0]! : f.field;
  for (const d of f.datasets) {
    const c = app.store.column(d, field);
    if (c?.label) return c.label;
  }
  return f.type === 'search' ? 'Search' : field;
}

/** Yes and No for boolean select filters, the raw key otherwise. */
function optionLabel(app: App, f: ResolvedFilter): (key: string) => string {
  if (f.type === 'search') return (k) => k;
  const d = f.datasets.find((ds) => app.store.column(ds, f.field));
  return d ? keyLabel(app, d, f.field) : (k) => k;
}

function toDateInput(ms: number | undefined): string {
  return ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10);
}

/**
 * The one filter row above everything it scopes: date range first, then the dimension
 * filters, then chips for selections made on charts and facets.
 */
export class FilterBar {
  readonly el: HTMLElement;
  private readonly controls: HTMLDivElement;
  private readonly chips: HTMLDivElement;
  /** Each control's redraw, run when filters change. */
  private readonly renderers: Array<() => void> = [];

  constructor(private readonly app: App) {
    this.controls = h('div', { class: 'hx-filter-controls' });
    this.chips = h('div', { class: 'hx-chips', 'aria-live': 'polite' });
    this.el = h(
      'div',
      { class: 'hx-filterbar', role: 'region', 'aria-label': 'Filters' },
      this.controls,
      this.chips,
    );
    const ordered = [...app.filters].sort(
      (a, b) => Number(b.type === 'daterange') - Number(a.type === 'daterange'),
    );
    for (const f of ordered) this.controls.appendChild(this.control(f));
    this.update();
  }

  private filterOf(f: ResolvedFilter): ActiveFilter | undefined {
    return this.app.store.get(f.id);
  }

  private control(f: ResolvedFilter): HTMLElement {
    switch (f.type) {
      case 'daterange':
        return this.dateControl(f);
      case 'select':
        return this.selectControl(f);
      case 'range':
        return this.rangeControl(f);
      case 'search':
        return this.searchControl(f);
    }
  }

  private dateControl(f: ResolvedFilter & { type: 'daterange' }): HTMLElement {
    const btn = h('button', {
      type: 'button',
      class: 'hx-filter-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'data-filter': f.id,
    });
    const render = () => {
      clear(btn);
      const v = this.filterOf(f)?.value;
      let text = PRESET_LABELS.all;
      if (v?.kind === 'time') {
        if (v.from !== undefined || v.to !== undefined) {
          const fmt = makeFormatter('date', 'date', this.app.locale);
          text = `${v.from !== undefined ? fmt(v.from) : 'Start'} to ${v.to !== undefined ? fmt(v.to - 1) : 'now'}`;
        } else if (v.preset) text = PRESET_LABELS[v.preset];
      }
      btn.append(
        icon('calendar'),
        h('span', { class: 'hx-filter-name' }, fieldLabel(this.app, f)),
        h('span', { class: 'hx-filter-value' }, text),
        icon('chevron'),
      );
      btn.classList.toggle('active', !!v && !isEmptyFilter(v));
    };
    btn.addEventListener('click', () => {
      const v = this.filterOf(f)?.value;
      const current =
        v?.kind === 'time' && v.from === undefined && v.to === undefined
          ? (v.preset ?? 'all')
          : v?.kind === 'time'
            ? 'custom'
            : 'all';
      const fromId = uid('from');
      const toId = uid('to');
      const list = h(
        'div',
        { class: 'hx-presets' },
        PRESET_ORDER.map((p) =>
          h(
            'button',
            {
              type: 'button',
              class: `hx-preset${current === p ? ' on' : ''}`,
              'aria-pressed': String(current === p),
              onclick: () => {
                this.app.store.update(f.id, { kind: 'time', preset: p });
                closePopover();
              },
            },
            h(
              'span',
              { class: 'hx-preset-check', 'aria-hidden': 'true' },
              current === p ? icon('check') : null,
            ),
            PRESET_LABELS[p],
          ),
        ),
        h(
          'form',
          {
            class: 'hx-custom-range',
            onsubmit: (ev: Event) => {
              ev.preventDefault();
              const form = ev.currentTarget as HTMLFormElement;
              const from = (form.querySelector(`#${fromId}`) as HTMLInputElement).value;
              const to = (form.querySelector(`#${toId}`) as HTMLInputElement).value;
              const fromMs = from ? Date.parse(`${from}T00:00:00Z`) : undefined;
              const toMs = to ? Date.parse(`${to}T00:00:00Z`) + 86_400_000 : undefined;
              this.app.store.update(f.id, { kind: 'time', from: fromMs, to: toMs });
              closePopover();
            },
          },
          h('p', { class: 'hx-popover-title' }, 'Custom range'),
          h(
            'div',
            { class: 'hx-range-inputs' },
            h('label', { for: fromId }, 'From'),
            h('input', { id: fromId, type: 'date', value: v?.kind === 'time' ? toDateInput(v.from) : '' }),
            h('label', { for: toId }, 'To'),
            h('input', {
              id: toId,
              type: 'date',
              value: v?.kind === 'time' && v.to !== undefined ? toDateInput(v.to - 1) : '',
            }),
          ),
          h('button', { type: 'submit', class: 'hx-btn hx-btn-primary' }, 'Apply range'),
        ),
      );
      openPopoverAt(btn, list, { width: 260 });
    });
    this.renderers.push(render);
    return btn;
  }

  private selectControl(f: ResolvedFilter & { type: 'select' }): HTMLElement {
    const btn = h('button', {
      type: 'button',
      class: 'hx-filter-btn',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'data-filter': f.id,
    });
    const values = () => {
      const v = this.filterOf(f)?.value;
      return v?.kind === 'values' ? v.values : [];
    };
    const show = optionLabel(this.app, f);
    const render = () => {
      clear(btn);
      const sel = values();
      btn.append(
        icon('filter'),
        h('span', { class: 'hx-filter-name' }, fieldLabel(this.app, f)),
        h(
          'span',
          { class: 'hx-filter-value' },
          sel.length === 0 ? 'All' : sel.length === 1 ? show(sel[0]!) : `${sel.length} selected`,
        ),
        icon('chevron'),
      );
      btn.classList.toggle('active', sel.length > 0);
    };
    btn.addEventListener('click', () => {
      const searchId = uid('opt-search');
      const listEl = h('div', { class: 'hx-options', role: 'group', 'aria-label': fieldLabel(this.app, f) });
      const fill = (query: string) => {
        clear(listEl);
        const counts = new Map<string, number>();
        for (const d of f.datasets)
          for (const c of facetCounts(this.app.store.rows(d, f.id), f.field))
            counts.set(c.value, (counts.get(c.value) ?? 0) + c.count);
        const sel = new Set(values());
        const all = [...new Set([...sel, ...counts.keys()])]
          .filter((v) => !query || show(v).toLowerCase().includes(query.toLowerCase()))
          .sort(
            (a, b) =>
              Number(sel.has(b)) - Number(sel.has(a)) ||
              (counts.get(b) ?? 0) - (counts.get(a) ?? 0) ||
              a.localeCompare(b),
          )
          .slice(0, 300);
        for (const value of all) {
          const id = uid('opt');
          listEl.appendChild(
            h(
              'label',
              { class: 'hx-check-row', for: id },
              h('input', {
                id,
                type: 'checkbox',
                checked: sel.has(value),
                onchange: (ev: Event) => {
                  const next = new Set(values());
                  if ((ev.target as HTMLInputElement).checked) next.add(value);
                  else next.delete(value);
                  this.app.store.update(f.id, { kind: 'values', values: [...next] });
                },
              }),
              h('span', { class: 'hx-check-label', title: value }, show(value)),
              h(
                'span',
                { class: 'hx-facet-count' },
                (counts.get(value) ?? 0).toLocaleString(this.app.locale),
              ),
            ),
          );
        }
        if (all.length === 0) listEl.appendChild(h('p', { class: 'hx-card-note' }, 'No matching values'));
      };
      fill('');
      const panel = h(
        'div',
        { class: 'hx-select-panel' },
        h(
          'label',
          { class: 'hx-search', for: searchId },
          icon('search'),
          h('input', {
            id: searchId,
            type: 'search',
            placeholder: 'Find a value',
            oninput: debounce((ev: Event) => fill((ev.target as HTMLInputElement).value), 100),
          }),
        ),
        listEl,
        h(
          'div',
          { class: 'hx-popover-footer' },
          h(
            'button',
            {
              type: 'button',
              class: 'hx-link-btn',
              onclick: () => this.app.store.update(f.id, { kind: 'values', values: [] }),
            },
            'Clear',
          ),
        ),
      );
      openPopoverAt(btn, panel, { width: 280 });
    });
    this.renderers.push(render);
    return btn;
  }

  private rangeControl(f: ResolvedFilter & { type: 'range' }): HTMLElement {
    const minId = uid('min');
    const maxId = uid('max');
    const nums = f.datasets
      .flatMap((d) => this.app.store.allRows(d).map((r) => Number(r[f.field])))
      .filter(Number.isFinite);
    const lo = nums.length ? Math.min(...nums) : undefined;
    const hi = nums.length ? Math.max(...nums) : undefined;
    const fmt = makeFormatter('number', 'number', this.app.locale);
    const apply = debounce(() => {
      const min = (document.getElementById(minId) as HTMLInputElement | null)?.value;
      const max = (document.getElementById(maxId) as HTMLInputElement | null)?.value;
      this.app.store.update(f.id, {
        kind: 'range',
        min: min ? Number(min) : undefined,
        max: max ? Number(max) : undefined,
      });
    }, 250);
    const wrap = h(
      'div',
      { class: 'hx-range', role: 'group', 'aria-label': fieldLabel(this.app, f), 'data-filter': f.id },
      h('span', { class: 'hx-filter-name' }, fieldLabel(this.app, f)),
      h('label', { class: 'hx-visually-hidden', for: minId }, 'Minimum'),
      h('input', {
        id: minId,
        type: 'number',
        inputmode: 'decimal',
        placeholder: lo === undefined ? 'min' : fmt(lo),
        oninput: apply,
      }),
      h('span', { class: 'hx-range-sep' }, 'to'),
      h('label', { class: 'hx-visually-hidden', for: maxId }, 'Maximum'),
      h('input', {
        id: maxId,
        type: 'number',
        inputmode: 'decimal',
        placeholder: hi === undefined ? 'max' : fmt(hi),
        oninput: apply,
      }),
    );
    this.renderers.push(() => {
      const v = this.filterOf(f)?.value;
      wrap.classList.toggle('active', !!v && !isEmptyFilter(v));
      if (v?.kind === 'range' && document.activeElement?.closest('.hx-range') !== wrap) {
        (wrap.querySelector(`#${minId}`) as HTMLInputElement).value =
          v.min === undefined ? '' : String(v.min);
        (wrap.querySelector(`#${maxId}`) as HTMLInputElement).value =
          v.max === undefined ? '' : String(v.max);
      }
    });
    return wrap;
  }

  private searchControl(f: ResolvedFilter & { type: 'search' }): HTMLElement {
    const id = uid('q');
    const input = h('input', {
      id,
      type: 'search',
      class: 'hx-global-search',
      placeholder: f.placeholder ?? `Search ${f.fields.join(', ')}`,
      'aria-label': fieldLabel(this.app, f),
      oninput: debounce(
        (ev: Event) =>
          this.app.store.update(f.id, { kind: 'search', text: (ev.target as HTMLInputElement).value }),
        200,
      ),
    });
    const wrap = h(
      'label',
      { class: 'hx-search hx-filter-search', for: id, 'data-filter': f.id },
      icon('search'),
      input,
      h('kbd', { class: 'hx-kbd', 'aria-hidden': 'true' }, '/'),
    );
    this.renderers.push(() => {
      const v = this.filterOf(f)?.value;
      if (v?.kind === 'search' && document.activeElement !== input && input.value !== v.text)
        input.value = v.text;
    });
    return wrap;
  }

  update(): void {
    for (const r of this.renderers) r();
    clear(this.chips);
    const specIds = new Set(this.app.filters.map((f) => f.id));
    const extra = this.app.store.active().filter((f) => !specIds.has(f.id));
    for (const f of extra) {
      this.chips.appendChild(
        h(
          'span',
          { class: 'hx-chip' },
          h('span', null, f.label ?? f.fields.join(', ')),
          h(
            'button',
            {
              type: 'button',
              class: 'hx-chip-remove',
              'aria-label': `Remove filter ${f.label ?? ''}`,
              onclick: () => this.app.store.remove(f.id),
            },
            icon('close'),
          ),
        ),
      );
    }
    const anyActive = this.app.store.active().length > 0;
    if (anyActive)
      this.chips.appendChild(
        h(
          'button',
          { type: 'button', class: 'hx-link-btn', onclick: () => this.app.clearFilters() },
          'Clear all filters',
        ),
      );
    this.el.hidden = this.app.filters.length === 0 && !anyActive;
  }
}
