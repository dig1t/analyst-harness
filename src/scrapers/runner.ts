import path from 'node:path';
import { appendJsonl, readJson, writeJsonAtomic } from '../util/fs';
import { hashRecord } from '../util/hash';
import { todayUtc } from '../util/ids';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import { errorMessage } from '../util/errors';
import { extract, type ExtractContext, type RawRecord } from './extract';
import type { PoliteHttpClient } from './http-client';
import type { ScraperSpec } from './spec';
import { validateRecords } from './validate';

export interface ScraperRunHistory {
  at: string;
  ok: boolean;
  fetched: number;
  valid: number;
  invalid: number;
  new: number;
  changed: number;
}

export interface ScraperState {
  name: string;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  consecutiveFailures: number;
  lastValidCount?: number;
  validators?: { etag?: string; lastModified?: string };
  /** key -> content hash of the last seen version (insertion ordered, capped). */
  seen: Record<string, string>;
  history: ScraperRunHistory[];
}

export interface ScrapeReport {
  name: string;
  ok: boolean;
  dryRun: boolean;
  startedAt: string;
  durationMs: number;
  pages: number;
  fetched: number;
  valid: number;
  invalid: number;
  new: number;
  changed: number;
  written: number;
  notModified: boolean;
  datasetFile?: string;
  issues: string[];
  invalidSamples: string[];
  error?: string;
  consecutiveFailures: number;
  sample: RawRecord[];
}

const MAX_SEEN = 20_000;

/** Custom scrapers written in TypeScript plug into the same runner as YAML specs. */
export interface CustomScraper {
  spec: ScraperSpec;
  fetch(ctx: ExtractContext & { logger: Logger }): Promise<{ records: RawRecord[]; pages?: number }>;
}

/**
 * Runs one scraper: extract, validate, detect new and changed records against the previous
 * run, append to the dataset as JSONL, update health state. Health problems that do not throw
 * (zero items after a non-empty run, a spike of invalid records) are reported as issues:
 * they usually mean the page layout changed and the selectors need repair.
 */
export class ScraperRunner {
  constructor(
    private readonly http: Pick<PoliteHttpClient, 'get'>,
    private readonly dataDir: string,
    private readonly logger: Logger = silentLogger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  stateFile(name: string): string {
    return path.join(this.dataDir, 'state', 'scrapers', `${name}.json`);
  }

  datasetFile(dataset: string, date = this.now()): string {
    return path.join(this.dataDir, 'datasets', dataset, `${todayUtc(date)}.jsonl`);
  }

  async state(name: string): Promise<ScraperState> {
    return readJson<ScraperState>(this.stateFile(name), {
      name,
      consecutiveFailures: 0,
      seen: {},
      history: [],
    });
  }

  async run(
    spec: ScraperSpec,
    opts: { dryRun?: boolean; custom?: CustomScraper } = {},
  ): Promise<ScrapeReport> {
    const started = this.now();
    const dryRun = opts.dryRun === true;
    const state = await this.state(spec.name);
    const report: ScrapeReport = {
      name: spec.name,
      ok: false,
      dryRun,
      startedAt: started.toISOString(),
      durationMs: 0,
      pages: 0,
      fetched: 0,
      valid: 0,
      invalid: 0,
      new: 0,
      changed: 0,
      written: 0,
      notModified: false,
      issues: [],
      invalidSamples: [],
      consecutiveFailures: state.consecutiveFailures,
      sample: [],
    };
    try {
      const ctx: ExtractContext = { http: this.http, validators: state.validators };
      const extracted = opts.custom
        ? {
            ...(await opts.custom.fetch({ ...ctx, logger: this.logger })),
            notModified: false,
            validators: undefined,
          }
        : await extract(spec, ctx);
      report.pages = extracted.pages ?? 1;
      report.notModified = extracted.notModified;
      report.fetched = extracted.records.length;
      const { valid, invalid } = validateRecords(spec, extracted.records);
      report.valid = valid.length;
      report.invalid = invalid.length;
      report.invalidSamples = invalid.slice(0, 3).map((i) => `#${i.index}: ${i.errors.join(', ')}`);

      const toWrite: RawRecord[] = [];
      const seen = { ...state.seen };
      for (const rec of valid) {
        const key =
          spec.key && rec[spec.key] !== undefined && rec[spec.key] !== null
            ? String(rec[spec.key])
            : hashRecord(rec);
        const hash = hashRecord(rec);
        const previous = seen[key];
        const isNew = previous === undefined;
        const isChanged = !isNew && previous !== hash;
        if (isNew) report.new++;
        if (isChanged) report.changed++;
        const include = spec.output.mode === 'all' || isNew || (spec.output.mode === 'changed' && isChanged);
        if (include)
          toWrite.push({
            ...rec,
            _key: key,
            _hash: hash,
            _change: isNew ? 'new' : isChanged ? 'changed' : 'same',
            _scraper: spec.name,
            _scraped_at: started.toISOString(),
          });
        delete seen[key];
        seen[key] = hash;
      }
      const keys = Object.keys(seen);
      for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SEEN))) delete seen[k];

      if (!report.notModified) {
        if (valid.length < spec.validation.minItems) {
          report.issues.push(
            state.lastValidCount && state.lastValidCount > 0 && valid.length === 0
              ? `zero valid items (last run had ${state.lastValidCount}): the page structure or selectors may have changed`
              : `only ${valid.length} valid items (expected at least ${spec.validation.minItems})`,
          );
        }
        const ratio = report.fetched ? invalid.length / report.fetched : 0;
        if (ratio > spec.validation.maxInvalidRatio)
          report.issues.push(
            `${Math.round(ratio * 100)}% of records failed validation (limit ${Math.round(spec.validation.maxInvalidRatio * 100)}%): possible schema drift`,
          );
      }
      report.sample = toWrite.slice(0, 3);
      if (!dryRun) {
        const dataset = spec.output.dataset ?? spec.name;
        if (toWrite.length) {
          const file = this.datasetFile(dataset, started);
          for (const rec of toWrite) await appendJsonl(file, rec);
          report.datasetFile = path.relative(this.dataDir, file).split(path.sep).join('/');
        }
        report.written = toWrite.length;
        state.seen = seen;
        if (extracted.validators) state.validators = extracted.validators;
        if (!report.notModified) state.lastValidCount = valid.length;
      }
      report.ok = report.issues.length === 0;
    } catch (err) {
      report.ok = false;
      report.error = errorMessage(err);
      this.logger.warn('scraper failed', { scraper: spec.name, err });
    }
    report.durationMs = this.now().getTime() - started.getTime();
    if (!dryRun) {
      state.lastRunAt = started.toISOString();
      if (report.ok) {
        state.lastSuccessAt = started.toISOString();
        state.consecutiveFailures = 0;
        state.lastError = undefined;
      } else {
        state.consecutiveFailures += 1;
        state.lastError = report.error ?? report.issues.join('; ');
      }
      state.history = [
        ...state.history,
        {
          at: report.startedAt,
          ok: report.ok,
          fetched: report.fetched,
          valid: report.valid,
          invalid: report.invalid,
          new: report.new,
          changed: report.changed,
        },
      ].slice(-20);
      await writeJsonAtomic(this.stateFile(spec.name), state);
    }
    report.consecutiveFailures = state.consecutiveFailures;
    return report;
  }
}

export function formatScrapeReport(r: ScrapeReport): string {
  const head = `${r.ok ? 'OK' : 'PROBLEM'} scraper ${r.name}${r.dryRun ? ' (dry run)' : ''}: ${r.fetched} fetched, ${r.valid} valid, ${r.invalid} invalid, ${r.new} new, ${r.changed} changed, ${r.written} written in ${(r.durationMs / 1000).toFixed(1)}s over ${r.pages} request${r.pages === 1 ? '' : 's'}`;
  const lines = [head];
  if (r.notModified) lines.push('Source not modified since the last run (conditional request).');
  if (r.datasetFile) lines.push(`Dataset: ${r.datasetFile}`);
  if (r.error) lines.push(`Error: ${r.error}`);
  for (const i of r.issues) lines.push(`Issue: ${i}`);
  for (const s of r.invalidSamples) lines.push(`Invalid ${s}`);
  if (r.consecutiveFailures > 0) lines.push(`Consecutive failures: ${r.consecutiveFailures}`);
  return lines.join('\n');
}
