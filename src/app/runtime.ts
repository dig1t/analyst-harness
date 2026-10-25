import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { FALLBACK_AGENT, loadAgents, type AgentDefinition } from '../agents/definition';
import type { HarnessConfig } from '../config/schema';
import { explorerSlug } from '../dashboards/explorer';
import { DashboardService, type DashboardMeta } from '../dashboards/service';
import { runAgent, type AgentEvent, type RunResult } from '../core/agent-loop';
import { resolveProfile, type HarnessProfile } from '../core/profiles';
import { denyAllGateway } from '../discord/approvals';
import {
  ConsoleNotifier,
  MultiNotifier,
  WebhookNotifier,
  type Notification,
  type Notifier,
} from '../discord/notifier';
import type { DashboardInfo, HarnessOps } from '../discord/router';
import { accuracyReport, formatAccuracy, verificationTask, type AccuracyReport } from '../knowledge/accuracy';
import { KnowledgeVault } from '../knowledge/vault';
import { AnthropicProvider } from '../llm/anthropic';
import { PriceBook } from '../llm/pricing';
import type { LLMProvider } from '../llm/provider';
import { ScriptedProvider } from '../llm/scripted';
import { SpendTracker } from '../llm/spend';
import { ProfileBandit } from '../learning/bandit';
import { RunJudge } from '../learning/judge';
import { Reflector } from '../learning/reflection';
import { RunStore, type RunMeta } from '../learning/run-store';
import { LearningService } from '../learning/service';
import { SkillSynthesizer } from '../learning/skill-synthesis';
import { classifyTask } from '../learning/task-classifier';
import {
  DEFAULT_BASH_ALLOW,
  DEFAULT_BASH_DENY,
  PermissionManager,
  type ApprovalGateway,
} from '../safety/permissions';
import { Workspace, type Mount } from '../safety/workspace';
import { DomainRegistry, loadDomainSeed } from '../net/domains';
import { Scheduler } from '../scheduler/scheduler';
import { PoliteHttpClient } from '../scrapers/http-client';
import { ScraperRegistry } from '../scrapers/registry';
import { formatScrapeReport, ScraperRunner, type ScrapeReport } from '../scrapers/runner';
import { parseScraperSpec } from '../scrapers/spec';
import { SkillRegistry } from '../skills/registry';
import { bashTool } from '../tools/bash-tool';
import { dashboardTools } from '../tools/dashboard-tools';
import { fileTools } from '../tools/fs-tools';
import { harnessTools } from '../tools/harness-tools';
import { ToolRegistry } from '../tools/registry';
import { DuckDbSqlService } from '../tools/sql-engine';
import {
  DEFAULT_TOOL_RUNTIME,
  type DelegateService,
  type ToolContext,
  type ToolDefinition,
  type ToolRuntimeConfig,
  type ToolServices,
} from '../tools/types';
import { webFetchTool } from '../tools/web-fetch';
import { ensureDir } from '../util/fs';
import { newId } from '../util/ids';
import { createLogger, type Logger } from '../util/logger';
import { errorMessage } from '../util/errors';
import { formatUsd } from '../util/text';

/** Discord's upload limit for bots, with headroom. */
const DISCORD_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export interface RunTaskRequest {
  task: string;
  agent?: string;
  profile?: string;
  source: 'discord' | 'cli' | 'cron' | 'delegate' | 'api';
  requestedBy?: string;
  approvals?: ApprovalGateway;
  permissions?: PermissionManager;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
  depth?: number;
}

export interface RuntimeOptions {
  config: HarnessConfig;
  env?: NodeJS.ProcessEnv;
  logger?: Logger;
  provider?: LLMProvider;
  fetch?: typeof fetch;
  /** Skip loading DuckDB (tests). */
  disableSql?: boolean;
}

/**
 * Composition root: builds every component from config and exposes the operations used by
 * the CLI, the scheduler and the Discord bot.
 */
export class HarnessRuntime {
  readonly logger: Logger;
  readonly priceBook = new PriceBook();
  readonly registry = new ToolRegistry([
    ...fileTools,
    bashTool,
    webFetchTool,
    ...harnessTools,
    ...dashboardTools,
  ] as Array<ToolDefinition<never>>);
  readonly scheduler: Scheduler;
  readonly notifier: MultiNotifier;
  private readonly notifiers: Notifier[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly startedAt = new Date();
  private agents = new Map<string, AgentDefinition>();
  private sql?: DuckDbSqlService;
  /** Built in create(), after SQL, so dashboards can read query results. */
  dashboards!: DashboardService;
  private readonly env: NodeJS.ProcessEnv;

  private constructor(
    readonly config: HarnessConfig,
    readonly provider: LLMProvider,
    readonly spend: SpendTracker,
    readonly runs: RunStore,
    readonly bandit: ProfileBandit,
    readonly vault: KnowledgeVault,
    readonly skills: SkillRegistry,
    readonly synthesizer: SkillSynthesizer,
    readonly reflector: Reflector,
    readonly learning: LearningService,
    readonly scrapers: ScraperRegistry,
    readonly http: PoliteHttpClient,
    readonly domains: DomainRegistry,
    opts: RuntimeOptions,
    logger: Logger,
  ) {
    this.logger = logger;
    this.env = opts.env ?? process.env;
    this.notifiers.push(new ConsoleNotifier(logger.child({ component: 'notify' })));
    const d = config.discordEnv;
    if (d.webhookReports || d.webhookAlerts)
      this.notifiers.push(
        new WebhookNotifier(
          { reports: d.webhookReports, alerts: d.webhookAlerts },
          opts.fetch ?? fetch,
          logger,
        ),
      );
    this.notifier = new MultiNotifier(this.notifiers);
    this.scheduler = new Scheduler(undefined, logger.child({ component: 'scheduler' }), (job, error) =>
      this.notify({ channel: 'alerts', title: `Job failed: ${job}`, body: error, level: 'error' }),
    );
  }

  static async create(opts: RuntimeOptions): Promise<HarnessRuntime> {
    const { config } = opts;
    const logger =
      opts.logger ?? createLogger({ level: config.logging.level, format: config.logging.format });
    for (const dir of [
      config.resolved.data,
      config.resolved.workspace,
      config.resolved.runs,
      config.resolved.state,
      config.resolved.datasets,
      config.resolved.dashboards,
    ])
      await ensureDir(dir);

    const provider =
      opts.provider ??
      (config.provider === 'scripted'
        ? new ScriptedProvider(() => ({
            text: 'The scripted provider is active (HARNESS_PROVIDER=scripted). Configure ANTHROPIC_API_KEY to use Claude.',
          }))
        : new AnthropicProvider({
            apiKey: opts.env?.ANTHROPIC_API_KEY,
            thinkingDisplay: config.anthropic.thinkingDisplay,
            prefixMismatch: config.anthropic.prefixMismatch,
            fallbacks: config.anthropic.fallbacks,
            logger: logger.child({ component: 'anthropic' }),
          }));
    const spend = await new SpendTracker(
      config.budgets.dailyUsd,
      path.join(config.resolved.state, 'spend.json'),
    ).load();
    const runs = new RunStore(config.resolved.runs);
    const bandit = await new ProfileBandit(path.join(config.resolved.state, 'bandit.json'), {
      costWeight: config.profiles.costWeight,
      costScaleUsd: config.profiles.costScaleUsd,
      priors: config.profiles.priors,
    }).load();
    const vault = new KnowledgeVault(config.resolved.knowledge);
    const separateLearned = config.resolved.learnedSkills !== config.resolved.skills;
    const skills = await SkillRegistry.load(
      config.resolved.skills,
      'skills',
      logger.child({ component: 'skills' }),
      separateLearned ? [{ dir: config.resolved.learnedSkills, alias: 'learned-skills' }] : [],
    );
    const priceBook = new PriceBook();
    const judgeModel = config.models.judge ?? config.models.default;
    const synthesizer = new SkillSynthesizer(config.resolved.learnedSkills, provider, judgeModel, priceBook);
    const reflector = new Reflector(provider, judgeModel, vault, priceBook);
    const learning = new LearningService({
      runs,
      bandit,
      judge: new RunJudge({ provider, model: judgeModel, priceBook }),
      reflector,
      synthesizer,
      config: config.learning,
      budget: spend,
      logger: logger.child({ component: 'learning' }),
    });
    const domains = await DomainRegistry.load({
      statePath: path.join(config.resolved.state, 'domains.json'),
      seed: await loadDomainSeed(config.resolved.domainsFile),
      environment: config.domains.environment,
      failFastAfter: config.domains.failFastAfter,
      failFastMs: config.domains.failFastHours * 3_600_000,
    });
    const http = new PoliteHttpClient({
      userAgent: config.scrapers.userAgent,
      fetch: opts.fetch,
      logger: logger.child({ component: 'http' }),
      allowPrivateNetwork: config.tools.allowPrivateNetwork,
      observe: (url, outcome) => domains.record(url, outcome),
    });
    const runner = new ScraperRunner(http, config.resolved.data, logger.child({ component: 'scraper' }));
    const scrapers = new ScraperRegistry(runner, config.resolved.scrapers);
    await scrapers.reload([]);

    const rt = new HarnessRuntime(
      config,
      provider,
      spend,
      runs,
      bandit,
      vault,
      skills,
      synthesizer,
      reflector,
      learning,
      scrapers,
      http,
      domains,
      opts,
      logger,
    );
    rt.agents = await loadAgents(config.resolved.agents);
    if (!rt.agents.has('analyst')) rt.agents.set('analyst', FALLBACK_AGENT);
    if (!opts.disableSql && (await DuckDbSqlService.isAvailable())) rt.sql = new DuckDbSqlService();
    rt.dashboards = new DashboardService({
      dir: config.resolved.dashboards,
      datasetsDir: config.resolved.datasets,
      dataDir: config.resolved.data,
      workspaceDir: config.resolved.workspace,
      sql: rt.sql,
      logger: logger.child({ component: 'dashboards' }),
      publicUrl: config.dashboardEnv.publicUrl,
      maxBytes: Math.round(config.dashboards.maxMb * 1024 * 1024),
      defaultWorkspace: () => rt.workspaceFor(rt.agent('analyst')),
      describeDataset: (name) =>
        rt.scrapers.all().find((s) => (s.output.dataset ?? s.name) === name)?.description,
    });
    return rt;
  }

  // ----- components -----

  attachNotifier(n: Notifier): void {
    this.notifiers.push(n);
  }

  async notify(n: Notification): Promise<void> {
    await this.notifier.notify(n);
  }

  agent(name: string): AgentDefinition {
    const a = this.agents.get(name);
    if (!a) throw new Error(`Unknown agent "${name}". Available: ${[...this.agents.keys()].join(', ')}`);
    return a;
  }

  agentList(): Array<{ name: string; description: string }> {
    return [...this.agents.values()].map((a) => ({ name: a.name, description: a.description }));
  }

  workspaceFor(agent: AgentDefinition): Workspace {
    const r = this.config.resolved;
    const mounts: Mount[] = [
      { alias: '', dir: r.workspace, mode: 'rw' },
      { alias: 'datasets', dir: r.datasets, mode: 'ro' },
      // Published dashboards (build_dashboard writes them); agents read specs back from here.
      { alias: 'dashboards', dir: r.dashboards, mode: 'ro' },
    ];
    if (agent.knowledge !== 'none')
      mounts.push({ alias: 'knowledge', dir: r.knowledge, mode: agent.knowledge });
    if (agent.skills !== 'none') {
      mounts.push({ alias: 'skills', dir: r.skills, mode: agent.skills });
      // Learned skills only change through the approval flow, so agents always see them read-only.
      if (r.learnedSkills !== r.skills)
        mounts.push({ alias: 'learned-skills', dir: r.learnedSkills, mode: 'ro' });
    }
    if (agent.scrapers !== 'none') mounts.push({ alias: 'scrapers', dir: r.scrapers, mode: agent.scrapers });
    return new Workspace(mounts);
  }

  permissionsFor(source: RunTaskRequest['source'], approvals?: ApprovalGateway): PermissionManager {
    const p = this.config.permissions;
    const unattended = source === 'cron';
    return new PermissionManager(
      {
        mode: unattended ? p.cronMode : p.mode,
        bashAllow: [...DEFAULT_BASH_ALLOW, ...(unattended && !p.cronAllowExtra ? [] : p.bashAllowExtra)],
        bashDeny: [...DEFAULT_BASH_DENY, ...p.bashDenyExtra],
        askFallback: unattended ? 'deny' : p.askFallback,
        writeRequiresApproval: p.writeRequiresApproval,
      },
      approvals ?? (unattended ? denyAllGateway : undefined),
      this.logger.child({ component: 'permissions' }),
    );
  }

  get toolRuntime(): ToolRuntimeConfig {
    return {
      ...DEFAULT_TOOL_RUNTIME,
      bashPassEnv: this.config.tools.bashPassEnv,
      allowPrivateNetwork: this.config.tools.allowPrivateNetwork,
      postEditDiagnostics: this.config.tools.postEditDiagnostics,
      userAgent: this.config.scrapers.userAgent,
    };
  }

  private services(): ToolServices {
    const delegate: DelegateService = {
      agents: () => this.agentList(),
      run: async (agent: string, task: string, parent: ToolContext) => {
        const r = await this.runTask({
          task,
          agent,
          source: 'delegate',
          permissions: parent.permissions,
          depth: parent.depth + 1,
          requestedBy: `agent:${parent.agent}`,
        });
        return { runId: r.runId, outcome: r.outcome, finalText: r.finalText, costUsd: r.costUsd };
      },
    };
    return {
      knowledge: this.vault,
      skills: this.skills,
      delegate,
      sql: this.sql,
      domains: {
        failFast: (url) => this.domains.failFast(url),
        record: (url, outcome) => void this.domains.record(url, outcome),
        describe: (hosts) => this.domains.report(hosts),
      },
      dashboards: {
        build: async (spec, ctx) => {
          const r = await this.dashboards.build(spec, {
            runId: ctx.runId,
            workspace: ctx.workspace,
            source: 'agent',
          });
          const displayPath = `dashboards/${r.meta.slug}/index.html`;
          return { summary: DashboardService.summary(r, displayPath), displayPath };
        },
        profile: (src, ctx) => this.dashboards.profile(src, ctx),
      },
      scrapers: {
        list: () => this.scrapers.list(),
        run: (name, opts) => this.scrapers.run(name, opts),
        dryRunSpec: (yaml) => this.dryRunSpec(yaml),
      },
    };
  }

  async dryRunSpec(yaml: string): Promise<string> {
    let doc: unknown;
    try {
      doc = YAML.parse(yaml);
    } catch (err) {
      return `Invalid YAML: ${errorMessage(err)}`;
    }
    let spec;
    try {
      spec = parseScraperSpec(doc, 'spec file');
    } catch (err) {
      return errorMessage(err);
    }
    const runner = new ScraperRunner(this.http, this.config.resolved.data, this.logger);
    return formatScrapeReport(await runner.run({ ...spec, name: `${spec.name}` }, { dryRun: true }));
  }

  chooseProfile(
    agent: AgentDefinition,
    model: string,
    taskType: string,
    requested?: string,
  ): { profile: HarnessProfile; selectedBy: RunMeta['profileSelectedBy'] } {
    if (requested && requested !== 'auto')
      return { profile: resolveProfile(requested), selectedBy: 'request' };
    if (agent.profile && agent.profile !== 'auto')
      return { profile: resolveProfile(agent.profile), selectedBy: 'agent' };
    if (this.config.profiles.selection === 'bandit') {
      const { profileId } = this.bandit.select(
        ProfileBandit.contextKey(model, taskType),
        this.config.profiles.candidates,
      );
      return { profile: resolveProfile(profileId), selectedBy: 'bandit' };
    }
    return { profile: resolveProfile(this.config.profiles.default), selectedBy: 'default' };
  }

  private environmentBlock(workspace: Workspace): string {
    const about: Record<string, string> = {
      datasets: 'scraper outputs as JSONL, one folder per dataset',
      dashboards: 'published dashboards, one folder per slug (spec.json is the spec that built it)',
      knowledge: 'the knowledge vault (wiki/<topic>/<article>.md)',
      skills: 'the skills library',
      'learned-skills': 'skills the harness learned and a human approved',
      scrapers: 'scraper specs (YAML)',
    };
    const mounts = workspace.allMounts
      .filter((m) => m.alias)
      .map(
        (m) =>
          `- ${m.alias}/ (${m.mode === 'ro' ? 'read-only' : 'read-write'}): ${about[m.alias] ?? m.alias}`,
      );
    return `# Environment\n\nToday is ${new Date().toISOString().slice(0, 10)} (UTC). Your working directory is the workspace root (read-write). Other folders are mounted under these prefixes:\n${mounts.join('\n')}`;
  }

  async runTask(req: RunTaskRequest): Promise<RunResult> {
    const agent = this.agent(req.agent ?? 'analyst');
    const model = agent.model ?? this.config.models.default;
    const taskType = classifyTask(req.task);
    const { profile, selectedBy } = this.chooseProfile(agent, model, taskType, req.profile);
    const runId = newId('run');
    const controller = new AbortController();
    this.active.set(runId, controller);
    const workspace = this.workspaceFor(agent);
    const permissions = req.permissions ?? this.permissionsFor(req.source, req.approvals);
    const extras: string[] = [this.environmentBlock(workspace)];
    if (agent.skills !== 'none') extras.push(this.skills.indexBlock(agent.skillFilter));
    if (agent.knowledge !== 'none') {
      extras.push(
        '# Knowledge vault\n\nThe vault under knowledge/ covers web scraping end to end (HTTP, parsing, crawling, APIs, legal and ethical rules, storage, operations, source playbooks). Use search_knowledge before designing or repairing a scraper and cite the articles you relied on.',
      );
      try {
        const lessons = await this.reflector.relevantLessons(req.task);
        if (lessons) extras.push(lessons);
      } catch (err) {
        this.logger.warn('lesson retrieval failed', { err });
      }
    }
    const recorder = this.runs.recorder(runId);
    this.logger.info('run starting', {
      runId,
      agent: agent.name,
      model,
      profile: profile.id,
      selectedBy,
      taskType,
      source: req.source,
    });
    let result: RunResult;
    try {
      result = await runAgent({
        runId,
        task: req.task,
        agent,
        profile,
        model,
        effort: agent.effort ?? this.config.models.effort,
        provider: this.provider,
        registry: this.registry,
        workspace,
        permissions,
        services: this.services(),
        toolRuntime: this.toolRuntime,
        priceBook: this.priceBook,
        logger: this.logger,
        env: this.env,
        budget: this.spend,
        runBudgetUsd:
          agent.budgetUsd ?? (this.config.budgets.runUsd > 0 ? this.config.budgets.runUsd : undefined),
        onEvent: async (e) => {
          await recorder(e);
          await req.onEvent?.(e);
        },
        signal: controller.signal,
        depth: req.depth ?? 0,
        systemExtras: extras,
        storeFile: this.runs.storeFile(runId),
        maxTokensPerTurn: this.config.models.maxTokensPerTurn,
        summarizerModel: this.config.models.summarizer,
      });
    } finally {
      this.active.delete(runId);
      this.sql?.release(runId);
    }
    const meta: RunMeta = {
      result,
      taskType,
      source: req.source,
      requestedBy: req.requestedBy,
      profileSelectedBy: selectedBy,
    };
    await this.runs.finish(meta);
    this.logger.info('run finished', {
      runId,
      outcome: result.outcome,
      steps: result.steps,
      costUsd: result.costUsd,
    });
    if (this.config.learning.enabled && this.config.learning.immediate) {
      void this.learning.process(meta).catch((err) => this.logger.warn('learning failed', { err, runId }));
    }
    return result;
  }

  stop(runId: string): boolean {
    const c = this.active.get(runId);
    if (!c) return false;
    c.abort();
    return true;
  }

  get activeRuns(): string[] {
    return [...this.active.keys()];
  }

  // ----- scrapers and jobs -----

  async scheduledScrape(name: string): Promise<string> {
    const spec = this.scrapers.get(name);
    if (!spec) throw new Error(`unknown scraper ${name}`);
    const report = await this.scrapers.runReport(name);
    await this.reportScrape(spec.notify, report);
    const rebuilt = await this.afterScrape(name, report);
    return `${report.ok ? 'ok' : 'problem'}: ${report.new} new, ${report.changed} changed${rebuilt.length ? `; rebuilt ${rebuilt.join(', ')}` : ''}`;
  }

  /**
   * After a scrape that wrote records: rebuild the dashboards that read the dataset and, with
   * dashboards.autoExplore, create the dataset's explorer the first time. Failures are logged.
   */
  async afterScrape(name: string, report: ScrapeReport): Promise<string[]> {
    if (report.dryRun || !report.ok || report.written === 0) return [];
    const dataset = this.scrapers.get(name)?.output.dataset ?? name;
    try {
      const rebuilt = await this.dashboards.refreshFor([dataset]);
      const explorer = explorerSlug(dataset);
      if (
        this.config.dashboards.autoExplore &&
        !rebuilt.includes(explorer) &&
        !(await this.dashboards.get(explorer))
      ) {
        await this.dashboards.explore(dataset);
        rebuilt.push(explorer);
      }
      return rebuilt;
    } catch (err) {
      this.logger.warn('dashboard refresh after scrape failed', { scraper: name, err: errorMessage(err) });
      return [];
    }
  }

  async reportScrape(
    notify: { onNew: boolean; onFailure: boolean; alertAfterFailures: number },
    report: ScrapeReport,
  ): Promise<void> {
    if (!report.ok && notify.onFailure) {
      const n = report.consecutiveFailures;
      if (n === notify.alertAfterFailures || (n > notify.alertAfterFailures && n % 10 === 0)) {
        await this.notify({
          channel: 'alerts',
          title: `Scraper ${report.name} is failing (${n} in a row)`,
          body: formatScrapeReport(report),
          level: 'error',
        });
        if (this.config.scrapers.autoRepair && n === notify.alertAfterFailures) {
          void this.repairScraper(report.name, 'scheduler').catch((err) =>
            this.logger.warn('auto repair failed', { err }),
          );
        }
      }
    }
    if (report.ok && notify.onNew && report.new > 0) {
      const sample = report.sample
        .map((r) => `- ${String(r.title ?? r.name ?? r._key ?? '').slice(0, 150)}`)
        .join('\n');
      await this.notify({
        channel: 'reports',
        title: `${report.name}: ${report.new} new record${report.new === 1 ? '' : 's'}`,
        body: `${formatScrapeReport(report)}\n${sample}`,
        level: 'success',
      });
    }
  }

  async repairScraper(
    name: string,
    requestedBy: string,
    onEvent?: (e: AgentEvent) => Promise<void>,
  ): Promise<RunResult> {
    const state = await this.scrapers.state(name);
    const task = `The scraper "${name}" needs repair. Last error: ${state.lastError ?? 'unknown'}. Consecutive failures: ${state.consecutiveFailures}.
Its spec is scrapers/${name}.yaml (read-only for you).
1. Read the spec and search the knowledge vault for guidance relevant to the failure.
2. Fetch the source with web_fetch and work out what changed (layout, selectors, API shape, blocking, robots.txt).
3. Write a corrected spec to proposals/scrapers/${name}.yaml in your workspace and test it with run_scraper(spec_path=...).
4. Finish with: the root cause, the diff between the old and new spec, and the dry-run result. If the site now forbids or blocks automated access, say so and do not work around it.`;
    return this.runTask({
      task,
      agent: this.agents.has('scraper-engineer') ? 'scraper-engineer' : 'analyst',
      source: 'cron',
      requestedBy,
      onEvent,
    });
  }

  async applyScraperProposal(name: string): Promise<string> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error('invalid scraper name');
    const from = path.join(this.config.resolved.workspace, 'proposals', 'scrapers', `${name}.yaml`);
    const yaml = await fsp.readFile(from, 'utf8');
    const spec = parseScraperSpec(YAML.parse(yaml), from);
    if (spec.name !== name) throw new Error(`proposal names "${spec.name}", expected "${name}"`);
    await ensureDir(this.config.resolved.scrapers);
    await fsp.writeFile(path.join(this.config.resolved.scrapers, `${name}.yaml`), yaml, 'utf8');
    await this.scrapers.reload();
    this.registerScraperJobs();
    return `Applied proposals/scrapers/${name}.yaml to the live spec.`;
  }

  registerScraperJobs(): void {
    for (const spec of this.scrapers.all()) {
      const job = `scrape:${spec.name}`;
      if (this.scheduler.has(job)) this.scheduler.remove(job);
      if (!spec.enabled || !spec.schedule) continue;
      this.scheduler.add({
        name: job,
        cron: spec.schedule,
        timezone: spec.timezone,
        description: spec.description,
        run: () => this.scheduledScrape(spec.name),
      });
    }
  }

  registerSystemJobs(): void {
    if (this.config.learning.enabled && !this.scheduler.has('learning')) {
      this.scheduler.add({
        name: 'learning',
        cron: this.config.learning.schedule,
        description: 'Judge, reflect and update the profile bandit for unprocessed runs',
        run: async () => `processed ${await this.learning.processPending()} runs`,
      });
    }
    if (this.config.scrapers.digestEnabled && !this.scheduler.has('digest')) {
      this.scheduler.add({
        name: 'digest',
        cron: this.config.scrapers.digestSchedule,
        description: 'Daily digest of scraper results, runs and spend',
        run: async () => {
          const body = await this.digest();
          await this.notify({ channel: 'reports', title: 'Daily digest', body, level: 'info' });
          return 'sent';
        },
      });
    }
    const verify = this.config.vault.verify;
    if (verify.enabled && !this.scheduler.has('vault-verify')) {
      this.scheduler.add({
        name: 'vault-verify',
        cron: verify.schedule,
        description: 'Ground the top of the vault verification queue in fetched sources',
        run: async () => {
          const lines = await this.verifyVault(verify.articlesPerRun);
          if (lines.length) {
            const report = formatAccuracy(await this.vaultAccuracy(), 0);
            await this.notify({
              channel: 'reports',
              title: `Vault verification: ${lines.length} article${lines.length === 1 ? '' : 's'}`,
              body: `${lines.join('\n')}\n\n${report}`,
              level: 'info',
            });
          }
          return `${lines.length} articles`;
        },
      });
    }
    if (!this.scheduler.has('vault-lint')) {
      this.scheduler.add({
        name: 'vault-lint',
        cron: this.config.vault.lintSchedule,
        description: 'Lint the knowledge vault',
        run: async () => {
          const issues = await this.vault.lint();
          const errors = issues.filter((i) => i.severity === 'error');
          if (errors.length)
            await this.notify({
              channel: 'alerts',
              title: `Vault lint: ${errors.length} errors`,
              body: errors
                .slice(0, 30)
                .map((e) => `- ${e.file}: ${e.message}`)
                .join('\n'),
              level: 'warning',
            });
          return `${errors.length} errors, ${issues.length - errors.length} warnings`;
        },
      });
    }
  }

  // ----- vault accuracy -----

  async vaultAccuracy(today = new Date().toISOString().slice(0, 10)): Promise<AccuracyReport> {
    return accuracyReport(this.vault, {
      environment: this.domains.environment,
      answers: (host) => this.domains.answers(host),
      today,
      staleDays: this.config.vault.staleDays,
    });
  }

  /**
   * Ground the top of the verification queue: one librarian run per article whose cited
   * hosts are not all known to be unreachable from here. Returns one line per article.
   */
  async verifyVault(limit: number, requestedBy = 'vault-verify'): Promise<string[]> {
    const today = new Date().toISOString().slice(0, 10);
    const report = await this.vaultAccuracy(today);
    const picks = report.articles
      .filter((a) => !a.grounded && a.citedHosts.length > a.unreachableHosts.length)
      .slice(0, limit);
    const agent = this.agents.has('librarian') ? 'librarian' : 'analyst';
    const lines: string[] = [];
    for (const a of picks) {
      const r = await this.runTask({ task: verificationTask(a, today), agent, source: 'cron', requestedBy });
      lines.push(`- ${a.path}: ${r.outcome} (run ${r.runId}, ${formatUsd(r.costUsd)})`);
    }
    return lines;
  }

  async digest(): Promise<string> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const lines: string[] = ['**Scrapers (last 24h)**'];
    for (const spec of this.scrapers.all()) {
      const st = await this.scrapers.state(spec.name);
      const recent = st.history.filter((h) => Date.parse(h.at) >= since);
      if (!recent.length && !spec.enabled) continue;
      const newCount = recent.reduce((n, h) => n + h.new, 0);
      const failed = recent.filter((h) => !h.ok).length;
      lines.push(
        `- ${spec.name}: ${recent.length} runs, ${newCount} new records${failed ? `, ${failed} failed` : ''}${st.consecutiveFailures ? ` (failing ${st.consecutiveFailures} in a row)` : ''}`,
      );
    }
    const runs = (await this.runs.list(200)).filter((r) => Date.parse(String(r.endedAt ?? 0)) >= since);
    lines.push(
      '',
      `**Agent runs**: ${runs.length} (${runs.filter((r) => r.outcome === 'completed').length} completed)`,
    );
    lines.push(
      `**Spend today**: ${formatUsd(this.spend.today)}${this.spend.dailyCapUsd ? ` of ${formatUsd(this.spend.dailyCapUsd)}` : ''}`,
    );
    return lines.join('\n');
  }

  // ----- operations for the Discord bot -----

  private dashboardInfo(m: DashboardMeta): DashboardInfo {
    return {
      slug: m.slug,
      title: m.title,
      description: m.description,
      builtAt: m.builtAt,
      url: this.dashboards.url(m.slug),
      bytes: m.bytes,
      rows: m.datasets.reduce((n, d) => n + d.rows, 0),
    };
  }

  /** The dashboard plus its HTML when small enough for a Discord attachment. */
  private async dashboardWithHtml(m: DashboardMeta): Promise<DashboardInfo & { html?: string }> {
    const info = this.dashboardInfo(m);
    if (m.bytes > DISCORD_ATTACHMENT_BYTES) return info;
    const file = this.dashboards.filePath(m.slug);
    const html = file ? await fsp.readFile(file, 'utf8').catch(() => undefined) : undefined;
    return { ...info, html };
  }

  ops(): HarnessOps {
    return {
      ask: (task, o) =>
        this.runTask({
          task,
          agent: o.agent,
          profile: o.profile,
          source: 'discord',
          requestedBy: o.requestedBy,
          approvals: o.approvals,
          onEvent: o.onEvent,
        }),
      listScrapers: () => this.scrapers.list(),
      runScraper: async (name, dryRun) => {
        const spec = this.scrapers.get(name);
        if (!spec) throw new Error(`unknown scraper ${name}`);
        const report = await this.scrapers.runReport(name, { dryRun });
        if (!dryRun) {
          await this.reportScrape({ ...spec.notify, onNew: false }, report);
          await this.afterScrape(name, report);
        }
        return report;
      },
      scraperStatus: async (name) => {
        const spec = this.scrapers.get(name);
        if (!spec) return `No scraper named ${name}.`;
        const st = await this.scrapers.state(name);
        const hist = st.history
          .slice(-5)
          .map(
            (h) =>
              `${h.at.slice(0, 16)} ${h.ok ? 'ok' : 'FAIL'} fetched=${h.fetched} new=${h.new} changed=${h.changed} invalid=${h.invalid}`,
          );
        return [
          `**${name}** (${spec.source.type}, ${spec.schedule ?? 'no schedule'}, ${spec.enabled ? 'enabled' : 'disabled'})`,
          spec.description,
          `last success: ${st.lastSuccessAt ?? 'never'}; consecutive failures: ${st.consecutiveFailures}`,
          st.lastError ? `last error: ${st.lastError}` : '',
          hist.length ? '```\n' + hist.join('\n') + '\n```' : '',
        ]
          .filter(Boolean)
          .join('\n');
      },
      repairScraper: (name, by, onEvent) => this.repairScraper(name, by, onEvent),
      applyScraper: (name) => this.applyScraperProposal(name),
      jobs: () => this.scheduler.list(),
      runs: (limit) => this.runs.list(limit),
      run: (id) => this.runs.getMeta(id).catch(() => undefined),
      stop: (id) => this.stop(id),
      feedback: async (id, value, by) =>
        !!(await this.learning.feedback(id, value, by).catch(() => undefined)),
      budget: () => ({
        todayUsd: this.spend.today,
        capUsd: this.spend.dailyCapUsd,
        history: this.spend.history(7),
      }),
      skills: () => this.skills.list(),
      proposedSkills: async () =>
        (await this.synthesizer.list()).map((p) => ({
          name: p.name,
          description: p.description,
          runId: p.runId,
        })),
      approveSkill: async (name) => {
        await this.synthesizer.approve(name);
        await this.skills.reload();
      },
      rejectSkill: (name) => this.synthesizer.reject(name),
      searchKnowledge: (q, topic) => this.vault.search(q, { limit: 5, topic }),
      learn: () => this.learning.processPending(),
      profiles: (taskType) =>
        this.bandit.summary().filter((r) => !taskType || r.context.endsWith(`|${taskType}`)),
      status: () => ({
        uptime: `${Math.round((Date.now() - this.startedAt.getTime()) / 60000)} min`,
        provider: this.provider.name,
        model: this.config.models.default,
        'active runs': this.active.size,
        scrapers: this.scrapers.all().length,
        jobs: this.scheduler.list().length,
        skills: this.skills.list().length,
        'spend today': formatUsd(this.spend.today),
      }),
      dashboards: async () => (await this.dashboards.list()).map((m) => this.dashboardInfo(m)),
      dashboard: async (slug) => {
        const m = await this.dashboards.get(slug);
        return m ? this.dashboardWithHtml(m) : undefined;
      },
      exploreDataset: async (dataset) => {
        const r = await this.dashboards.explore(dataset);
        return { ...(await this.dashboardWithHtml(r.meta)), warnings: r.meta.warnings };
      },
    };
  }

  async shutdown(): Promise<void> {
    this.scheduler.stop();
    for (const c of this.active.values()) c.abort();
    await this.spend.flush();
    await this.bandit.flush();
    await this.domains.flush();
  }
}
