import type { z } from 'zod';
import type { ExternalStore } from '../core/context/external-store';
import type { PlanState } from '../core/planning/plan';
import type { Logger } from '../util/logger';
import type { PermissionManager, PermissionRequest } from '../safety/permissions';
import type { Workspace } from '../safety/workspace';
import { PermissionDeniedError } from '../util/errors';

/**
 * `workspace` tools act on files, data and the web; the bash-only action space removes them.
 * `execution` is the shell. `auxiliary` tools belong to other harness components (planning,
 * context recall, skills, knowledge, delegation) and stay available in both action spaces.
 */
export type ToolCategory = 'workspace' | 'execution' | 'auxiliary';

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Files created or modified, as display paths. */
  changedFiles?: string[];
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchHit {
  path: string;
  title: string;
  score: number;
  snippet: string;
}

export interface KnowledgeService {
  search(query: string, opts?: { limit?: number; topic?: string }): Promise<KnowledgeSearchHit[]>;
}

export interface SkillInfo {
  name: string;
  description: string;
  body: string;
  /** Bundled files as workspace display paths readable with read_file. */
  files: string[];
}

export interface SkillService {
  get(name: string): SkillInfo | undefined;
  list(): Array<{ name: string; description: string }>;
}

export interface DelegateResult {
  runId: string;
  outcome: string;
  finalText: string;
  costUsd: number;
}

export interface DelegateService {
  run(agent: string, task: string, parent: ToolContext): Promise<DelegateResult>;
  agents(): Array<{ name: string; description: string }>;
}

export interface ScraperService {
  run(name: string, opts?: { dryRun?: boolean }): Promise<string>;
  /** Validate and dry-run a spec given as YAML text (never writes datasets or state). */
  dryRunSpec?(yaml: string): Promise<string>;
  list(): Array<{ name: string; description: string; schedule?: string }>;
}

export interface SqlService {
  query(sql: string, maxRows: number, ctx: ToolContext): Promise<string>;
  /** Structured results for programmatic use (dashboards); `total` counts rows before the cap. */
  queryRows?(
    sql: string,
    maxRows: number,
    ctx: Pick<ToolContext, 'runId' | 'workspace'>,
  ): Promise<{ columns: string[]; rows: Array<Record<string, unknown>>; total: number }>;
  release?(runId: string): void;
}

export interface ToolServices {
  knowledge?: KnowledgeService;
  skills?: SkillService;
  delegate?: DelegateService;
  scrapers?: ScraperService;
  sql?: SqlService;
  fetch?: typeof fetch;
}

export interface ToolContext {
  runId: string;
  agent: string;
  step: number;
  depth: number;
  workspace: Workspace;
  permissions: PermissionManager;
  plan: PlanState;
  store: ExternalStore;
  services: ToolServices;
  logger: Logger;
  signal?: AbortSignal;
  /** Process environment used to build child-process environments. */
  env: NodeJS.ProcessEnv;
  config: ToolRuntimeConfig;
}

export interface ToolRuntimeConfig {
  bashTimeoutDefaultSec: number;
  bashTimeoutMaxSec: number;
  bashPassEnv: string[];
  maxReadBytes: number;
  webMaxBytes: number;
  webTimeoutMs: number;
  userAgent: string;
  allowPrivateNetwork: boolean;
  postEditDiagnostics: boolean;
}

export const DEFAULT_TOOL_RUNTIME: ToolRuntimeConfig = {
  bashTimeoutDefaultSec: 120,
  bashTimeoutMaxSec: 600,
  bashPassEnv: [],
  maxReadBytes: 5 * 1024 * 1024,
  webMaxBytes: 2 * 1024 * 1024,
  webTimeoutMs: 30_000,
  userAgent: 'analyst-harness/0.1 (+https://github.com/firebit-dev/analyst-harness)',
  allowPrivateNetwork: false,
  postEditDiagnostics: true,
};

export interface ToolDefinition<I = unknown> {
  name: string;
  /** Model-facing description: when to use it, protocol, error modes, side effects. */
  description: string;
  /** One line for the generated "Tool Usage Rules" system block. */
  usageRule?: string;
  schema: z.ZodType<I>;
  /** Read-only tools may run concurrently within one model turn. */
  readOnly: boolean;
  category: ToolCategory;
  execute(input: I, ctx: ToolContext): Promise<ToolOutput>;
}

/** Helper that keeps the input type inferred from the zod schema. */
export function defineTool<S extends z.ZodType>(
  def: ToolDefinition<z.infer<S>> & { schema: S },
): ToolDefinition<z.infer<S>> {
  return def;
}

export async function requirePermission(ctx: ToolContext, req: PermissionRequest): Promise<void> {
  const { allowed, decision } = await ctx.permissions.check(req, { runId: ctx.runId, agent: ctx.agent });
  if (!allowed) {
    throw new PermissionDeniedError(
      decision === 'deny'
        ? `Permission denied by policy: ${req.summary}. Don't retry this; choose a different approach.`
        : `Permission was not granted: ${req.summary}. Don't retry this; choose a different approach.`,
    );
  }
}
