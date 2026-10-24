import path from 'node:path';
import { ToolError, errorMessage } from '../util/errors';
import { markdownTable } from '../util/text';
import type { Workspace } from '../safety/workspace';
import type { SqlService, ToolContext } from './types';

const FILE_FUNCTIONS =
  'read_csv|read_csv_auto|read_json|read_json_auto|read_ndjson|read_ndjson_auto|read_ndjson_objects|read_json_objects|read_parquet|parquet_scan|parquet_metadata|parquet_schema|read_text|read_blob|read_xlsx|sniff_csv|glob';
const FUNC_RE = new RegExp(`\\b(${FILE_FUNCTIONS})\\s*\\(\\s*(\\[[^\\]]*\\]|'(?:[^']|'')*')`, 'gi');
const KEYWORD_RE = /\b(FROM|JOIN|TO|ATTACH)\s+'((?:[^']|'')*)'/gi;

export interface RewriteResult {
  sql: string;
  writes: string[];
}

/**
 * DuckDB's sandbox (enable_external_access=false + allowed_directories) only accepts
 * absolute paths, so file literals in table-function arguments and after FROM/JOIN/TO are
 * rewritten to absolute workspace paths. Mount aliases (`knowledge/...`) resolve as in the
 * file tools, and COPY ... TO targets must be writable mounts.
 */
export function rewriteSqlPaths(sql: string, workspace: Workspace): RewriteResult {
  const writes: string[] = [];
  const fix = (literal: string, isWrite: boolean): string => {
    const value = literal.replace(/''/g, "'");
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      throw new ToolError(
        `Remote URLs are not allowed in sql_query (${value}). Download the data with a scraper or web_fetch first.`,
      );
    }
    const located = workspace.locate(value);
    if (isWrite) {
      if (located.mount.mode === 'ro') throw new ToolError(`Cannot write to read-only mount path ${value}.`);
      writes.push(workspace.display(located.abs, located.mount));
    }
    return `'${located.abs.split(path.sep).join('/').replace(/'/g, "''")}'`;
  };
  let out = sql.replace(FUNC_RE, (_m, fn: string, arg: string) => {
    if (arg.startsWith('[')) {
      const list = arg.replace(/'((?:[^']|'')*)'/g, (lit) => fix(lit.slice(1, -1), false));
      return `${fn}(${list}`;
    }
    return `${fn}(${fix(arg.slice(1, -1), false)}`;
  });
  out = out.replace(KEYWORD_RE, (_m, kw: string, lit: string) => {
    if (kw.toUpperCase() === 'ATTACH') throw new ToolError('ATTACH is not allowed in sql_query.');
    return `${kw} ${fix(lit, kw.toUpperCase() === 'TO')}`;
  });
  return { sql: out, writes };
}

/** DuckDB is an optional dependency; load it lazily so the harness runs without it. */
function loadDuckDb(): unknown {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@duckdb/node-api');
}

type DuckConnection = {
  runAndReadAll(sql: string): Promise<{
    columnNames(): string[];
    getRowObjectsJson(): Array<Record<string, unknown>>;
  }>;
  closeSync?: () => void;
};

/** Per-run DuckDB in-memory database, sandboxed to the workspace mounts. */
export class DuckDbSqlService implements SqlService {
  private connections = new Map<string, Promise<DuckConnection>>();

  constructor(private readonly loader: () => Promise<unknown> = async () => loadDuckDb()) {}

  static async isAvailable(): Promise<boolean> {
    try {
      loadDuckDb();
      return true;
    } catch {
      return false;
    }
  }

  private async connect(workspace: Workspace): Promise<DuckConnection> {
    const mod = (await this.loader()) as {
      DuckDBInstance: {
        create(path: string, opts?: Record<string, string>): Promise<{ connect(): Promise<DuckConnection> }>;
      };
    };
    const instance = await mod.DuckDBInstance.create(':memory:', { threads: '2' });
    const con = await instance.connect();
    const dirs = workspace.allMounts
      .map((m) => `'${m.dir.split(path.sep).join('/').replace(/'/g, "''")}/'`)
      .join(', ');
    for (const stmt of [
      `SET allowed_directories = [${dirs}]`,
      'SET autoinstall_known_extensions = false',
      'SET autoload_known_extensions = false',
      'SET enable_external_access = false',
      'SET lock_configuration = true',
    ]) {
      await con.runAndReadAll(stmt);
    }
    return con;
  }

  private connection(ctx: ToolContext): Promise<DuckConnection> {
    let con = this.connections.get(ctx.runId);
    if (!con) {
      con = this.connect(ctx.workspace);
      this.connections.set(ctx.runId, con);
    }
    return con;
  }

  release(runId: string): void {
    const con = this.connections.get(runId);
    this.connections.delete(runId);
    void con?.then((c) => c.closeSync?.()).catch(() => undefined);
  }

  async query(sql: string, maxRows: number, ctx: ToolContext): Promise<string> {
    const { sql: rewritten, writes } = rewriteSqlPaths(sql, ctx.workspace);
    const con = await this.connection(ctx);
    let reader;
    try {
      reader = await con.runAndReadAll(rewritten);
    } catch (err) {
      throw new ToolError(`DuckDB error: ${errorMessage(err).split('\n').slice(0, 6).join('\n')}`);
    }
    const columns = reader.columnNames();
    const rows = reader.getRowObjectsJson();
    const shown = rows.slice(0, maxRows);
    const fmt = (v: unknown) =>
      v === null || v === undefined ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    const table = columns.length
      ? markdownTable(
          columns,
          shown.map((r) => columns.map((c) => fmt(r[c]))),
        )
      : '(no columns)';
    const note =
      rows.length > shown.length
        ? `\n(${rows.length} rows total, showing the first ${shown.length}; aggregate or add LIMIT)`
        : `\n(${rows.length} row${rows.length === 1 ? '' : 's'})`;
    const written = writes.length ? `\nWrote: ${writes.join(', ')}` : '';
    return `${table}${note}${written}`;
  }
}
