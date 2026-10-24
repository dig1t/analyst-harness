import { chunkText } from '../util/text';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';

export type NotifyChannel = 'reports' | 'alerts';

export interface Notification {
  channel: NotifyChannel;
  title: string;
  body: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  /** Optional attachment (for example a long report as Markdown). */
  file?: { name: string; content: string };
}

export interface Notifier {
  notify(n: Notification): Promise<void>;
}

export const LEVEL_COLORS = {
  info: 0x3b82f6,
  success: 0x22c55e,
  warning: 0xf59e0b,
  error: 0xef4444,
} as const;

/** Discord message limits: 2000 characters of content, 4096 per embed description. */
export const DISCORD_CONTENT_LIMIT = 2000;
export const DISCORD_EMBED_LIMIT = 4096;

export class ConsoleNotifier implements Notifier {
  constructor(private readonly logger: Logger = silentLogger) {}
  async notify(n: Notification): Promise<void> {
    this.logger.info(`[${n.channel}] ${n.title}`, { body: n.body.slice(0, 2000), level: n.level });
  }
}

/**
 * Posts to Discord incoming webhooks: lets scrapers report without running the bot at all
 * (the cheapest deployment: scheduler only, plus a webhook URL per channel).
 */
export class WebhookNotifier implements Notifier {
  constructor(
    private readonly urls: Partial<Record<NotifyChannel, string>>,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly logger: Logger = silentLogger,
  ) {}

  async notify(n: Notification): Promise<void> {
    const url = this.urls[n.channel] ?? this.urls.reports;
    if (!url) return;
    const chunks = chunkText(n.body, DISCORD_EMBED_LIMIT - 100);
    for (let i = 0; i < chunks.length; i++) {
      const payload = {
        username: 'analyst-harness',
        allowed_mentions: { parse: [] as string[] },
        embeds: [
          {
            title: i === 0 ? n.title.slice(0, 256) : `${n.title.slice(0, 240)} (cont.)`,
            description: chunks[i],
            color: LEVEL_COLORS[n.level ?? 'info'],
          },
        ],
      };
      let res: Response;
      if (n.file && i === chunks.length - 1) {
        const form = new FormData();
        form.append('payload_json', JSON.stringify(payload));
        form.append('files[0]', new Blob([n.file.content], { type: 'text/markdown' }), n.file.name);
        res = await this.fetchImpl(url, { method: 'POST', body: form });
      } else {
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      if (!res.ok) this.logger.warn('webhook post failed', { status: res.status });
    }
  }
}

export class MultiNotifier implements Notifier {
  constructor(private readonly targets: Notifier[]) {}
  async notify(n: Notification): Promise<void> {
    await Promise.allSettled(this.targets.map((t) => t.notify(n)));
  }
}
