import { clear, h } from './dom';

/**
 * A single shared tooltip. Values lead and labels follow; rows key their series with a short
 * stroke of the series color. Content is built from text nodes only.
 */
export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
  /** `line` keys lines, `rect` keys bars and cells. */
  key?: 'line' | 'rect';
  muted?: boolean;
}

let tip: HTMLDivElement | undefined;

function tooltipEl(): HTMLDivElement {
  if (!tip) {
    tip = h('div', { class: 'hx-tooltip', role: 'tooltip', hidden: true });
    document.body.appendChild(tip);
  }
  return tip;
}

export function showTooltip(x: number, y: number, title: string, rows: TooltipRow[], footer?: string): void {
  const el = tooltipEl();
  clear(el);
  if (title) el.appendChild(h('div', { class: 'hx-tooltip-title' }, title));
  for (const r of rows) {
    el.appendChild(
      h(
        'div',
        { class: `hx-tooltip-row${r.muted ? ' muted' : ''}` },
        r.color
          ? h('span', {
              class: `hx-key hx-key-${r.key ?? 'line'}`,
              style: `--key: ${r.color}`,
              'aria-hidden': 'true',
            })
          : h('span', { class: 'hx-key hx-key-none', 'aria-hidden': 'true' }),
        h('strong', { class: 'hx-tooltip-value' }, r.value),
        h('span', { class: 'hx-tooltip-label' }, r.label),
      ),
    );
  }
  if (footer) el.appendChild(h('div', { class: 'hx-tooltip-footer' }, footer));
  el.hidden = false;
  const pad = 14;
  const rect = el.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  let left = x + pad;
  if (left + rect.width > vw - 8) left = Math.max(8, x - pad - rect.width);
  let top = y + pad;
  if (top + rect.height > vh - 8) top = Math.max(8, y - pad - rect.height);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

export function hideTooltip(): void {
  if (tip) tip.hidden = true;
}

let openPopover: { el: HTMLElement; anchor: HTMLElement; close: () => void } | undefined;

/** A popover anchored under a button; closes on outside click and Escape, returns focus. */
export function openPopoverAt(
  anchor: HTMLElement,
  content: HTMLElement,
  opts: { onClose?: () => void; width?: number } = {},
): () => void {
  closePopover();
  const el = h('div', { class: 'hx-popover', role: 'dialog' }, content);
  if (opts.width) el.style.width = `${opts.width}px`;
  document.body.appendChild(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pr = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let left = r.left;
    if (left + pr.width > vw - 8) left = Math.max(8, vw - 8 - pr.width);
    let top = r.bottom + 6;
    if (top + pr.height > document.documentElement.clientHeight - 8 && r.top - pr.height - 6 > 8)
      top = r.top - pr.height - 6;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  const onDoc = (ev: Event) => {
    const t = ev.target as Node;
    if (!el.contains(t) && !anchor.contains(t)) close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      close();
      anchor.focus();
    }
  };
  const close = () => {
    if (!el.isConnected) return;
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
    if (openPopover?.el === el) openPopover = undefined;
    opts.onClose?.();
  };
  document.addEventListener('pointerdown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
  openPopover = { el, anchor, close };
  const focusable = el.querySelector<HTMLElement>('input, button, [tabindex="0"]');
  focusable?.focus();
  return close;
}

export function closePopover(): void {
  openPopover?.close();
}

export interface MenuItem {
  label: string;
  icon?: string;
  onSelect: () => void;
  hidden?: boolean;
}

/** An action menu (role=menu) with arrow-key navigation. */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
  const list = h('div', { class: 'hx-menu', role: 'menu' });
  const buttons: HTMLButtonElement[] = [];
  for (const item of items.filter((i) => !i.hidden)) {
    const b = h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: 'hx-menu-item',
        onclick: () => {
          closePopover();
          item.onSelect();
        },
      },
      item.label,
    );
    buttons.push(b);
    list.appendChild(b);
  }
  list.addEventListener('keydown', (ev) => {
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      const next = (i + (ev.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }
  });
  openPopoverAt(anchor, list);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short status message ("Copied 120 rows"), announced to screen readers. */
export function toast(message: string): void {
  let el = document.querySelector<HTMLDivElement>('.hx-toast');
  if (!el) {
    el = h('div', { class: 'hx-toast', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (el) el.hidden = true;
  }, 2200);
}
