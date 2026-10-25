import { encodeRows, safeJson } from './core/encode';
import type { EncodedDataset } from './core/types';
import { loadUiAssets } from './assets';
import type { LoadedDataset } from './data-loader';
import { escapeHtml, renderMarkdown } from './markdown';
import type { ResolvedSpec } from './validate';

export type RenderMode = 'standalone' | 'served' | 'embedded';

export interface RenderOptions {
  mode?: RenderMode;
  runId?: string;
  /** Relative link to the companion notebook (served mode shows it). */
  notebook?: string;
  builtAt?: Date;
  /** Refuse pages larger than this (bytes). */
  maxBytes?: number;
}

/** Strict by default: the page is static, needs no network and loads nothing from elsewhere. */
export const DASHBOARD_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export class DashboardTooLargeError extends Error {}

function encodeDataset(d: LoadedDataset): EncodedDataset {
  return {
    name: d.name,
    columns: d.columns,
    rows: encodeRows(d.columns, d.rows),
    description: d.description,
    source: d.source,
    truncated: d.truncated,
    totalRows: d.totalRows,
  };
}

/** The JSON payload the page boots from (markdown rendered and sanitized here, server-side). */
export function buildPayload(spec: ResolvedSpec, datasets: LoadedDataset[], opts: RenderOptions = {}) {
  const clientSpec = {
    ...spec,
    sections: spec.sections.map((sec) => ({
      ...sec,
      items: sec.items.map((item) =>
        item.type === 'markdown' ? { ...item, html: renderMarkdown(item.text) } : item,
      ),
    })),
  };
  return {
    spec: clientSpec,
    datasets: datasets.map(encodeDataset),
    meta: {
      builtAt: (opts.builtAt ?? new Date()).toISOString(),
      generator: 'analyst-harness',
      runId: opts.runId,
      mode: opts.mode ?? 'standalone',
      notebook: opts.notebook,
    },
  };
}

function inlineSafe(code: string, tag: 'script' | 'style'): string {
  return code.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`);
}

/** A complete, self-contained HTML document. */
export async function renderDashboardHtml(
  spec: ResolvedSpec,
  datasets: LoadedDataset[],
  opts: RenderOptions = {},
): Promise<string> {
  const assets = await loadUiAssets();
  const json = safeJson(buildPayload(spec, datasets, opts));
  const max = opts.maxBytes ?? 15 * 1024 * 1024;
  if (json.length + assets.js.length > max) {
    throw new DashboardTooLargeError(
      `the dashboard would be ${(json.length / 1024 / 1024).toFixed(1)} MB of data (limit ${(max / 1024 / 1024).toFixed(0)} MB); aggregate in SQL, select fewer columns or lower "limit"`,
    );
  }
  const lang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(spec.locale) ? spec.locale : 'en';
  return [
    '<!doctype html>',
    `<html lang="${lang}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    `<meta http-equiv="Content-Security-Policy" content="${DASHBOARD_CSP}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="generator" content="analyst-harness">',
    `<title>${escapeHtml(spec.title)}</title>`,
    `<style>${inlineSafe(assets.css, 'style')}</style>`,
    '</head>',
    '<body>',
    '<main id="hx-app"></main>',
    `<script type="application/json" id="hx-data">${json}</script>`,
    `<script>${inlineSafe(assets.js, 'script')}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

/**
 * The page body for hosts that wrap content in their own document (a sandboxed artifact
 * viewer): title and styles at the top, no doctype or head of its own, downloads hidden.
 */
export async function renderDashboardFragment(
  spec: ResolvedSpec,
  datasets: LoadedDataset[],
  opts: RenderOptions = {},
): Promise<string> {
  const assets = await loadUiAssets();
  const json = safeJson(buildPayload(spec, datasets, { ...opts, mode: 'embedded' }));
  return [
    `<title>${escapeHtml(spec.title)}</title>`,
    '<meta name="claude:viewport-fit-sides" content="cover">',
    `<style>${inlineSafe(assets.css, 'style')}</style>`,
    '<main id="hx-app"></main>',
    `<script type="application/json" id="hx-data">${json}</script>`,
    `<script>${inlineSafe(assets.js, 'script')}</script>`,
    '',
  ].join('\n');
}
