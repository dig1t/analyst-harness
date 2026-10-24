import robotsParser from 'robots-parser';

type Robot = ReturnType<typeof robotsParser>;

interface Entry {
  robot: Robot | 'allow-all' | 'disallow-all';
  fetchedAt: number;
}

export type RobotsFetcher = (url: string) => Promise<{ status: number; body: string }>;

/**
 * robots.txt handling per RFC 9309: a 4xx means no restrictions, an unreachable file (5xx
 * or network error) means assume complete disallow, results are cached for up to 24 hours.
 */
export class RobotsCache {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly fetcher: RobotsFetcher,
    private readonly ttlMs = 24 * 60 * 60 * 1000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private async entry(url: URL): Promise<Entry> {
    const origin = url.origin;
    const cached = this.cache.get(origin);
    if (cached && this.now() - cached.fetchedAt < this.ttlMs) return cached;
    const robotsUrl = `${origin}/robots.txt`;
    let entry: Entry;
    try {
      const res = await this.fetcher(robotsUrl);
      if (res.status >= 200 && res.status < 300)
        entry = { robot: robotsParser(robotsUrl, res.body), fetchedAt: this.now() };
      else if (res.status >= 400 && res.status < 500) entry = { robot: 'allow-all', fetchedAt: this.now() };
      else entry = { robot: 'disallow-all', fetchedAt: this.now() };
    } catch {
      entry = { robot: 'disallow-all', fetchedAt: this.now() };
    }
    this.cache.set(origin, entry);
    return entry;
  }

  async isAllowed(rawUrl: string, userAgent: string): Promise<boolean> {
    const url = new URL(rawUrl);
    if (url.pathname === '/robots.txt') return true;
    const { robot } = await this.entry(url);
    if (robot === 'allow-all') return true;
    if (robot === 'disallow-all') return false;
    return robot.isAllowed(rawUrl, userAgent) !== false;
  }

  /** Crawl-delay in milliseconds (a non-standard but widely used extension), if any. */
  async crawlDelayMs(rawUrl: string, userAgent: string): Promise<number | undefined> {
    const { robot } = await this.entry(new URL(rawUrl));
    if (typeof robot === 'string') return undefined;
    const delay = robot.getCrawlDelay(userAgent);
    return typeof delay === 'number' && delay > 0 ? Math.min(delay, 60) * 1000 : undefined;
  }

  async sitemaps(rawUrl: string): Promise<string[]> {
    const { robot } = await this.entry(new URL(rawUrl));
    return typeof robot === 'string' ? [] : robot.getSitemaps();
  }
}
