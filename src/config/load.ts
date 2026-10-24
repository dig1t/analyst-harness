import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { parseIdList } from '../discord/auth';
import { ConfigError } from '../util/errors';
import { HarnessConfigSchema, type HarnessConfig } from './schema';

function num(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Load config/harness.yaml (or HARNESS_CONFIG), apply environment overrides, validate, and
 * resolve every path against the project root. Secrets only ever come from the environment.
 */
export async function loadConfig(
  opts: { root?: string; file?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<HarnessConfig> {
  const env = opts.env ?? process.env;
  const root = path.resolve(opts.root ?? env.HARNESS_ROOT ?? process.cwd());
  const file = opts.file ?? env.HARNESS_CONFIG ?? path.join(root, 'config', 'harness.yaml');
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = YAML.parse(await fsp.readFile(path.resolve(root, file), 'utf8'));
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new ConfigError(`Cannot read ${file}: ${(err as Error).message}`);
  }

  const result = HarnessConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(
      `Invalid config ${file}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const cfg = result.data;

  // Environment overrides (handy for containers and CI).
  if (env.HARNESS_DATA_DIR) cfg.paths.data = env.HARNESS_DATA_DIR;
  if (env.HARNESS_WORKSPACE_DIR) cfg.paths.workspace = env.HARNESS_WORKSPACE_DIR;
  if (env.HARNESS_KNOWLEDGE_DIR) cfg.paths.knowledge = env.HARNESS_KNOWLEDGE_DIR;
  if (env.HARNESS_SKILLS_DIR) cfg.paths.skills = env.HARNESS_SKILLS_DIR;
  if (env.HARNESS_LEARNED_SKILLS_DIR) cfg.paths.learnedSkills = env.HARNESS_LEARNED_SKILLS_DIR;
  if (env.HARNESS_SCRAPERS_DIR) cfg.paths.scrapers = env.HARNESS_SCRAPERS_DIR;
  if (env.HARNESS_AGENTS_DIR) cfg.paths.agents = env.HARNESS_AGENTS_DIR;
  if (env.HARNESS_MODEL) cfg.models.default = env.HARNESS_MODEL;
  if (env.HARNESS_PROVIDER === 'anthropic' || env.HARNESS_PROVIDER === 'scripted')
    cfg.provider = env.HARNESS_PROVIDER;
  const daily = num(env.HARNESS_DAILY_BUDGET_USD);
  if (daily !== undefined) cfg.budgets.dailyUsd = daily;
  const perRun = num(env.HARNESS_RUN_BUDGET_USD);
  if (perRun !== undefined) cfg.budgets.runUsd = perRun;
  if (env.LOG_LEVEL && ['debug', 'info', 'warn', 'error', 'silent'].includes(env.LOG_LEVEL))
    cfg.logging.level = env.LOG_LEVEL as HarnessConfig['logging']['level'];
  if (env.LOG_FORMAT === 'json' || env.LOG_FORMAT === 'pretty') cfg.logging.format = env.LOG_FORMAT;

  const abs = (p: string) => path.resolve(root, p);
  const data = abs(cfg.paths.data);
  return {
    ...cfg,
    root,
    resolved: {
      data,
      workspace: cfg.paths.workspace ? abs(cfg.paths.workspace) : path.join(data, 'workspace'),
      knowledge: abs(cfg.paths.knowledge),
      skills: abs(cfg.paths.skills),
      learnedSkills: abs(cfg.paths.learnedSkills ?? cfg.paths.skills),
      agents: abs(cfg.paths.agents),
      scrapers: abs(cfg.paths.scrapers),
      runs: path.join(data, 'runs'),
      state: path.join(data, 'state'),
      datasets: path.join(data, 'datasets'),
    },
    discordEnv: {
      token: env.DISCORD_TOKEN || undefined,
      applicationId: env.DISCORD_APPLICATION_ID || undefined,
      guildId: env.DISCORD_GUILD_ID || undefined,
      reportsChannelId: env.DISCORD_REPORTS_CHANNEL_ID || undefined,
      alertsChannelId: env.DISCORD_ALERTS_CHANNEL_ID || undefined,
      allowedUserIds: parseIdList(env.DISCORD_ALLOWED_USER_IDS),
      allowedRoleIds: parseIdList(env.DISCORD_ALLOWED_ROLE_IDS),
      adminUserIds: parseIdList(env.DISCORD_ADMIN_USER_IDS),
      allowEveryone: env.DISCORD_ALLOW_EVERYONE === 'true',
      webhookReports: env.DISCORD_WEBHOOK_REPORTS_URL || undefined,
      webhookAlerts: env.DISCORD_WEBHOOK_ALERTS_URL || undefined,
    },
  };
}
