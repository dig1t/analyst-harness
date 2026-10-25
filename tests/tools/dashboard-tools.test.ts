import path from 'node:path';
import { DashboardService } from '../../src/dashboards/service';
import { executeToolCall } from '../../src/tools/executor';
import { buildDashboardTool, profileDataTool } from '../../src/tools/dashboard-tools';
import { ToolRegistry } from '../../src/tools/registry';
import type { DashboardToolService, ToolDefinition } from '../../src/tools/types';
import { makeToolContext, makeWorkspace, writeFiles } from '../helpers';

const OPTS = { maxResultChars: 24_000, maxParallelReadOnly: 8 };

async function setup(policy: NonNullable<Parameters<typeof makeToolContext>[1]>['policy'] = {}) {
  const { root, workspace } = await makeWorkspace();
  await writeFiles(root, {
    'out/sales.csv': 'region,amount\nNorth,10\nSouth,32\nEast,7\n',
    'specs/sales.yaml': [
      'title: Sales by region',
      'data:',
      '  s: { file: out/sales.csv }',
      'items:',
      '  - { type: kpi, title: Total, value: sum(amount) }',
      '  - { type: bar, x: { field: region }, y: sum(amount) }',
    ].join('\n'),
  });
  const service = new DashboardService({
    dir: path.join(root, '.dashboards'),
    datasetsDir: path.join(root, 'datasets'),
    dataDir: root,
    workspaceDir: root,
    defaultWorkspace: () => workspace,
  });
  const dashboards: DashboardToolService = {
    build: async (spec, ctx) => {
      const r = await service.build(spec, { runId: ctx.runId, workspace: ctx.workspace, source: 'agent' });
      const displayPath = `dashboards/${r.meta.slug}/index.html`;
      return { summary: DashboardService.summary(r, displayPath), displayPath };
    },
    profile: (src, ctx) => service.profile(src, ctx),
  };
  const ctx = makeToolContext(workspace, { services: { dashboards }, policy });
  const registry = new ToolRegistry([buildDashboardTool, profileDataTool] as Array<ToolDefinition<never>>);
  const call = (name: string, input: unknown) =>
    executeToolCall({ type: 'tool_call', id: 'c1', name, input }, registry, ctx, OPTS);
  return { root, service, call };
}

describe('dashboard tools', () => {
  test('build_dashboard publishes from a spec file or inline YAML and reports fixes', async () => {
    const { service, call } = await setup();
    const fromFile = await call('build_dashboard', { spec_path: 'specs/sales.yaml' });
    expect(fromFile.isError).toBeFalsy();
    expect(fromFile.content).toContain('Built dashboard "Sales by region" (sales-by-region)');
    expect(fromFile.content).toContain('File: dashboards/sales-by-region/index.html');
    expect(fromFile.content).toContain('Data: s 3 rows x 2 columns');
    expect(fromFile.changedFiles).toEqual(['dashboards/sales-by-region/index.html']);
    expect((await service.get('sales-by-region'))!.runId).toBe('run_test');

    const inline = await call('build_dashboard', {
      spec: { title: 'Inline', data: { s: { values: [{ a: 1 }] } }, items: [{ type: 'table' }] },
    });
    expect(inline.content).toContain('Built dashboard "Inline"');

    const broken = await call('build_dashboard', {
      spec: 'title: Bad\ndata: { s: { file: out/sales.csv } }\nitems:\n  - { type: bar, x: { field: city }, y: count }',
    });
    expect(broken.isError).toBe(true);
    expect(broken.content).toContain(
      'x.field "city" is not a column of "s"; columns: region (string), amount',
    );

    const both = await call('build_dashboard', { spec: 'title: x', spec_path: 'specs/sales.yaml' });
    expect(both.content).toContain('Pass exactly one of spec');
    const missing = await call('build_dashboard', { spec_path: 'specs/none.yaml' });
    expect(missing.content).toContain('Cannot read spec file specs/none.yaml');
  });

  test('build_dashboard is a write: read-only runs cannot publish', async () => {
    const { call, service } = await setup({ mode: 'readonly' });
    const r = await call('build_dashboard', { spec_path: 'specs/sales.yaml' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('Permission denied by policy: publish the dashboard "Sales by region"');
    expect(await service.list()).toEqual([]);
  });

  test('profile_data describes a file and suggests components', async () => {
    const { call } = await setup();
    const r = await call('profile_data', { file: 'out/sales.csv' });
    expect(r.content).toContain('Dataset out/sales.csv: 3 rows, 2 columns');
    expect(r.content).toContain('- amount [integer] 100% filled');
    expect(r.content).toContain('- measures: amount');
    expect(r.content).toContain('categories with few values: region');
    const none = await call('profile_data', {});
    expect(none.content).toContain('give exactly one of dataset, sql or file');
  });

  test('without the service both tools explain that dashboards are off', async () => {
    const { workspace } = await makeWorkspace();
    const ctx = makeToolContext(workspace);
    const registry = new ToolRegistry([buildDashboardTool, profileDataTool] as Array<ToolDefinition<never>>);
    for (const name of ['build_dashboard', 'profile_data']) {
      const r = await executeToolCall(
        { type: 'tool_call', id: 'c', name, input: { dataset: 'x', spec: 'x' } },
        registry,
        ctx,
        OPTS,
      );
      expect(r.content).toContain('Dashboards are not configured');
    }
  });
});
