/** Tiny DOM helpers. Text always goes in through text nodes, never through innerHTML. */
type Child = Node | string | number | null | undefined | false | Child[];
type Handler = (ev: Event) => void;
export type Attrs = Record<string, string | number | boolean | null | undefined | Handler>;

function append(el: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) for (const c of child) append(el, c);
  else
    el.appendChild(
      typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child,
    );
}

function setAttrs(el: Element, attrs: Attrs | undefined): void {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as Handler);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  setAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function s<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  setAttrs(el, attrs ?? undefined);
  append(el, children);
  return el;
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

let idCounter = 0;
export function uid(prefix = 'hx'): string {
  return `${prefix}-${++idCounter}`;
}

const ICONS: Record<string, string> = {
  table: 'M3 4.5h14M3 9.5h14M3 14.5h14M7.5 4.5v10',
  more: 'M5 10h.01M10 10h.01M15 10h.01',
  download: 'M10 3.5v9m0 0-3.5-3.5M10 12.5l3.5-3.5M4 16.5h12',
  copy: 'M7 7V4.5h8.5V13H13M4.5 7H13v8.5H4.5z',
  close: 'M5 5l10 10M15 5L5 15',
  check: 'M4 10.5l4 4 8-9',
  chevron: 'M6 8l4 4 4-4',
  search: 'M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12zm4.5-1.5L17 17',
  columns: 'M3.5 4h13v12h-13zM8 4v12M12 4v12',
  sun: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  moon: 'M16 12.5A6.5 6.5 0 0 1 7.5 4a6.5 6.5 0 1 0 8.5 8.5z',
  auto: 'M10 3a7 7 0 1 1 0 14a7 7 0 0 1 0-14zM10 3v14M10 6.5h3.5M10 10h4.5M10 13.5h3.5',
  link: 'M8.5 11.5l3-3M7 9.5L5.5 11a2.5 2.5 0 0 0 3.5 3.5l1.5-1.5M13 10.5L14.5 9A2.5 2.5 0 0 0 11 5.5L9.5 7',
  up: 'M10 15V5m0 0l-4 4m4-4l4 4',
  down: 'M10 5v10m0 0l-4-4m4 4l4-4',
  filter: 'M3.5 5h13l-5 6v4.5l-3 1V11z',
  calendar: 'M4 5.5h12V16H4zM4 8.5h12M7.5 3.5v3M12.5 3.5v3',
};

/** A 20px stroke icon; decorative unless given a label. */
export function icon(name: keyof typeof ICONS | string, label?: string): SVGSVGElement {
  const svg = s('svg', {
    viewBox: '0 0 20 20',
    width: 16,
    height: 16,
    class: 'hx-icon',
    'aria-hidden': label ? undefined : 'true',
    role: label ? 'img' : undefined,
    'aria-label': label,
  });
  svg.appendChild(s('path', { d: ICONS[name] ?? '', fill: 'none', stroke: 'currentColor' }));
  return svg;
}

export function iconButton(
  name: string,
  label: string,
  onClick: Handler,
  extra: Attrs = {},
): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', class: 'hx-icon-btn', 'aria-label': label, title: label, onclick: onClick, ...extra },
    icon(name),
  );
}

/** Debounce for input handlers. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Text width in px for the chart label font (falls back to an estimate without canvas). */
export function textWidth(str: string, size = 11, weight = 400): number {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement('canvas').getContext('2d');
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return str.length * size * 0.58;
  measureCtx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  return measureCtx.measureText(str).width;
}

/** Only http(s) URLs become links; anything else renders as text. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

export function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // storage can be unavailable (private windows, sandboxes); the page works without it
  }
}
