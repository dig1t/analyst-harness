import type { AgentEvent, RunResult } from '../core/agent-loop';
import type { RunMeta } from '../learning/run-store';
import type { ScrapeReport } from '../scrapers/runner';
import { formatScrapeReport } from '../scrapers/runner';
import type { JobStatus } from '../scheduler/scheduler';
import type { ApprovalGateway } from '../safety/permissions';
import type { KnowledgeSearchHit } from '../tools/types';
import { errorMessage } from '../util/errors';
import { formatUsd } from '../util/text';
import { isAuthorized, isAdmin, type AuthPolicy, type DiscordUser } from './auth';
import { helpText, isAdminCommand } from './commands';
import { codeTable, fitMessage, formatRunResult, ProgressTracker, type CommandReply } from './format';

export interface Invocation {
  command: string;
  subcommand?: string;
  options: Record<string, string | number | boolean | undefined>;
  user: DiscordUser;
  channelId?: string;
}

export interface Responder {
  /** Acknowledge now; the final answer follows (Discord requires a reply within 3 seconds). */
  defer(ephemeral?: boolean): Promise<void>;
  progress(text: string): Promise<void>;
  finish(reply: CommandReply): Promise<void>;
}

/** The operations the bot exposes; implemented by the harness runtime, faked in tests. */
export interface HarnessOps {
  ask(
    task: string,
    opts: {
      agent?: string;
      profile?: string;
      requestedBy: string;
      onEvent?: (e: AgentEvent) => Promise<void>;
      approvals?: ApprovalGateway;
      source: string;
    },
  ): Promise<RunResult>;
  listScrapers(): Array<{ name: string; description: string; schedule?: string; enabled: boolean }>;
  runScraper(name: string, dryRun: boolean): Promise<ScrapeReport>;
  scraperStatus(name: string): Promise<string>;
  repairScraper(
    name: string,
    requestedBy: string,
    onEvent?: (e: AgentEvent) => Promise<void>,
  ): Promise<RunResult>;
  applyScraper(name: string): Promise<string>;
  jobs(): JobStatus[];
  runs(limit: number): Promise<Array<Record<string, unknown>>>;
  run(id: string): Promise<RunMeta | undefined>;
  stop(id: string): boolean;
  feedback(id: string, value: 'up' | 'down', by: string): Promise<boolean>;
  budget(): { todayUsd: number; capUsd: number; history: Array<{ date: string; usd: number }> };
  skills(): Array<{ name: string; description: string }>;
  proposedSkills(): Promise<Array<{ name: string; description: string; runId: string }>>;
  approveSkill(name: string): Promise<void>;
  rejectSkill(name: string): Promise<void>;
  searchKnowledge(query: string, topic?: string): Promise<KnowledgeSearchHit[]>;
  learn(): Promise<number>;
  profiles(
    taskType?: string,
  ): Array<{ context: string; profileId: string; mean: number; pulls: number; avgCostUsd: number }>;
  status(): Record<string, string | number>;
}

export interface RouterOptions {
  /** Builds an approval gateway bound to the invoking channel, if the transport supports buttons. */
  approvalsFor?: (inv: Invocation) => ApprovalGateway | undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Transport-independent command handling: slash commands and prefix messages both become an
 * Invocation, and every answer goes through a Responder. This keeps the Discord adapter thin
 * and lets the whole command surface be unit tested.
 */
export class CommandRouter {
  constructor(
    private readonly ops: HarnessOps,
    private readonly auth: AuthPolicy,
    private readonly options: RouterOptions = {},
  ) {}

  async dispatch(inv: Invocation, responder: Responder): Promise<void> {
    if (inv.command === 'help') return responder.finish({ content: helpText(), ephemeral: true });
    if (!isAuthorized(inv.user, this.auth)) {
      return responder.finish({
        content:
          'You are not authorized to use this bot. Ask the operator to add your user id or role to the allow-list.',
        ephemeral: true,
      });
    }
    if (isAdminCommand(inv.command, inv.subcommand) && !isAdmin(inv.user, this.auth)) {
      return responder.finish({ content: 'That command is restricted to admins.', ephemeral: true });
    }
    try {
      await this.handle(inv, responder);
    } catch (err) {
      await responder.finish({ content: `Error: ${errorMessage(err)}`, ephemeral: true });
    }
  }

  private async handle(inv: Invocation, r: Responder): Promise<void> {
    const o = inv.options;
    const who = inv.user.name ?? inv.user.id;
    switch (inv.command) {
      case 'ask': {
        const task = str(o.task);
        if (!task) return r.finish({ content: 'Usage: /ask task:<what to do>', ephemeral: true });
        await r.defer();
        const tracker = new ProgressTracker((text) => r.progress(text));
        const result = await this.ops.ask(task, {
          agent: str(o.agent),
          profile: str(o.profile),
          requestedBy: who,
          onEvent: (e) => tracker.onEvent(e),
          approvals: this.options.approvalsFor?.(inv),
          source: 'discord',
        });
        return r.finish(formatRunResult(result));
      }
      case 'scrape':
        return this.scrape(inv, r);
      case 'jobs': {
        const jobs = this.ops.jobs();
        const rows = [
          ['job', 'cron', 'next run (UTC)', 'last'],
          ...jobs.map((j) => [
            j.name,
            j.cron,
            j.nextRun?.slice(0, 16).replace('T', ' ') ?? '-',
            j.running ? 'running' : (j.lastStatus ?? '-'),
          ]),
        ];
        return r.finish({ content: jobs.length ? codeTable(rows) : 'No scheduled jobs.' });
      }
      case 'runs': {
        const limit = typeof o.limit === 'number' ? Math.min(25, Math.max(1, o.limit)) : 10;
        const rows = await this.ops.runs(limit);
        const table = [
          ['run', 'agent', 'outcome', 'cost', 'task'],
          ...rows.map((x) => [
            String(x.runId),
            String(x.agent ?? ''),
            String(x.outcome ?? ''),
            formatUsd(Number(x.costUsd ?? 0)),
            String(x.task ?? '').slice(0, 30),
          ]),
        ];
        return r.finish({ content: rows.length ? codeTable(table) : 'No runs yet.' });
      }
      case 'run': {
        const meta = await this.ops.run(String(o.id ?? ''));
        if (!meta) return r.finish({ content: `No run ${o.id}.`, ephemeral: true });
        const extra = [
          `task type: ${meta.taskType}; profile chosen by: ${meta.profileSelectedBy}`,
          meta.phases ? `phases: ${meta.phases}` : '',
          meta.judge
            ? `judge: ${meta.judge.verdict} (${meta.judge.score.toFixed(2)})${meta.judge.failureStage ? `, earliest failure: ${meta.judge.failureStage}` : ''}. ${meta.judge.reason}`
            : 'not judged yet',
          meta.learned?.lessons.length ? `lessons: ${meta.learned.lessons.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join('\n');
        const base = formatRunResult(meta.result);
        return r.finish({
          ...fitMessage(
            base.content.split('\n\n')[0]!,
            `${extra}\n\n${meta.result.finalText}`,
            `${meta.result.runId}.md`,
          ),
        });
      }
      case 'stop':
        return r.finish({
          content: this.ops.stop(String(o.id ?? ''))
            ? `Stopping run ${o.id}.`
            : `Run ${o.id} is not running.`,
        });
      case 'feedback': {
        const value = o.value === 'down' ? 'down' : 'up';
        const ok = await this.ops.feedback(String(o.id ?? ''), value, who);
        return r.finish({
          content: ok
            ? `Thanks: recorded ${value === 'up' ? 'good' : 'bad'} for run ${o.id}. The profile bandit was updated.`
            : `No run ${o.id}.`,
          ephemeral: true,
        });
      }
      case 'budget': {
        const b = this.ops.budget();
        const hist = b.history.map((h) => `${h.date}: ${formatUsd(h.usd)}`).join('\n');
        return r.finish({
          content: `Today: ${formatUsd(b.todayUsd)} of ${b.capUsd > 0 ? formatUsd(b.capUsd) : 'no cap'}\n${hist ? '```\n' + hist + '\n```' : ''}`,
        });
      }
      case 'skills':
        return this.skills(inv, r);
      case 'knowledge':
      case 'lessons': {
        const query = str(o.query) ?? (inv.command === 'lessons' ? 'lesson' : '');
        if (!query) return r.finish({ content: 'Usage: /knowledge query:<terms>', ephemeral: true });
        const hits = await this.ops.searchKnowledge(
          query,
          inv.command === 'lessons' ? 'lessons' : str(o.topic),
        );
        if (!hits.length) return r.finish({ content: `Nothing found for "${query}".` });
        return r.finish(
          fitMessage(
            `**Vault results for** "${query}"`,
            hits.map((h, i) => `${i + 1}. **${h.title}** \`${h.path}\`\n${h.snippet}`).join('\n'),
            'knowledge.md',
          ),
        );
      }
      case 'learn': {
        await r.defer();
        const n = await this.ops.learn();
        return r.finish({ content: `Learning loop processed ${n} run${n === 1 ? '' : 's'}.` });
      }
      case 'profiles': {
        const rows = this.ops.profiles(str(o.task_type));
        if (!rows.length) return r.finish({ content: 'The profile bandit has no data yet.' });
        const table = [
          ['context', 'profile', 'success', 'runs', 'avg cost'],
          ...rows.map((x) => [
            x.context,
            x.profileId,
            x.mean.toFixed(2),
            String(x.pulls),
            formatUsd(x.avgCostUsd),
          ]),
        ];
        return r.finish(fitMessage('**Profile bandit**', codeTable(table), 'profiles.md'));
      }
      case 'status': {
        const s = this.ops.status();
        return r.finish({
          content: Object.entries(s)
            .map(([k, v]) => `**${k}**: ${v}`)
            .join('\n'),
        });
      }
      default:
        return r.finish({ content: `Unknown command ${inv.command}. Try /help.`, ephemeral: true });
    }
  }

  private async scrape(inv: Invocation, r: Responder): Promise<void> {
    const name = str(inv.options.name);
    switch (inv.subcommand) {
      case 'list': {
        const list = this.ops.listScrapers();
        const rows = [
          ['scraper', 'schedule', 'enabled', 'description'],
          ...list.map((s) => [
            s.name,
            s.schedule ?? '-',
            s.enabled ? 'yes' : 'no',
            s.description.slice(0, 40),
          ]),
        ];
        return r.finish({ content: list.length ? codeTable(rows) : 'No scrapers registered.' });
      }
      case 'run': {
        if (!name) return r.finish({ content: 'Usage: /scrape run name:<scraper>', ephemeral: true });
        await r.defer();
        const report = await this.ops.runScraper(name, inv.options.dry_run === true);
        return r.finish({ content: formatScrapeReport(report) });
      }
      case 'status':
        if (!name) return r.finish({ content: 'Usage: /scrape status name:<scraper>', ephemeral: true });
        return r.finish({ content: await this.ops.scraperStatus(name) });
      case 'repair': {
        if (!name) return r.finish({ content: 'Usage: /scrape repair name:<scraper>', ephemeral: true });
        await r.defer();
        const tracker = new ProgressTracker((text) => r.progress(text));
        const result = await this.ops.repairScraper(name, inv.user.name ?? inv.user.id, (e) =>
          tracker.onEvent(e),
        );
        return r.finish(formatRunResult(result));
      }
      case 'apply':
        if (!name) return r.finish({ content: 'Usage: /scrape apply name:<scraper>', ephemeral: true });
        return r.finish({ content: await this.ops.applyScraper(name) });
      default:
        return r.finish({ content: 'Usage: /scrape list | run | status | repair | apply', ephemeral: true });
    }
  }

  private async skills(inv: Invocation, r: Responder): Promise<void> {
    const name = str(inv.options.name);
    switch (inv.subcommand) {
      case 'list': {
        const list = this.ops.skills();
        return r.finish(
          fitMessage(
            `**${list.length} skills**`,
            list.map((s) => `- **${s.name}**: ${s.description.slice(0, 150)}`).join('\n'),
            'skills.md',
          ),
        );
      }
      case 'proposed': {
        const list = await this.ops.proposedSkills();
        if (!list.length) return r.finish({ content: 'No skill proposals waiting.' });
        return r.finish(
          fitMessage(
            '**Proposed skills**',
            list.map((s) => `- **${s.name}** (from run ${s.runId}): ${s.description}`).join('\n'),
            'proposed-skills.md',
          ),
        );
      }
      case 'approve':
        if (!name) return r.finish({ content: 'Usage: /skills approve name:<skill>', ephemeral: true });
        await this.ops.approveSkill(name);
        return r.finish({ content: `Approved skill ${name}. It is now active for every agent.` });
      case 'reject':
        if (!name) return r.finish({ content: 'Usage: /skills reject name:<skill>', ephemeral: true });
        await this.ops.rejectSkill(name);
        return r.finish({ content: `Rejected and removed proposal ${name}.` });
      default:
        return r.finish({ content: 'Usage: /skills list | proposed | approve | reject', ephemeral: true });
    }
  }
}

/** Parse a prefix message such as `!ask how many rows` or `!scrape run hn-top-stories`. */
export function parsePrefixCommand(
  content: string,
  prefix = '!',
): Omit<Invocation, 'user' | 'channelId'> | undefined {
  if (!content.startsWith(prefix)) return undefined;
  const [command, ...rest] = content.slice(prefix.length).trim().split(/\s+/);
  if (!command) return undefined;
  const text = rest.join(' ');
  switch (command) {
    case 'ask':
      return { command, options: { task: text } };
    case 'knowledge':
      return { command, options: { query: text } };
    case 'lessons':
      return { command, options: { query: text || undefined } };
    case 'scrape':
    case 'skills':
      return {
        command,
        subcommand: rest[0],
        options: { name: rest[1], dry_run: rest.includes('--dry-run') },
      };
    case 'run':
    case 'stop':
      return { command, options: { id: rest[0] } };
    case 'feedback':
      return {
        command,
        options: { id: rest[0], value: rest[1] === 'bad' || rest[1] === 'down' ? 'down' : 'up' },
      };
    case 'runs':
      return { command, options: { limit: rest[0] ? Number(rest[0]) : undefined } };
    default:
      return { command, options: {} };
  }
}
