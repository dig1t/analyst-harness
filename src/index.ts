import type http from 'node:http';
import { createWebServer } from './app/http';
import { HarnessRuntime } from './app/runtime';
import { loadDotEnv } from './config/dotenv';
import { loadConfig } from './config/load';
import { DiscordBot } from './discord/client';

/** Listen, or fail with a message that says what to do when the port is taken. */
function listen(server: http.Server, port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) =>
      reject(
        err.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is already in use: another harness is probably running (check \`harness daemon status\`), or set PORT to a free port`,
            )
          : err,
      ),
    );
    server.listen(port, host, () => resolve());
  });
}

/**
 * Long-running entry point: the web port (health check and dashboards), the scheduler
 * (scrapers, digest, learning, vault lint) and the Discord bot when a token is configured.
 * The port is claimed first, so a second copy exits before it can run jobs or a second bot.
 */
export async function main(): Promise<void> {
  loadDotEnv(process.env.HARNESS_ROOT ?? process.cwd());
  const config = await loadConfig();
  const rt = await HarnessRuntime.create({ config, env: process.env });

  const port = Number(process.env.PORT ?? 8080);
  const web = config.dashboardEnv;
  const server = createWebServer({
    dashboards: config.dashboards.serve ? rt.dashboards : undefined,
    status: () => rt.ops().status(),
    auth: web.password ? { user: web.user, password: web.password } : undefined,
    logger: rt.logger.child({ component: 'web' }),
  });
  // HOST limits the interface (the daemon uses 127.0.0.1); containers listen on all of them.
  await listen(server, port, process.env.HOST || undefined);
  rt.logger.info('web port listening', { port, dashboards: config.dashboards.serve, auth: !!web.password });
  if (config.dashboards.serve && !web.password)
    rt.logger.warn(
      'dashboards are served without a password: set DASHBOARD_PASSWORD, or keep the port private (docs/dashboards.md)',
    );

  rt.registerScraperJobs();
  rt.registerSystemJobs();
  rt.scheduler.start();

  let bot: DiscordBot | undefined;
  const d = config.discordEnv;
  if (d.token) {
    if (!d.allowEveryone && d.allowedUserIds.length + d.allowedRoleIds.length + d.adminUserIds.length === 0) {
      rt.logger.warn(
        'DISCORD_TOKEN is set but no DISCORD_ALLOWED_USER_IDS / DISCORD_ALLOWED_ROLE_IDS / DISCORD_ADMIN_USER_IDS: the bot will refuse every command',
      );
    }
    bot = new DiscordBot(rt.ops(), {
      token: d.token,
      applicationId: d.applicationId ?? '',
      guildId: d.guildId,
      channels: { reports: d.reportsChannelId, alerts: d.alertsChannelId },
      auth: {
        allowedUserIds: d.allowedUserIds,
        allowedRoleIds: d.allowedRoleIds,
        adminUserIds: d.adminUserIds,
        allowEveryone: d.allowEveryone,
      },
      prefixCommands: config.discord.prefixCommands,
      approvalTimeoutMs: config.discord.approvalTimeoutSec * 1000,
      logger: rt.logger.child({ component: 'discord' }),
    });
    if (d.applicationId)
      await bot
        .registerCommands()
        .catch((err) => rt.logger.error('slash command registration failed', { err }));
    await bot.start();
    rt.attachNotifier(bot);
  } else {
    rt.logger.info('DISCORD_TOKEN not set: running scheduler only (webhook notifications still work)');
  }

  const shutdown = async (signal: string) => {
    rt.logger.info('shutting down', { signal });
    server.close();
    await bot?.stop().catch(() => undefined);
    await rt.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
