import { z } from 'zod';
import { DEFAULT_CANDIDATES } from '../core/profiles';

const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const cron = z.string().min(9);

export const HarnessConfigSchema = z
  .object({
    paths: z
      .object({
        data: z.string().default('./data'),
        workspace: z.string().optional(),
        knowledge: z.string().default('./knowledge'),
        skills: z.string().default('./skills'),
        /** Writable folder for learned and proposed skills (defaults to the skills folder). */
        learnedSkills: z.string().optional(),
        agents: z.string().default('./agents'),
        scrapers: z.string().default('./config/scrapers'),
      })
      .default({
        data: './data',
        knowledge: './knowledge',
        skills: './skills',
        agents: './agents',
        scrapers: './config/scrapers',
      }),
    provider: z.enum(['anthropic', 'scripted']).default('anthropic'),
    models: z
      .object({
        default: z.string().default('claude-opus-5-5'),
        effort: effort.default('medium'),
        judge: z.string().optional(),
        summarizer: z.string().optional(),
        maxTokensPerTurn: z.number().int().min(1024).max(128_000).default(64_000),
      })
      .default({ default: 'claude-opus-5-5', effort: 'medium', maxTokensPerTurn: 64_000 }),
    anthropic: z
      .object({
        thinkingDisplay: z.enum(['omitted', 'summarized', 'updates']).default('updates'),
        prefixMismatch: z.enum(['drop_block', 'error']).default('drop_block'),
        fallbacks: z.boolean().default(true),
      })
      .default({ thinkingDisplay: 'updates', prefixMismatch: 'drop_block', fallbacks: true }),
    budgets: z
      .object({ dailyUsd: z.number().min(0).default(10), runUsd: z.number().min(0).default(2) })
      .default({ dailyUsd: 10, runUsd: 2 }),
    profiles: z
      .object({
        default: z.string().default('t4-plan-tools-128k'),
        selection: z.enum(['bandit', 'fixed']).default('bandit'),
        candidates: z.array(z.string()).min(1).default(DEFAULT_CANDIDATES),
        costWeight: z.number().min(0).max(1).default(0.15),
        costScaleUsd: z.number().positive().default(1),
        priors: z
          .record(z.string(), z.object({ alpha: z.number().positive(), beta: z.number().positive() }))
          .default({ 't4-plan-tools-128k': { alpha: 2, beta: 1 } }),
      })
      .default({
        default: 't4-plan-tools-128k',
        selection: 'bandit',
        candidates: DEFAULT_CANDIDATES,
        costWeight: 0.15,
        costScaleUsd: 1,
        priors: { 't4-plan-tools-128k': { alpha: 2, beta: 1 } },
      }),
    learning: z
      .object({
        enabled: z.boolean().default(true),
        judge: z.boolean().default(true),
        reflect: z.enum(['always', 'failures', 'never']).default('failures'),
        proposeSkills: z.boolean().default(true),
        minStepsForSkill: z.number().int().min(1).default(6),
        immediate: z.boolean().default(true),
        schedule: cron.default('17 3 * * *'),
      })
      .default({
        enabled: true,
        judge: true,
        reflect: 'failures',
        proposeSkills: true,
        minStepsForSkill: 6,
        immediate: true,
        schedule: '17 3 * * *',
      }),
    permissions: z
      .object({
        mode: z.enum(['default', 'trusted', 'readonly']).default('default'),
        cronMode: z.enum(['default', 'trusted', 'readonly']).default('default'),
        askFallback: z.enum(['allow', 'deny']).default('deny'),
        writeRequiresApproval: z.boolean().default(false),
        bashAllowExtra: z.array(z.string()).default([]),
        bashDenyExtra: z.array(z.string()).default([]),
        /** Unattended runs read untrusted content, so they skip bashAllowExtra unless this is true. */
        cronAllowExtra: z.boolean().default(false),
      })
      .default({
        mode: 'default',
        cronMode: 'default',
        askFallback: 'deny',
        writeRequiresApproval: false,
        bashAllowExtra: [],
        bashDenyExtra: [],
        cronAllowExtra: false,
      }),
    tools: z
      .object({
        bashPassEnv: z.array(z.string()).default([]),
        allowPrivateNetwork: z.boolean().default(false),
        postEditDiagnostics: z.boolean().default(true),
      })
      .default({ bashPassEnv: [], allowPrivateNetwork: false, postEditDiagnostics: true }),
    scrapers: z
      .object({
        userAgent: z
          .string()
          .default('analyst-harness/0.1 (+https://github.com/firebit-dev/analyst-harness)'),
        autoRepair: z.boolean().default(false),
        digestSchedule: cron.default('3 8 * * *'),
        digestEnabled: z.boolean().default(true),
      })
      .default({
        userAgent: 'analyst-harness/0.1 (+https://github.com/firebit-dev/analyst-harness)',
        autoRepair: false,
        digestSchedule: '3 8 * * *',
        digestEnabled: true,
      }),
    vault: z
      .object({
        lintSchedule: cron.default('41 4 * * 0'),
        /** Articles not updated for this many days count as stale in `vault status`. */
        staleDays: z.number().int().min(1).default(365),
        /** Opt-in: the librarian grounds the top of the verification queue in fetched sources. */
        verify: z
          .object({
            enabled: z.boolean().default(false),
            schedule: cron.default('23 5 * * 2,5'),
            articlesPerRun: z.number().int().min(1).max(10).default(2),
          })
          .strict()
          .default({ enabled: false, schedule: '23 5 * * 2,5', articlesPerRun: 2 }),
      })
      .strict()
      .default({
        lintSchedule: '41 4 * * 0',
        staleDays: 365,
        verify: { enabled: false, schedule: '23 5 * * 2,5', articlesPerRun: 2 },
      }),
    domains: z
      .object({
        /** The checked-in registry of probed hosts (config/domains.yaml). */
        file: z.string().default('./config/domains.yaml'),
        /** This deployment's column in the registry; HARNESS_ENVIRONMENT overrides it. */
        environment: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]{0,40}$/)
          .default('server'),
        /** web_fetch refuses a host after this many network failures in a row... */
        failFastAfter: z.number().int().min(1).max(20).default(3),
        /** ...for this many hours (0 turns it off). */
        failFastHours: z.number().min(0).max(168).default(6),
      })
      .strict()
      .default({ file: './config/domains.yaml', environment: 'server', failFastAfter: 3, failFastHours: 6 }),
    dashboards: z
      .object({
        /** Where dashboards are written (defaults to <data>/dashboards). */
        dir: z.string().optional(),
        /** Serve /dashboards/ on the web port; DASHBOARD_PASSWORD turns on basic auth. */
        serve: z.boolean().default(true),
        /** Keep an explorer dashboard per dataset, rebuilt after each scrape that adds data. */
        autoExplore: z.boolean().default(true),
        /** Largest dashboard file in MB (the data is embedded in the page). */
        maxMb: z.number().min(1).max(200).default(25),
      })
      .strict()
      .default({ serve: true, autoExplore: true, maxMb: 25 }),
    discord: z
      .object({
        prefixCommands: z.boolean().default(false),
        approvalTimeoutSec: z.number().int().min(10).max(3600).default(300),
      })
      .default({ prefixCommands: false, approvalTimeoutSec: 300 }),
    logging: z
      .object({
        level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
        format: z.enum(['json', 'pretty']).default('json'),
      })
      .default({ level: 'info', format: 'json' }),
  })
  .strict();

export type HarnessConfigInput = z.input<typeof HarnessConfigSchema>;
export type HarnessFileConfig = z.infer<typeof HarnessConfigSchema>;

export interface DashboardSettings {
  /** Basic-auth password for /dashboards/ (DASHBOARD_PASSWORD); no auth when unset. */
  password?: string;
  user: string;
  /** Base URL that serves the harness web port, for links in Discord (DASHBOARD_PUBLIC_URL). */
  publicUrl?: string;
}

export interface DiscordSettings {
  token?: string;
  applicationId?: string;
  guildId?: string;
  reportsChannelId?: string;
  alertsChannelId?: string;
  allowedUserIds: string[];
  allowedRoleIds: string[];
  adminUserIds: string[];
  allowEveryone: boolean;
  webhookReports?: string;
  webhookAlerts?: string;
}

/** Resolved configuration: file config plus environment, with absolute paths. */
export interface HarnessConfig extends HarnessFileConfig {
  root: string;
  resolved: {
    data: string;
    workspace: string;
    knowledge: string;
    skills: string;
    /** Where learned and proposed skills are written; defaults to the skills folder. */
    learnedSkills: string;
    agents: string;
    scrapers: string;
    runs: string;
    state: string;
    datasets: string;
    dashboards: string;
    domainsFile: string;
  };
  discordEnv: DiscordSettings;
  dashboardEnv: DashboardSettings;
}
