#!/usr/bin/env node
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { daemonStatus, sessionContext, startDaemon, stopDaemon, tailLog } from './app/daemon';
import { HarnessRuntime } from './app/runtime';
import { main } from './index';
import { loadDotEnv } from './config/dotenv';
import { loadConfig } from './config/load';
import type { HarnessConfig } from './config/schema';
import type { AgentEvent } from './core/agent-loop';
import { loadUiAssets } from './dashboards/assets';
import { checkVaultLinks, formatAccuracy } from './knowledge/accuracy';
import { claudeCodeLogin } from './llm/claude-code';
import { DashboardService } from './dashboards/service';
import { formatDomainSeed, isTrackableHost } from './net/domains';
import { probeUrl } from './net/probe';
import { sandboxExec } from './sandbox/client';
import { toDiscordJson } from './discord/commands';
import { DiscordApprovalGateway } from './discord/approvals';
import type { ApprovalGateway } from './safety/permissions';
import { DuckDbSqlService } from './tools/sql-engine';
import { formatScrapeReport } from './scrapers/runner';
import { mapConcurrent } from './util/concurrency';
import { writeTextAtomic } from './util/fs';
import { errorMessage } from './util/errors';
import { formatUsd } from './util/text';

export const USAGE = `analyst-harness CLI

Usage: harness <command> [options]

  run "<task>" [--agent analyst] [--profile <id>|auto] [--yes]   Run an agent task in the terminal
  serve                                                           Start the scheduler and the Discord bot
  scrape <name> [--dry-run] | scrape --all [--notify]             Run scrapers now
  scrapers                                                        List scrapers
  jobs                                                            List scheduled jobs
  runs [--limit 20]                                               Recent runs
  learn                                                           Process unlearned runs (judge, reflect, bandit)
  profiles                                                        Show what the profile bandit learned
  skills [list|proposed|approve <name>|reject <name>]             Manage skills
  vault lint [--strict] | vault index | vault search "<query>"    Knowledge vault tools
  vault status | vault queue [--limit 30] | vault links | vault verify [--limit 1]
                                                                  Vault accuracy: grounding, queue, dead links
  dashboard build <spec.yaml> | dashboard list | dashboard remove <slug>
                                                                  Build and manage dashboards
  explore <dataset>                                               Build the explorer dashboard for a dataset
  domains [host...] | domains check <host...> [--vault] [--scrapers] [--save]
                                                                  Which hosts answer from this environment
  discord commands                                                Print the slash command JSON
  daemon start|stop|restart|status|logs|ensure [--hook]           Keep the harness running in the background
  doctor                                                          Check configuration and dependencies
`;

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIO: CliIO = {
  out: (l) => process.stdout.write(l + '\n'),
  err: (l) => process.stderr.write(l + '\n'),
};

export function printEvent(e: AgentEvent, io: CliIO): void {
  switch (e.type) {
    case 'run_start':
      io.err(`> run ${e.runId} | agent ${e.agent} | ${e.model} | profile ${e.profile}`);
      break;
    case 'llm_response':
      for (const p of e.progress) io.err(`  . ${p}`);
      for (const c of e.toolCalls) io.err(`  [${e.step}] ${c.name} ${JSON.stringify(c.input).slice(0, 160)}`);
      break;
    case 'tool_result':
      if (e.isError) io.err(`      ! ${e.preview.split('\n')[0]?.slice(0, 200)}`);
      break;
    case 'context':
      io.err(`  ~ context ${e.event.action}: ${e.event.tokensBefore} -> ${e.event.tokensAfter} tokens`);
      break;
    case 'plan':
      io.err(`  plan ${e.done}/${e.total}`);
      break;
    case 'stuck':
      io.err(`  ! stuck detector: ${e.kind} (${e.tool} x${e.count})`);
      break;
    default:
      break;
  }
}

export function terminalApprovals(yes: boolean): ApprovalGateway | undefined {
  if (yes) return { request: async () => true };
  if (!process.stdin.isTTY) return undefined;
  return {
    async request(req, ctx) {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const answer = await rl.question(
          `${DiscordApprovalGateway.describe(req, ctx).replace(/\*\*/g, '')}\nApprove? [y/N] `,
        );
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    },
  };
}

/** `harness daemon ...`: runs without the full runtime, so it is quick enough for a session hook. */
async function daemonCommand(
  sub: string | undefined,
  values: { hook?: boolean; lines?: string },
  config: HarnessConfig,
  io: CliIO,
): Promise<number> {
  const opts = {
    root: config.root,
    dataDir: config.resolved.data,
    port: Number(process.env.PORT ?? 8080),
    host: process.env.HOST || '127.0.0.1',
  };
  const where = { root: config.root, dataDir: config.resolved.data };
  switch (sub) {
    case 'ensure':
    case 'start':
    case 'restart': {
      try {
        // Restart after editing .env or rebuilding; it stops only a harness this manager started.
        if (sub === 'restart') await stopDaemon(opts);
        const status = await startDaemon(opts);
        io.out(
          values.hook
            ? sessionContext(status, where)
            : `analyst-harness is running at ${status.url} (pid ${status.pid ?? 'unknown'}); logs: ${status.logFile}`,
        );
        return 0;
      } catch (err) {
        const message = errorMessage(err);
        if (values.hook) {
          // A session hook must never fail the session: report the problem as context instead.
          io.out(sessionContext(await daemonStatus(opts), where, message));
          return 0;
        }
        io.err(`could not start the harness: ${message}`);
        return 1;
      }
    }
    case 'stop':
      io.out(
        (await stopDaemon(opts))
          ? 'stopped analyst-harness'
          : 'analyst-harness was not running (or was not started by `harness daemon`)',
      );
      return 0;
    case 'status': {
      const s = await daemonStatus(opts);
      io.out(
        s.running
          ? `running at ${s.url}${s.pid ? ` (pid ${s.pid}, since ${s.startedAt})` : ' (started outside `harness daemon`)'}; logs: ${s.logFile}`
          : `not running; start it with \`harness daemon start\`; logs: ${s.logFile}`,
      );
      return s.running ? 0 : 3;
    }
    case 'logs':
      io.out((await tailLog(config.resolved.data, Number(values.lines ?? 60))) || '(no log yet)');
      return 0;
    default:
      io.err('Usage: harness daemon start|stop|restart|status|logs|ensure [--hook]');
      return 2;
  }
}

export async function runCli(argv: string[], io: CliIO = defaultIO): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'discord' && rest[0] === 'commands') {
    io.out(JSON.stringify(toDiscordJson(), null, 2));
    return 0;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      agent: { type: 'string' },
      profile: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      all: { type: 'boolean' },
      notify: { type: 'boolean' },
      limit: { type: 'string' },
      strict: { type: 'boolean' },
      vault: { type: 'boolean' },
      hook: { type: 'boolean' },
      lines: { type: 'string' },
      scrapers: { type: 'boolean' },
      save: { type: 'boolean' },
    },
  });
  loadDotEnv(process.env.HARNESS_ROOT ?? process.cwd());
  const config = await loadConfig();
  if (command === 'serve') {
    await main();
    return 0;
  }
  if (command === 'daemon') return daemonCommand(positionals[0], values, config, io);
  const rt = await HarnessRuntime.create({ config, env: process.env });
  try {
    switch (command) {
      case 'run': {
        const task = positionals.join(' ').trim();
        if (!task) {
          io.err('Usage: harness run "<task>"');
          return 2;
        }
        const result = await rt.runTask({
          task,
          agent: values.agent,
          profile: values.profile,
          source: 'cli',
          approvals: terminalApprovals(values.yes === true),
          onEvent: (e) => printEvent(e, io),
        });
        io.out(result.finalText || '(no answer)');
        io.err(
          `\n${result.outcome} | ${result.steps} steps | ${result.toolCalls} tool calls | ${formatUsd(result.costUsd)} | run ${result.runId}`,
        );
        return result.outcome === 'completed' ? 0 : 1;
      }
      case 'scrape': {
        const names = values.all
          ? rt.scrapers
              .all()
              .filter((s) => s.enabled)
              .map((s) => s.name)
          : positionals;
        if (!names.length) {
          io.err('Usage: harness scrape <name> [--dry-run] | --all [--notify]');
          return 2;
        }
        let failed = 0;
        for (const name of names) {
          const dryRun = values['dry-run'] === true;
          const report = await rt.scrapers.runReport(name, { dryRun });
          io.out(formatScrapeReport(report));
          // --notify applies the spec's alert rules, so a CI cron reports like the server would.
          const spec = rt.scrapers.get(name);
          if (values.notify && !dryRun && spec) await rt.reportScrape(spec.notify, report);
          if (!report.ok) failed++;
        }
        return failed ? 1 : 0;
      }
      case 'scrapers':
        for (const s of rt.scrapers.list())
          io.out(
            `${s.name.padEnd(28)} ${(s.schedule ?? '-').padEnd(16)} ${s.enabled ? 'enabled ' : 'disabled'} ${s.description}`,
          );
        return 0;
      case 'jobs':
        rt.registerScraperJobs();
        rt.registerSystemJobs();
        for (const j of rt.scheduler.list())
          io.out(`${j.name.padEnd(32)} ${j.cron.padEnd(16)} ${j.description}`);
        return 0;
      case 'runs':
        for (const r of await rt.runs.list(Number(values.limit ?? 20)))
          io.out(
            `${r.runId}  ${String(r.outcome).padEnd(16)} ${formatUsd(Number(r.costUsd ?? 0)).padStart(8)}  ${String(r.task ?? '').slice(0, 60)}`,
          );
        return 0;
      case 'learn':
        io.out(`processed ${await rt.learning.processPending()} runs`);
        return 0;
      case 'profiles':
        for (const p of rt.bandit.summary())
          io.out(
            `${p.context.padEnd(36)} ${p.profileId.padEnd(24)} success=${p.mean.toFixed(2)} runs=${p.pulls} avg=${formatUsd(p.avgCostUsd)}`,
          );
        return 0;
      case 'skills': {
        const sub = positionals[0] ?? 'list';
        if (sub === 'list')
          for (const s of rt.skills.list()) io.out(`${s.name}: ${s.description.slice(0, 120)}`);
        else if (sub === 'proposed')
          for (const p of await rt.synthesizer.list()) io.out(`${p.name} (run ${p.runId}): ${p.description}`);
        else if (sub === 'approve' && positionals[1])
          io.out(`approved: ${await rt.synthesizer.approve(positionals[1])}`);
        else if (sub === 'reject' && positionals[1]) {
          await rt.synthesizer.reject(positionals[1]);
          io.out('rejected');
        } else {
          io.err('Usage: harness skills [list|proposed|approve <name>|reject <name>]');
          return 2;
        }
        for (const i of rt.skills.issues) io.err(`skipped ${i.file}: ${i.message}`);
        return 0;
      }
      case 'vault': {
        const sub = positionals[0];
        if (sub === 'lint') {
          const issues = await rt.vault.lint();
          for (const i of issues) io.out(`${i.severity.toUpperCase().padEnd(7)} ${i.file}: ${i.message}`);
          const errors = issues.filter((i) => i.severity === 'error').length;
          const articles = (await rt.vault.articles()).length;
          io.err(`${articles} articles, ${errors} errors, ${issues.length - errors} warnings`);
          return errors > 0 || (values.strict && issues.length > 0) ? 1 : 0;
        }
        if (sub === 'index') {
          await rt.vault.writeIndex();
          io.out('wrote wiki/index.md');
          return 0;
        }
        if (sub === 'search') {
          for (const h of await rt.vault.search(positionals.slice(1).join(' '), { limit: 8 }))
            io.out(`${h.score.toFixed(2)}  ${h.path}  ${h.title}\n      ${h.snippet}`);
          return 0;
        }
        if (sub === 'status' || sub === 'queue') {
          const report = await rt.vaultAccuracy();
          io.out(formatAccuracy(report, sub === 'queue' ? Number(values.limit ?? 30) : 10));
          return 0;
        }
        if (sub === 'links') {
          const result = await checkVaultLinks(rt.vault, {
            skip: (url) => rt.domains.failFast(url),
            probe: async (url) =>
              rt.domains.record(
                url,
                await probeUrl(url, {
                  userAgent: config.scrapers.userAgent,
                  allowPrivate: config.tools.allowPrivateNetwork,
                }),
              ),
          });
          for (const b of result.broken)
            io.out(`${b.status.padEnd(9)} ${b.url}\n          cited in ${b.articles.join(', ')}`);
          io.err(
            `${result.ok} links answer, ${result.broken.length} broken, ${result.unchecked.length} could not be checked from ${rt.domains.environment}`,
          );
          return result.broken.length ? 1 : 0;
        }
        if (sub === 'verify') {
          const lines = await rt.verifyVault(Number(values.limit ?? 1), 'cli');
          io.out(
            lines.length
              ? lines.join('\n')
              : 'Nothing to verify from here: no ungrounded article cites a host that answers.',
          );
          return 0;
        }
        io.err('Usage: harness vault lint|index|search|status|queue|links|verify');
        return 2;
      }
      case 'dashboard': {
        const sub = positionals[0];
        if (sub === 'build' && positionals[1]) {
          // The spec path is relative to your shell; file sources inside it resolve against the workspace.
          const text = await fsp.readFile(path.resolve(positionals[1]), 'utf8');
          const built = await rt.dashboards.build(text, { source: 'cli' });
          io.out(DashboardService.summary(built, built.path));
          return 0;
        }
        if (sub === 'list') {
          for (const m of await rt.dashboards.list())
            io.out(
              `${m.slug.padEnd(32)} ${m.builtAt.slice(0, 16).replace('T', ' ')}  ${m.title}${rt.dashboards.url(m.slug) ? `  ${rt.dashboards.url(m.slug)}` : ''}`,
            );
          return 0;
        }
        if (sub === 'remove' && positionals[1]) {
          const removed = await rt.dashboards.remove(positionals[1]);
          io.out(removed ? `removed ${positionals[1]}` : `no dashboard ${positionals[1]}`);
          return removed ? 0 : 1;
        }
        io.err('Usage: harness dashboard build <spec.yaml> | list | remove <slug>');
        return 2;
      }
      case 'explore': {
        const dataset = positionals[0];
        if (!dataset) {
          io.err('Usage: harness explore <dataset>');
          return 2;
        }
        const built = await rt.dashboards.explore(dataset);
        io.out(DashboardService.summary(built, built.path));
        return 0;
      }
      case 'domains': {
        if (positionals[0] !== 'check') {
          io.out(rt.domains.report(positionals.length ? positionals : undefined));
          return 0;
        }
        const targets = new Map<string, string>();
        for (const h of positionals.slice(1)) {
          const host = h
            .replace(/^https?:\/\//i, '')
            .split('/')[0]!
            .toLowerCase();
          if (isTrackableHost(host)) targets.set(host, `https://${host}/`);
          else io.err(`skipped ${h}: not a public host name`);
        }
        if (values.scrapers)
          for (const spec of rt.scrapers.all()) {
            const host = new URL(spec.source.url).hostname.toLowerCase();
            if (isTrackableHost(host) && !targets.has(host)) targets.set(host, spec.source.url);
          }
        if (values.vault)
          for (const [host, e] of await rt.vault.externalUrls()) {
            if (!isTrackableHost(host) || targets.has(host)) continue;
            // The shortest cited https URL is usually the site root or an index page.
            const cited = [...e.urls]
              .filter((u) => u.startsWith('https://'))
              .sort((a, b) => a.length - b.length);
            targets.set(host, cited[0] ?? `https://${host}/`);
          }
        if (!targets.size) {
          io.err('Usage: harness domains check <host...> [--vault] [--scrapers] [--save]');
          return 2;
        }
        const results = await mapConcurrent([...targets], 8, async ([host, url]) => {
          const r = await probeUrl(url, {
            userAgent: config.scrapers.userAgent,
            allowPrivate: config.tools.allowPrivateNetwork,
          });
          return { host, status: rt.domains.record(url, r), ms: r.ms };
        });
        for (const r of results.sort(
          (a, b) => a.status.localeCompare(b.status) || a.host.localeCompare(b.host),
        ))
          io.out(`${r.status.padEnd(12)} ${r.host.padEnd(44)} ${String(r.ms).padStart(6)} ms`);
        const counts = new Map<string, number>();
        for (const r of results) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
        io.err(
          `${results.length} hosts from ${rt.domains.environment}: ${[...counts].map(([s, n]) => `${n} ${s}`).join(', ')}`,
        );
        if (values.save) {
          const day = new Date().toISOString().slice(0, 10);
          for (const r of results) rt.domains.setSeedStatus(r.host, r.status, day);
          await writeTextAtomic(config.resolved.domainsFile, formatDomainSeed(rt.domains.seed));
          io.err(
            `saved ${results.length} hosts for ${rt.domains.environment} to ${config.resolved.domainsFile}`,
          );
        }
        return 0;
      }
      case 'doctor': {
        const d = config.discordEnv;
        const login =
          config.provider === 'claude-code'
            ? await claudeCodeLogin({ command: config.claudeCode.command })
            : undefined;
        const checks: Array<[string, boolean, string]> = [
          login
            ? ['Claude Code login', login.ok, login.note]
            : [
                'ANTHROPIC_API_KEY set',
                !!process.env.ANTHROPIC_API_KEY || config.provider === 'scripted',
                'needed for the anthropic provider (or run `ant auth login`)',
              ],
          ...(login && d.token
            ? [
                [
                  'Discord limited to you',
                  !d.allowEveryone &&
                    d.allowedRoleIds.length === 0 &&
                    new Set([...d.allowedUserIds, ...d.adminUserIds]).size <= 1,
                  "other people's Discord tasks would run on your Claude plan, which is for your own use",
                ] as [string, boolean, string],
              ]
            : []),
          ['DuckDB available', await DuckDbSqlService.isAvailable(), 'optional: enables sql_query'],
          [
            'Discord token set',
            !!config.discordEnv.token,
            'optional: enables the bot (webhooks work without it)',
          ],
          [
            'Discord allow-list set',
            config.discordEnv.allowEveryone ||
              config.discordEnv.allowedUserIds.length +
                config.discordEnv.allowedRoleIds.length +
                config.discordEnv.adminUserIds.length >
                0,
            'required when the bot is enabled',
          ],
          [
            'agents loaded',
            rt.agentList().length > 0,
            rt
              .agentList()
              .map((a) => a.name)
              .join(', '),
          ],
          [
            'skills loaded',
            rt.skills.list().length > 0,
            `${rt.skills.list().length} skills${rt.skills.issues.length ? `, ${rt.skills.issues.length} skipped` : ''}`,
          ],
          ['scrapers loaded', true, `${rt.scrapers.all().length} specs`],
          [
            'command sandbox',
            !config.tools.sandboxSocket ||
              (await sandboxExec(config.tools.sandboxSocket, {
                v: 1,
                command: 'true',
                timeoutMs: 5_000,
              }).then(
                () => true,
                () => false,
              )),
            config.tools.sandboxSocket
              ? `bash runs in the sandbox at ${config.tools.sandboxSocket}`
              : 'off: bash runs in this container (docs/security.md)',
          ],
          [
            'dashboard UI assets',
            await loadUiAssets().then(
              () => true,
              () => false,
            ),
            'run `npm run build:ui` if this fails',
          ],
          [
            'dashboards protected',
            !config.dashboards.serve || !!config.dashboardEnv.password,
            config.dashboards.serve
              ? 'set DASHBOARD_PASSWORD, or keep the web port private'
              : 'not served (dashboards.serve: false)',
          ],
          [
            'vault articles',
            (await rt.vault.articles()).length > 0,
            `${(await rt.vault.articles()).length} articles`,
          ],
        ];
        for (const [name, ok, note] of checks) io.out(`${ok ? 'ok  ' : 'WARN'} ${name.padEnd(26)} ${note}`);
        return 0;
      }
      default:
        io.err(`Unknown command ${command}.\n${USAGE}`);
        return 2;
    }
  } finally {
    await rt.shutdown();
  }
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
