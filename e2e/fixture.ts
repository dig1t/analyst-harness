import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DashboardService } from '../src/dashboards/service';
import { Workspace } from '../src/safety/workspace';

/** Deterministic releases across three years, three packages and two categories. */
export function releases(): Array<Record<string, unknown>> {
  const packages = [
    { name: 'requests', category: 'HTTP client' },
    { name: 'httpx', category: 'HTTP client' },
    { name: 'lxml', category: 'Parser' },
  ];
  return Array.from({ length: 180 }, (_, i) => {
    const p = packages[i % 3]!;
    return {
      package: p.name,
      category: p.category,
      version: `1.${Math.floor(i / 3)}.0`,
      released_at: new Date(Date.UTC(2024, 0, 1) + i * 6 * 86_400_000).toISOString(),
      size_bytes: (p.name === 'lxml' ? 5_000_000 : 80_000) * (1 + (i % 7)),
      files: p.name === 'lxml' ? 20 + (i % 9) : 2,
      has_wheel: i % 4 !== 0,
      url: `https://pypi.org/project/${p.name}/1.${Math.floor(i / 3)}.0/`,
    };
  });
}

export const SPEC = {
  title: 'E2E releases',
  data: { rel: { dataset: 'releases', columns: { size_bytes: { label: 'Size', format: 'bytes' } } } },
  filters: [
    { type: 'daterange', field: 'released_at', label: 'Released' },
    { type: 'select', field: 'category', label: 'Category' },
    { type: 'search', fields: ['package', 'version'] },
  ],
  sections: [
    {
      items: [
        { type: 'kpi', title: 'Releases', value: 'count' },
        { type: 'kpi', title: 'Packages', value: 'distinct(package)' },
      ],
    },
    {
      title: 'Activity',
      items: [
        {
          type: 'line',
          title: 'Releases per month',
          x: { field: 'released_at', interval: 'month' },
          y: 'count',
          series: { field: 'category' },
          width: 8,
        },
        { type: 'facets', fields: ['category', 'package'], width: 4 },
        { type: 'bar', title: 'By package', x: { field: 'package' }, y: 'count', width: 6 },
        { type: 'histogram', title: 'Size', field: 'size_bytes', width: 6 },
        {
          type: 'table',
          title: 'Every release',
          columns: [
            'package',
            { field: 'version', link: 'url' },
            'released_at',
            { field: 'size_bytes', bar: true },
          ],
          sort: { field: 'released_at', direction: 'desc' },
        },
      ],
    },
  ],
};

/** Build the fixture dashboard into a temporary folder and return its index.html path. */
export async function buildFixture(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'harness-e2e-'));
  const datasets = path.join(root, 'datasets');
  await fsp.mkdir(path.join(datasets, 'releases'), { recursive: true });
  await fsp.writeFile(
    path.join(datasets, 'releases', '2026-10-25.jsonl'),
    releases()
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n',
  );
  const workspace = new Workspace([
    { alias: '', dir: path.join(root, 'ws'), mode: 'rw' },
    { alias: 'datasets', dir: datasets, mode: 'ro' },
  ]);
  const svc = new DashboardService({
    dir: path.join(root, 'dashboards'),
    datasetsDir: datasets,
    dataDir: root,
    workspaceDir: path.join(root, 'ws'),
    defaultWorkspace: () => workspace,
  });
  return (await svc.build(SPEC)).path;
}
