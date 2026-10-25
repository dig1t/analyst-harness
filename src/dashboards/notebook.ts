import type { DashboardSpec } from './spec';

type Cell = {
  cell_type: 'markdown' | 'code';
  metadata: Record<string, never>;
  source: string[];
  outputs?: [];
  execution_count?: null;
};

function lines(text: string): string[] {
  const parts = text.split('\n');
  return parts.map((l, i) => (i < parts.length - 1 ? `${l}\n` : l));
}

const md = (text: string): Cell => ({ cell_type: 'markdown', metadata: {}, source: lines(text) });
const code = (text: string): Cell => ({
  cell_type: 'code',
  metadata: {},
  source: lines(text),
  outputs: [],
  execution_count: null,
});

function pyString(s: string): string {
  return JSON.stringify(s);
}

/**
 * A Jupyter notebook that reloads each dashboard dataset with pandas and DuckDB, so a
 * researcher can continue the analysis in the tool they already use. Paths point at the
 * harness data folder; change HARNESS_DATA in the first cell when working on a copy.
 */
export function dashboardNotebook(spec: DashboardSpec, dataDir: string, workspaceDir: string): string {
  const cells: Cell[] = [
    md(
      `# ${spec.title}\n\n${spec.description ?? ''}\n\nThe datasets behind this dashboard, reloaded with pandas and DuckDB.`.trim(),
    ),
    code(
      [
        'from pathlib import Path',
        'import json',
        '',
        'import duckdb',
        'import pandas as pd',
        '',
        `HARNESS_DATA = Path(${pyString(dataDir)})  # where datasets/ lives`,
        `WORKSPACE = Path(${pyString(workspaceDir)})  # the agent workspace`,
        "DATASETS = HARNESS_DATA / 'datasets'",
        'con = duckdb.connect()',
      ].join('\n'),
    ),
  ];
  for (const [name, src] of Object.entries(spec.data)) {
    const variable = name.replace(/[^A-Za-z0-9_]/g, '_');
    cells.push(md(`## ${name}${src.description ? `\n\n${src.description}` : ''}`));
    if (src.sql !== undefined) {
      cells.push(
        code(
          [
            `sql = ${pyString(src.sql.trim())}`,
            '# Paths in the query are relative to the workspace; datasets/ is a mount.',
            'sql = sql.replace("\'datasets/", f"\'{DATASETS}/")',
            `${variable} = con.sql(sql).df()`,
            `${variable}.head()`,
          ].join('\n'),
        ),
      );
    } else if (src.dataset !== undefined) {
      cells.push(
        code(
          [
            `files = sorted((DATASETS / ${pyString(src.dataset)}).glob('*.jsonl'))`,
            `${variable} = pd.concat([pd.read_json(f, lines=True) for f in files], ignore_index=True)`,
            `${variable}.head()`,
          ].join('\n'),
        ),
      );
    } else if (src.file !== undefined) {
      const f = src.file;
      const ext = f.toLowerCase().split('.').pop();
      const where = f.startsWith('datasets/')
        ? `DATASETS / ${pyString(f.slice('datasets/'.length))}`
        : `WORKSPACE / ${pyString(f)}`;
      const reader =
        ext === 'csv'
          ? `pd.read_csv(${where})`
          : ext === 'tsv'
            ? `pd.read_csv(${where}, sep='\\t')`
            : ext === 'parquet'
              ? `pd.read_parquet(${where})`
              : ext === 'json'
                ? `pd.read_json(${where})`
                : `pd.read_json(${where}, lines=True)`;
      cells.push(code(`${variable} = ${reader}\n${variable}.head()`));
    } else {
      cells.push(
        code(
          `${variable} = pd.DataFrame(json.loads(${pyString(JSON.stringify(src.values ?? []))}))\n${variable}.head()`,
        ),
      );
    }
    cells.push(code(`${variable}.describe(include='all').T`));
  }
  return JSON.stringify(
    {
      cells,
      metadata: {
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' },
      },
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  );
}
