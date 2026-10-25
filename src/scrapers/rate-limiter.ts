/**
 * Per-host politeness: one request at a time per host, with at least `intervalMs` between
 * request starts (raised to the robots.txt crawl-delay when a site asks for more).
 */
export class HostRateLimiter {
  private readonly nextAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async schedule<T>(host: string, intervalMs: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const wait = (this.nextAt.get(host) ?? 0) - this.now();
        if (wait > 0) await this.sleep(wait);
        this.nextAt.set(host, this.now() + intervalMs);
        return fn();
      });
    this.chains.set(host, run);
    return run;
  }
}
