import { h } from '../dom';
import type { ClientComponent, Component } from '../types';

/**
 * A narrative block. The server rendered and sanitized the Markdown (every author tag escaped,
 * only http(s) links), so this is the one place that sets innerHTML.
 */
export class MarkdownBlock implements Component {
  readonly el: HTMLElement;
  readonly datasets: string[] = [];

  constructor(def: ClientComponent) {
    const body = h('div', { class: 'hx-prose' });
    body.innerHTML = def.html ?? '';
    this.el = h(
      'div',
      { class: `hx-item w-${def.width}` },
      h(
        'article',
        { class: 'hx-note' },
        def.title ? h('h3', { class: 'hx-card-title' }, def.title) : null,
        body,
      ),
    );
  }

  update(): void {
    // static content
  }
}
