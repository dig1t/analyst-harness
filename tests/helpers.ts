import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExternalStore } from '../src/core/context/external-store';
import { PlanState } from '../src/core/planning/plan';
import type { RunResult } from '../src/core/agent-loop';
import { emptyUsage } from '../src/core/types';
import {
  PermissionManager,
  DEFAULT_POLICY,
  type PermissionPolicy,
  type ApprovalGateway,
} from '../src/safety/permissions';
import { Workspace, type Mount } from '../src/safety/workspace';
import { DEFAULT_TOOL_RUNTIME, type ToolContext, type ToolServices } from '../src/tools/types';
import { silentLogger } from '../src/util/logger';

export async function tmpDir(prefix = 'harness-test-'): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');
  }
}

export async function makeWorkspace(
  extraMounts: Mount[] = [],
): Promise<{ root: string; workspace: Workspace }> {
  const root = await tmpDir('harness-ws-');
  return { root, workspace: new Workspace([{ alias: '', dir: root, mode: 'rw' }, ...extraMounts]) };
}

export function makeToolContext(
  workspace: Workspace,
  overrides: Partial<ToolContext> & {
    policy?: Partial<PermissionPolicy>;
    gateway?: ApprovalGateway;
    services?: ToolServices;
  } = {},
): ToolContext {
  const { policy, gateway, ...rest } = overrides;
  return {
    runId: 'run_test',
    agent: 'tester',
    step: 1,
    depth: 0,
    workspace,
    permissions: new PermissionManager({ ...DEFAULT_POLICY, ...(policy ?? {}) }, gateway),
    plan: new PlanState(),
    store: new ExternalStore(),
    services: {},
    logger: silentLogger,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      SECRET_TOKEN: 'shh',
      ANTHROPIC_API_KEY: 'sk-test',
    },
    config: { ...DEFAULT_TOOL_RUNTIME, postEditDiagnostics: false },
    ...rest,
  };
}

export interface FakeRoute {
  status?: number;
  body?: string | object;
  headers?: Record<string, string>;
}

/** A fetch stand-in keyed by URL. Records every call for assertions. */
export function fakeFetch(routes: Record<string, FakeRoute | ((init?: RequestInit) => FakeRoute)>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    const r = typeof route === 'function' ? route(init) : route;
    const body = typeof r.body === 'string' || r.body === undefined ? (r.body ?? '') : JSON.stringify(r.body);
    const headers = {
      'content-type': typeof r.body === 'object' ? 'application/json' : 'text/html',
      ...(r.headers ?? {}),
    };
    const status = r.status ?? 200;
    return new Response(status === 204 || status === 304 ? null : body, { status, headers });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** DNS stub that resolves every name to a public documentation address. */
export const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

export function sampleResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    runId: 'run_1',
    agent: 'analyst',
    profileId: 't4-plan-tools-128k',
    model: 'claude-opus-5-5',
    task: 'How many rows are in datasets/x?',
    outcome: 'completed',
    finalText: 'There are 42 rows.',
    steps: 3,
    toolCalls: 2,
    toolErrors: 0,
    usage: emptyUsage(),
    costUsd: 0.05,
    plan: '(no plan)',
    changedFiles: [],
    contextEvents: 0,
    summaryCalls: 0,
    recallCalls: 0,
    stuckReminders: 0,
    startedAt: '2026-10-24T00:00:00.000Z',
    endedAt: '2026-10-24T00:01:00.000Z',
    ...overrides,
  };
}
