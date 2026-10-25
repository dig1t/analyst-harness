import { toCsv } from '../src/util/csv';
import { toast } from './overlay';

/** Start a download. Sandboxed viewers may block it silently, so menus also offer Copy. */
export function download(filename: string, content: string | Blob, mime = 'text/plain'): void {
  try {
    const blob =
      typeof content === 'string' ? new Blob([content], { type: `${mime};charset=utf-8` }) : content;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch {
    toast('Downloads are blocked here; use Copy instead');
  }
}

/** Copy text to the clipboard (must run inside a click handler), falling back to a selection. */
export async function copyText(text: string, what = 'Copied'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(what);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    toast(ok ? what : 'Copy is blocked here; select the table and copy it');
  }
}

export function rowsToCsv(rows: Record<string, unknown>[], columns: string[]): string {
  return toCsv(rows, columns);
}

export function fileSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'data'
  );
}

const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'opacity',
  'font-size',
  'font-weight',
  'font-family',
  'text-anchor',
  'dominant-baseline',
];

/** Serialize a chart with its computed colors inlined, so it renders the same outside the page. */
export function svgMarkup(svg: SVGSVGElement): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = svg.querySelectorAll('*');
  const dst = clone.querySelectorAll('*');
  src.forEach((node, i) => {
    const cs = getComputedStyle(node);
    const target = dst[i] as SVGElement;
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v) target.style.setProperty(p, v);
    }
  });
  const { width, height } = svg.getBoundingClientRect();
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(Math.round(width)));
  clone.setAttribute('height', String(Math.round(height)));
  const bg = getComputedStyle(svg.closest('.hx-card') ?? document.body).backgroundColor;
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('width', '100%');
  rect.setAttribute('height', '100%');
  rect.setAttribute('fill', bg);
  clone.insertBefore(rect, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

export function downloadPng(svg: SVGSVGElement, filename: string, scale = 2): void {
  const markup = svgMarkup(svg);
  const { width, height } = svg.getBoundingClientRect();
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    canvas.toBlob((blob) => blob && download(filename, blob, 'image/png'), 'image/png');
  };
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
}
