import { facetCounts } from '../../src/dashboards/core/filter';
import { Card } from '../card';
import { columnLabel, keyLabel } from '../chart';
import { clear, debounce, h, icon, uid } from '../dom';
import type { App, ComponentOf, Component } from '../types';

/**
 * Faceted navigation: value counts per field, computed with every other filter applied but
 * not this field's own selection, so the alternatives stay visible while you choose.
 */
export class Facets implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[];
  private readonly card: Card;
  private readonly expanded = new Set<string>();
  private readonly queries = new Map<string, string>();

  constructor(
    private readonly app: App,
    private readonly def: ComponentOf<'facets'>,
  ) {
    this.datasets = [def.data];
    this.card = new Card({
      title: def.title ?? 'Refine',
      subtitle: def.subtitle,
      className: 'hx-facets',
      locale: app.locale,
    });
    this.el = h('div', { class: `hx-item w-${def.width}` }, this.card.el);
    this.update();
  }

  update(): void {
    const body = this.card.body;
    const focused =
      document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined;
    clear(body);
    for (const field of this.def.fields) body.appendChild(this.group(field));
    if (focused) body.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
  }

  private group(field: string): HTMLElement {
    const { app, def } = this;
    const filter = app.selectionFor(def.data, field);
    const id = filter?.id ?? `values:${def.data}:${field}`;
    const selected = new Set(filter && filter.value.kind === 'values' ? filter.value.values : []);
    const counts = facetCounts(app.store.rows(def.data, id), field);
    const byValue = new Map(counts.map((c) => [c.value, c.count]));
    const query = (this.queries.get(field) ?? '').toLowerCase();
    const show = keyLabel(app, def.data, field);
    let items = counts.filter((c) => !selected.has(c.value));
    if (query) items = items.filter((c) => show(c.value).toLowerCase().includes(query));
    const pinned = [...selected].map((v) => ({ value: v, count: byValue.get(v) ?? 0 }));
    const open = this.expanded.has(field);
    const shown = open ? items.slice(0, 200) : items.slice(0, Math.max(0, def.limit - pinned.length));
    const max = Math.max(1, ...counts.map((c) => c.count));
    const label = columnLabel(app, def.data, field);
    const headingId = uid('facet');
    const list = h(
      'ul',
      { class: 'hx-facet-list', 'aria-labelledby': headingId },
      [...pinned, ...shown].map((c) =>
        h(
          'li',
          null,
          h(
            'button',
            {
              type: 'button',
              role: 'checkbox',
              'aria-checked': String(selected.has(c.value)),
              class: `hx-facet${selected.has(c.value) ? ' on' : ''}`,
              style: `--share: ${((c.count / max) * 100).toFixed(1)}%`,
              'data-focus-key': `${field}\u0000${c.value}`,
              onclick: () => app.toggleValue(def.data, field, c.value, `${label}: ${show(c.value)}`),
            },
            h(
              'span',
              { class: 'hx-checkbox', 'aria-hidden': 'true' },
              selected.has(c.value) ? icon('check') : null,
            ),
            h('span', { class: 'hx-facet-label', title: c.value }, show(c.value)),
            h('span', { class: 'hx-facet-count' }, c.count.toLocaleString(app.locale)),
          ),
        ),
      ),
    );
    const more = items.length + pinned.length > def.limit;
    const searchId = uid('facet-search');
    return h(
      'section',
      { class: 'hx-facet-group' },
      h(
        'header',
        { class: 'hx-facet-header' },
        h('h4', { id: headingId }, label),
        h(
          'span',
          { class: 'hx-facet-distinct' },
          `${counts.length.toLocaleString(app.locale)} ${counts.length === 1 ? 'value' : 'values'}`,
        ),
        selected.size
          ? h(
              'button',
              { type: 'button', class: 'hx-link-btn', onclick: () => app.clearValues(def.data, field) },
              'Clear',
            )
          : null,
      ),
      counts.length > def.limit
        ? h(
            'label',
            { class: 'hx-search hx-search-small', for: searchId },
            icon('search'),
            h('input', {
              id: searchId,
              type: 'search',
              placeholder: `Find a ${label.toLowerCase()}`,
              value: this.queries.get(field) ?? '',
              'data-focus-key': `search\u0000${field}`,
              oninput: debounce((ev: Event) => {
                this.queries.set(field, (ev.target as HTMLInputElement).value);
                this.update();
              }, 120),
            }),
          )
        : null,
      list,
      more
        ? h(
            'button',
            {
              type: 'button',
              class: 'hx-link-btn',
              onclick: () => {
                if (open) this.expanded.delete(field);
                else this.expanded.add(field);
                this.update();
              },
            },
            open ? 'Show fewer' : `Show all ${(items.length + pinned.length).toLocaleString(app.locale)}`,
          )
        : null,
    );
  }
}
