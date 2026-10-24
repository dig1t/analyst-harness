import type { BudgetGuard } from '../core/agent-loop';
import { readJson, writeJsonAtomic } from '../util/fs';
import { todayUtc } from '../util/ids';

interface SpendState {
  days: Record<string, number>;
}

/**
 * Daily spend cap shared by every run, cron job and judge call. Cheap hosting is pointless if
 * a runaway loop burns the API budget, so the cap is enforced before each model call.
 */
export class SpendTracker implements BudgetGuard {
  private state: SpendState = { days: {} };
  private chain = Promise.resolve();

  constructor(
    readonly dailyCapUsd: number,
    private readonly file?: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<this> {
    if (this.file) this.state = await readJson<SpendState>(this.file, { days: {} });
    return this;
  }

  get today(): number {
    return this.state.days[todayUtc(this.now())] ?? 0;
  }

  exceeded(): string | undefined {
    if (this.dailyCapUsd > 0 && this.today >= this.dailyCapUsd) {
      return `daily spend cap of $${this.dailyCapUsd.toFixed(2)} reached ($${this.today.toFixed(2)} spent today)`;
    }
    return undefined;
  }

  record(costUsd: number): void {
    if (!(costUsd > 0)) return;
    const day = todayUtc(this.now());
    this.state.days[day] = (this.state.days[day] ?? 0) + costUsd;
    // Keep 90 days of history.
    const keys = Object.keys(this.state.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 90))) delete this.state.days[k];
    if (this.file) {
      const file = this.file;
      const snapshot = structuredClone(this.state);
      this.chain = this.chain.then(() => writeJsonAtomic(file, snapshot)).catch(() => undefined);
    }
  }

  history(days = 7): Array<{ date: string; usd: number }> {
    return Object.entries(this.state.days)
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-days)
      .map(([date, usd]) => ({ date, usd }));
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
