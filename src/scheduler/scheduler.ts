import { Cron } from 'croner';
import { errorMessage } from '../util/errors';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';

export interface JobDefinition {
  name: string;
  cron: string;
  timezone?: string;
  description?: string;
  run: () => Promise<string | void>;
}

export interface JobStatus {
  name: string;
  cron: string;
  timezone: string;
  description: string;
  running: boolean;
  nextRun?: string;
  lastRun?: string;
  lastStatus?: 'ok' | 'error' | 'skipped';
  lastMessage?: string;
  runs: number;
  failures: number;
}

/** Minimal cron engine contract so tests can trigger jobs without waiting for the clock. */
export interface CronHandle {
  nextRun(): Date | null;
  stop(): void;
}

export type CronFactory = (pattern: string, timezone: string, tick: () => void) => CronHandle;

export const croner: CronFactory = (pattern, timezone, tick) => {
  const job = new Cron(pattern, { timezone, protect: true }, tick);
  return { nextRun: () => job.nextRun(), stop: () => job.stop() };
};

/** Validate a cron expression (5 or 6 fields) and return the next run, or an error message. */
export function validateCron(
  pattern: string,
  timezone = 'UTC',
): { ok: true; next: Date | null } | { ok: false; error: string } {
  try {
    const job = new Cron(pattern, { timezone, paused: true });
    const next = job.nextRun();
    job.stop();
    return { ok: true, next };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/**
 * In-process scheduler for scrapers and system jobs (digest, learning, vault lint). Overlap
 * protection skips a tick while the previous run is still going, which matters on a small
 * VPS where a slow site could otherwise pile up concurrent runs.
 */
export class Scheduler {
  private readonly jobs = new Map<string, { def: JobDefinition; handle?: CronHandle; status: JobStatus }>();
  private started = false;

  constructor(
    private readonly factory: CronFactory = croner,
    private readonly logger: Logger = silentLogger,
    private readonly onError?: (job: string, error: string) => void | Promise<void>,
  ) {}

  add(def: JobDefinition): void {
    if (this.jobs.has(def.name)) throw new Error(`duplicate job ${def.name}`);
    const check = validateCron(def.cron, def.timezone ?? 'UTC');
    if (!check.ok) throw new Error(`invalid cron "${def.cron}" for job ${def.name}: ${check.error}`);
    const status: JobStatus = {
      name: def.name,
      cron: def.cron,
      timezone: def.timezone ?? 'UTC',
      description: def.description ?? '',
      running: false,
      runs: 0,
      failures: 0,
    };
    const entry: { def: JobDefinition; handle?: CronHandle; status: JobStatus } = { def, status };
    this.jobs.set(def.name, entry);
    if (this.started)
      entry.handle = this.factory(def.cron, status.timezone, () => void this.runNow(def.name));
  }

  remove(name: string): void {
    this.jobs.get(name)?.handle?.stop();
    this.jobs.delete(name);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const [name, entry] of this.jobs)
      entry.handle = this.factory(entry.def.cron, entry.status.timezone, () => void this.runNow(name));
    this.logger.info('scheduler started', { jobs: this.jobs.size });
  }

  stop(): void {
    for (const entry of this.jobs.values()) entry.handle?.stop();
    this.started = false;
  }

  async runNow(name: string): Promise<JobStatus> {
    const entry = this.jobs.get(name);
    if (!entry) throw new Error(`unknown job ${name}`);
    const { status } = entry;
    if (status.running) {
      status.lastStatus = 'skipped';
      status.lastMessage = 'previous run still in progress';
      return { ...status };
    }
    status.running = true;
    status.lastRun = new Date().toISOString();
    try {
      const message = await entry.def.run();
      status.lastStatus = 'ok';
      status.lastMessage = typeof message === 'string' ? message.slice(0, 500) : undefined;
    } catch (err) {
      status.lastStatus = 'error';
      status.lastMessage = errorMessage(err).slice(0, 500);
      status.failures++;
      this.logger.error('job failed', { job: name, err });
      await this.onError?.(name, status.lastMessage);
    } finally {
      status.running = false;
      status.runs++;
    }
    return { ...status };
  }

  list(): JobStatus[] {
    return [...this.jobs.values()]
      .map(({ status, handle }) => ({ ...status, nextRun: handle?.nextRun()?.toISOString() }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  has(name: string): boolean {
    return this.jobs.has(name);
  }
}
