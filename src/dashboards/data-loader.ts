import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { Workspace } from '../safety/workspace';
import type { SqlService } from '../tools/types';
import { parseCsv } from '../util/csv';
import { ToolError } from '../util/errors';
import { inferColumns, normalizeRows } from './core/infer';
import type { ColumnInfo, Row } from './core/types';
import type { DataSourceSpec } from './spec';

export interface LoadContext {
  /** Mounts resolve file paths (`datasets/...`, `reports/x.csv`) and sandbox DuckDB. */
  workspace: Workspace;
  datasetsDir: string;
  sql?: SqlService;
  /** DuckDB connections are per run; dashboard builds use their own id. */
  runId: string;
}

export interface LoadedDataset {
  name: string;
  columns: ColumnInfo[];
  rows: Row[];
  totalRows: number;
  truncated: boolean;
  source: { kind: 'sql' | 'dataset' | 'file' | 'values'; text: string };
  description?: string;
  /** Scraped datasets this source reads, so a new scrape can refresh the dashboard. */
  dependsOn: string[];
}

const DATASET_RE = /^[a-z0-9][a-z0-9-_]{0,63}$/;
/** Bookkeeping fields scrapers add that only add noise to a dashboard. */
const HIDDEN_FIELDS = new Set(['_hash']);

function parseJsonl(text: string, source: string): Row[] {
  const rows: Row[] = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const v = JSON.parse(line) as unknown;
      if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(v as Row);
    } catch {
      throw new ToolError(`${source} line ${i + 1} is not valid JSON`);
    }
  });
  return rows;
}

/** The newest `limit` rows of a scraped dataset, in chronological order. */
async function readScrapedDataset(
  datasetsDir: string,
  name: string,
  limit: number,
): Promise<{ rows: Row[]; total: number }> {
  if (!DATASET_RE.test(name)) throw new ToolError(`invalid dataset name "${name}"`);
  const dir = path.join(datasetsDir, name);
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    const known = await listDatasets(datasetsDir);
    throw new ToolError(
      `no dataset "${name}" (known datasets: ${known.join(', ') || 'none yet; run a scraper first'})`,
    );
  }
  const newestFirst: Row[] = [];
  let total = 0;
  for (const f of files.reverse()) {
    const rows = parseJsonl(await fsp.readFile(path.join(dir, f), 'utf8'), `datasets/${name}/${f}`);
    total += rows.length;
    for (let i = rows.length - 1; i >= 0 && newestFirst.length < limit; i--) newestFirst.push(rows[i]!);
  }
  return { rows: newestFirst.reverse(), total };
}

export async function listDatasets(datasetsDir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(datasetsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && DATASET_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readFileSource(
  file: string,
  ctx: LoadContext,
  limit: number,
): Promise<{ rows: Row[]; total: number; display: string }> {
  const resolved = await ctx.workspace.resolve(file, 'read');
  const ext = path.extname(resolved.abs).toLowerCase();
  if (ext === '.parquet') {
    if (!ctx.sql?.queryRows) throw new ToolError('Parquet files need DuckDB (install @duckdb/node-api).');
    const r = await ctx.sql.queryRows(
      `SELECT * FROM read_parquet('${file.replace(/'/g, "''")}')`,
      limit,
      ctx,
    );
    return { rows: r.rows, total: r.total, display: resolved.display };
  }
  let text: string;
  try {
    text = await fsp.readFile(resolved.abs, 'utf8');
  } catch {
    throw new ToolError(`file not found: ${file}`);
  }
  let rows: Row[];
  if (ext === '.csv' || ext === '.tsv')
    rows = parseCsv(text, { delimiter: ext === '.tsv' ? '\t' : ',' }).rows;
  else if (ext === '.jsonl' || ext === '.ndjson') rows = parseJsonl(text, file);
  else if (ext === '.json') {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new ToolError(`${file} is not valid JSON`);
    }
    const arr = Array.isArray(doc)
      ? doc
      : doc && typeof doc === 'object' && Array.isArray((doc as { rows?: unknown }).rows)
        ? (doc as { rows: unknown[] }).rows
        : null;
    if (!arr) throw new ToolError(`${file} must hold an array of objects (or {"rows": [...]})`);
    rows = arr.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r));
  } else
    throw new ToolError(
      `unsupported file type ${ext || '(none)'}; use .csv, .tsv, .json, .jsonl or .parquet`,
    );
  return { rows: rows.slice(0, limit), total: rows.length, display: resolved.display };
}

function datasetsIn(textRef: string): string[] {
  return [...new Set([...textRef.matchAll(/datasets\/([a-z0-9][a-z0-9-_]{0,63})\//g)].map((m) => m[1]!))];
}

export async function loadDataSource(
  name: string,
  src: DataSourceSpec,
  ctx: LoadContext,
): Promise<LoadedDataset> {
  let rows: Row[];
  let total: number;
  let source: LoadedDataset['source'];
  let dependsOn: string[] = [];
  if (src.sql !== undefined) {
    if (!ctx.sql?.queryRows)
      throw new ToolError(
        `data "${name}" uses SQL but DuckDB is not available; use "dataset" or "file" sources instead`,
      );
    const r = await ctx.sql.queryRows(src.sql, src.limit, ctx);
    rows = r.rows;
    total = r.total;
    source = { kind: 'sql', text: src.sql.trim() };
    dependsOn = datasetsIn(src.sql);
  } else if (src.dataset !== undefined) {
    const r = await readScrapedDataset(ctx.datasetsDir, src.dataset, src.limit);
    rows = r.rows;
    total = r.total;
    source = { kind: 'dataset', text: src.dataset };
    dependsOn = [src.dataset];
  } else if (src.file !== undefined) {
    const r = await readFileSource(src.file, ctx, src.limit);
    rows = r.rows;
    total = r.total;
    source = { kind: 'file', text: r.display };
    dependsOn = datasetsIn(`${r.display}/`);
  } else {
    rows = (src.values ?? []).slice(0, src.limit);
    total = (src.values ?? []).length;
    source = { kind: 'values', text: `${total} inline rows` };
  }
  rows = rows.map((r) => {
    if (!Object.keys(r).some((k) => HIDDEN_FIELDS.has(k))) return r;
    const copy = { ...r };
    for (const k of HIDDEN_FIELDS) delete copy[k];
    return copy;
  });
  const columns = inferColumns(rows, src.columns ?? {});
  return {
    name,
    columns,
    rows: normalizeRows(rows, columns),
    totalRows: total,
    truncated: total > rows.length,
    source,
    description: src.description,
    dependsOn,
  };
}
