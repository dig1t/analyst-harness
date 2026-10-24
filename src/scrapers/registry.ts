import type { ScraperService } from '../tools/types';
import { formatScrapeReport, type CustomScraper, type ScrapeReport, type ScraperRunner } from './runner';
import { loadScraperSpecs, type ScraperSpec } from './spec';

/** All registered scrapers: YAML specs from config/scrapers plus TypeScript custom scrapers. */
export class ScraperRegistry implements ScraperService {
  private readonly specs = new Map<string, ScraperSpec>();
  private readonly custom = new Map<string, CustomScraper>();
  private readonly running = new Set<string>();

  constructor(
    private readonly runner: ScraperRunner,
    private readonly dir?: string,
  ) {}

  async reload(customScrapers: CustomScraper[] = [...this.custom.values()]): Promise<void> {
    this.specs.clear();
    this.custom.clear();
    if (this.dir) for (const s of await loadScraperSpecs(this.dir)) this.specs.set(s.name, s);
    for (const c of customScrapers) {
      if (this.specs.has(c.spec.name))
        throw new Error(`custom scraper ${c.spec.name} collides with a YAML spec`);
      this.specs.set(c.spec.name, c.spec);
      this.custom.set(c.spec.name, c);
    }
  }

  add(spec: ScraperSpec, custom?: CustomScraper): void {
    this.specs.set(spec.name, spec);
    if (custom) this.custom.set(spec.name, custom);
  }

  get(name: string): ScraperSpec | undefined {
    return this.specs.get(name);
  }

  all(): ScraperSpec[] {
    return [...this.specs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  list(): Array<{ name: string; description: string; schedule?: string; enabled: boolean }> {
    return this.all().map((s) => ({
      name: s.name,
      description: s.description,
      schedule: s.schedule,
      enabled: s.enabled,
    }));
  }

  isRunning(name: string): boolean {
    return this.running.has(name);
  }

  async runReport(name: string, opts: { dryRun?: boolean } = {}): Promise<ScrapeReport> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`unknown scraper ${name}`);
    if (this.running.has(name)) throw new Error(`scraper ${name} is already running`);
    this.running.add(name);
    try {
      return await this.runner.run(spec, { dryRun: opts.dryRun, custom: this.custom.get(name) });
    } finally {
      this.running.delete(name);
    }
  }

  async run(name: string, opts: { dryRun?: boolean } = {}): Promise<string> {
    return formatScrapeReport(await this.runReport(name, opts));
  }

  async state(name: string) {
    return this.runner.state(name);
  }
}
