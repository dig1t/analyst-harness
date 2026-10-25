import { promises as fsp } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { ToolError } from '../util/errors';
import { defineTool, requirePermission, type ToolDefinition } from './types';

/** Best-effort title for the approval prompt; the service does the real parsing. */
function titleOf(input: unknown): string | undefined {
  let doc = input;
  if (typeof doc === 'string') {
    try {
      doc = YAML.parse(doc) as unknown;
    } catch {
      return undefined;
    }
  }
  const title = doc && typeof doc === 'object' ? (doc as { title?: unknown }).title : undefined;
  return typeof title === 'string' ? title.slice(0, 120) : undefined;
}

export const buildDashboardTool = defineTool({
  name: 'build_dashboard',
  category: 'auxiliary',
  readOnly: false,
  usageRule:
    'publish an interactive dashboard from a YAML or JSON spec; run profile_data first and load the build-dashboard skill for the spec reference.',
  description: `Build an interactive dashboard and publish it as one self-contained HTML file: KPI tiles, charts with tooltips, cross-filtering, facets, a searchable table, column profiles and CSV/PNG exports, all working offline. The harness serves it at /dashboards/<slug>/ and lists it in the catalog; a Jupyter notebook that reloads the same data is written next to it.
When: the user asks for a dashboard, a report page, charts, or a way to browse or explore data, or a finding is clearer shown than described. Profile every source with profile_data first and load the build-dashboard skill for the full reference and design rules.
Spec (YAML or JSON text, or an object):
  title: PyPI releases
  data:
    rel: { dataset: pypi-releases }   # or sql: "SELECT ...", file: out/x.csv, values: [{...}]
  filters: [{ type: daterange, field: released_at }, { type: select, field: package }]
  sections:
    - title: Activity
      items:
        - { type: kpi, title: Releases, value: count, delta: { field: released_at, period: 30d } }
        - { type: line, x: { field: released_at, interval: month }, y: count, series: { field: package }, width: 8 }
        - { type: facets, fields: [package], width: 4 }
        - { type: table, columns: [package, version, { field: url, link: url }] }
Components: kpi, line, area, bar, scatter, histogram, heatmap, pivot, table, facets, profile, markdown. Aggregates: count, sum(f), mean(f), median(f), min(f), max(f), distinct(f), p10(f), p90(f), first(f), last(f). width is 1 to 12 grid columns. With several data sources, set data: <name> on each component.
Error modes: spec and data problems come back as a numbered list of fixes (unknown field, wrong type, too many series); fix them and call again. Warnings come back with the result.
Side effects: writes dashboards/<slug>/ (index.html, notebook.ipynb, spec.json, meta.json); building the same slug again replaces it.`,
  schema: z.object({
    spec: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    spec_path: z.string().min(1).optional(),
  }),
  async execute({ spec, spec_path }, ctx) {
    const dashboards = ctx.services.dashboards;
    if (!dashboards) throw new ToolError('Dashboards are not configured in this harness.');
    if ((spec === undefined) === (spec_path === undefined))
      throw new ToolError(
        'Pass exactly one of spec (YAML or JSON text, or an object) or spec_path (a spec file in the workspace).',
      );
    let input: unknown = spec;
    if (spec_path) {
      const r = await ctx.workspace.resolve(spec_path, 'read');
      input = await fsp.readFile(r.abs, 'utf8').catch(() => {
        throw new ToolError(`Cannot read spec file ${r.display}.`);
      });
    }
    const title = titleOf(input);
    await requirePermission(ctx, {
      kind: 'write',
      tool: 'build_dashboard',
      summary: `publish the dashboard ${title ? `"${title}"` : '(untitled)'} under dashboards/`,
      path: 'dashboards/',
    });
    const built = await dashboards.build(input, ctx);
    return { content: built.summary, changedFiles: [built.displayPath] };
  },
});

export const profileDataTool = defineTool({
  name: 'profile_data',
  category: 'workspace',
  readOnly: true,
  usageRule: 'profile a dataset, SQL result or file (types, fill, ranges, top values) before charting it.',
  description: `Profile a data source: row count, then for every column its inferred type, fill rate, distinct count, range and top values, followed by component suggestions (time axes, measures, low-cardinality categories) and sample rows.
When: before build_dashboard, and whenever you need a quick, reliable look at a dataset's shape before analysis.
Protocol: give exactly one of dataset (a scraped dataset name, as in datasets/<name>/), sql (DuckDB SQL over workspace files) or file (a workspace .csv, .json, .jsonl or .parquet). limit caps the rows read (default 20000).
Error modes: unknown datasets, unreadable files and SQL errors come back as error observations.
Side effects: none.`,
  schema: z.object({
    dataset: z.string().min(1).optional(),
    sql: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200_000).optional(),
  }),
  async execute(input, ctx) {
    const dashboards = ctx.services.dashboards;
    if (!dashboards) throw new ToolError('Dashboards are not configured in this harness.');
    return { content: await dashboards.profile(input, ctx) };
  },
});

export const dashboardTools: Array<ToolDefinition<never>> = [buildDashboardTool, profileDataTool] as Array<
  ToolDefinition<never>
>;
