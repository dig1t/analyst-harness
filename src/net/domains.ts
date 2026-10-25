import { promises as fsp } from 'node:fs';
import YAML from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../util/errors';
import { readJson, writeTextAtomic } from '../util/fs';

/** `ok`, `http-404`, `unreachable` (DNS, refused, TLS), `timeout` or `blocked` (a proxy said no). */
export type ReachStatus = string;

const STATUS_RE = /^(ok|blocked|unreachable|timeout|http-\d{3})$/;
const ENV_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const NETWORK_FAILURES = new Set(['unreachable', 'timeout', 'blocked']);

const SeedSchema = z
  .object({
    environments: z
      .record(
        z.string().regex(ENV_RE),
        z.object({ description: z.string().max(300), checked: z.string().optional() }).strict(),
      )
      .default({}),
    hosts: z
      .record(
        z.string(),
        z.object({ note: z.string().max(300).optional() }).catchall(z.string().regex(STATUS_RE)),
      )
      .default({}),
  })
  .strict();

export type DomainSeed = z.infer<typeof SeedSchema>;

export interface HostObservation {
  okCount: number;
  failCount: number;
  consecutiveFailures: number;
  lastStatus: ReachStatus;
  lastOkAt?: string;
  lastFailureAt?: string;
  lastError?: string;
}

export interface FetchOutcome {
  /** The HTTP status when a response arrived. */
  status?: number;
  /** The thrown error when none did. */
  error?: unknown;
}

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
const RESERVED_RE = /(^|\.)(example|test|invalid|localhost|local|internal)$|^example\.(com|org|net)$/;

/** A public DNS name worth tracking: no IPs, ports, placeholders or reserved example domains. */
export function isTrackableHost(host: string): boolean {
  const h = host.toLowerCase();
  return HOST_RE.test(h) && !RESERVED_RE.test(h) && !/^\d+(\.\d+)*$/.test(h);
}

export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Reduce a fetch result to a reach status; DNS, refused and TLS errors all mean "unreachable". */
export function classifyOutcome(o: FetchOutcome): ReachStatus {
  if (o.status !== undefined) return o.status < 400 || o.status === 304 ? 'ok' : `http-${o.status}`;
  const e = o.error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const text = `${e?.name ?? ''} ${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`;
  if (/TimeoutError|AbortError|ETIMEDOUT|CONNECT_TIMEOUT|timed out/i.test(text)) return 'timeout';
  if (/Proxy response \(4\d\d\)|tunnel(ing)? (failed|socket)|ERR_TUNNEL/i.test(text)) return 'blocked';
  return 'unreachable';
}

function errorText(error: unknown): string {
  const e = error as { message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.cause?.message;
  return `${e?.message ?? String(error)}${cause ? ` (${cause})` : ''}`.slice(0, 200);
}

export async function loadDomainSeed(file: string): Promise<DomainSeed> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch {
    return { environments: {}, hosts: {} };
  }
  const parsed = SeedSchema.safeParse(YAML.parse(text) ?? {});
  if (!parsed.success)
    throw new ConfigError(
      `Invalid domain registry ${file}: ${parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  return parsed.data;
}

/** Stable, one-line-per-host YAML, so diffs of a re-check stay readable. */
export function formatDomainSeed(seed: DomainSeed): string {
  const lines = [
    '# Hosts the harness has probed and how they answered, per environment. Agents read this',
    '# through the domain_status tool; `harness domains check` refreshes it. Statuses: ok,',
    '# http-<code>, unreachable (DNS, refused, TLS), timeout, blocked (a proxy refused).',
    'environments:',
  ];
  for (const [name, env] of Object.entries(seed.environments).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${name}:`, `    description: ${JSON.stringify(env.description)}`);
    if (env.checked) lines.push(`    checked: '${env.checked}'`);
  }
  lines.push('hosts:');
  for (const host of Object.keys(seed.hosts).sort()) {
    const { note, ...statuses } = seed.hosts[host]!;
    const parts = Object.entries(statuses)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([env, status]) => `${env}: ${status}`);
    if (note) parts.push(`note: ${JSON.stringify(note)}`);
    lines.push(`  ${host}: { ${parts.join(', ')} }`);
  }
  return lines.join('\n') + '\n';
}

export interface DomainRegistryOptions {
  /** Live observations (data/state/domains.json). */
  statePath: string;
  seed: DomainSeed;
  /** This deployment's name in the seed, such as `server` or `claude-code-cloud`. */
  environment: string;
  /** Refuse a host after this many network failures in a row... */
  failFastAfter?: number;
  /** ...within this window. 0 turns fail-fast off. */
  failFastMs?: number;
  now?: () => number;
}

/**
 * Which hosts answer from this environment. Fetches record every outcome; a host that keeps
 * failing at the network level, or that the seed lists as unreachable here, is refused at once
 * so an agent picks another source instead of waiting out timeouts. One success clears it.
 */
export class DomainRegistry {
  private observations: Record<string, HostObservation> = {};
  private flushTimer?: ReturnType<typeof setTimeout>;
  private dirty = false;
  private readonly now: () => number;

  private constructor(private readonly opts: DomainRegistryOptions) {
    this.now = opts.now ?? Date.now;
  }

  static async load(opts: DomainRegistryOptions): Promise<DomainRegistry> {
    const reg = new DomainRegistry(opts);
    reg.observations = await readJson<Record<string, HostObservation>>(opts.statePath, {});
    return reg;
  }

  get environment(): string {
    return this.opts.environment;
  }

  get seed(): DomainSeed {
    return this.opts.seed;
  }

  observation(host: string): HostObservation | undefined {
    return this.observations[host.toLowerCase()];
  }

  record(url: string, outcome: FetchOutcome): ReachStatus {
    const status = classifyOutcome(outcome);
    const host = hostOf(url);
    if (!host || !isTrackableHost(host)) return status;
    const at = new Date(this.now()).toISOString();
    const o = (this.observations[host] ??= {
      okCount: 0,
      failCount: 0,
      consecutiveFailures: 0,
      lastStatus: status,
    });
    o.lastStatus = status;
    // An HTTP error still proves the host answers; only network failures count toward fail-fast.
    if (!NETWORK_FAILURES.has(status)) {
      o.okCount++;
      o.consecutiveFailures = 0;
      o.lastOkAt = at;
    } else {
      o.failCount++;
      o.consecutiveFailures++;
      o.lastFailureAt = at;
      o.lastError = outcome.error ? errorText(outcome.error) : status;
    }
    this.scheduleFlush();
    return status;
  }

  /** Why a fetch to `url` should not be attempted from here, or null. */
  failFast(url: string): string | null {
    const host = hostOf(url);
    if (!host || !this.opts.failFastMs) return null;
    const o = this.observations[host];
    const after = this.opts.failFastAfter ?? 3;
    if (o && o.consecutiveFailures >= after && o.lastFailureAt) {
      const age = this.now() - Date.parse(o.lastFailureAt);
      if (age < this.opts.failFastMs)
        return `${host} failed ${o.consecutiveFailures} times in a row from this environment, last ${formatAge(age)} ago (${o.lastError ?? o.lastStatus})`;
    }
    const listed = this.opts.seed.hosts[host]?.[this.opts.environment];
    if (listed && NETWORK_FAILURES.has(listed) && !o?.lastOkAt) {
      const checked = this.opts.seed.environments[this.opts.environment]?.checked;
      return `${host} is listed as ${listed} from ${this.opts.environment} in the domain registry${checked ? ` (checked ${checked})` : ''}`;
    }
    return null;
  }

  /** One line per host for the domain_status tool. */
  describe(host: string): string {
    const h = host.toLowerCase();
    const o = this.observations[h];
    const seed = this.opts.seed.hosts[h];
    const parts: string[] = [];
    const refused = this.failFast(`https://${h}/`);
    if (refused) parts.push(`refused here: ${refused}`);
    else if (o)
      parts.push(
        `${NETWORK_FAILURES.has(o.lastStatus) ? 'failing' : 'answers'} here (last ${o.lastStatus}; ${o.okCount} answered, ${o.failCount} failed${o.lastOkAt ? `; last answer ${o.lastOkAt.slice(0, 16).replace('T', ' ')} UTC` : ''})`,
      );
    else parts.push('not tried from here yet');
    if (seed) {
      const { note, ...statuses } = seed;
      const known = Object.entries(statuses).map(([env, s]) => `${env} ${s}`);
      if (known.length) parts.push(`registry: ${known.join(', ')}`);
      if (note) parts.push(`note: ${note}`);
    }
    return `- ${h}: ${parts.join('; ')}`;
  }

  /** Hosts by state in this environment, from observations and the seed. */
  summary(): { answering: string[]; failing: string[]; listedUnreachable: string[]; listedOk: string[] } {
    const answering: string[] = [];
    const failing: string[] = [];
    for (const [host, o] of Object.entries(this.observations))
      (NETWORK_FAILURES.has(o.lastStatus) ? failing : answering).push(host);
    const listedOk: string[] = [];
    const listedUnreachable: string[] = [];
    for (const [host, entry] of Object.entries(this.opts.seed.hosts)) {
      const s = entry[this.opts.environment];
      if (!s) continue;
      (NETWORK_FAILURES.has(s) ? listedUnreachable : listedOk).push(host);
    }
    return {
      answering: answering.sort(),
      failing: failing.sort(),
      listedOk: listedOk.sort(),
      listedUnreachable: listedUnreachable.sort(),
    };
  }

  /** The domain_status answer: the given hosts, or a summary of this environment. */
  report(hosts?: string[]): string {
    if (hosts?.length) return hosts.map((h) => this.describe(h)).join('\n');
    const s = this.summary();
    const env = this.opts.environment;
    const checked = this.opts.seed.environments[env]?.checked;
    const list = (xs: string[], max = 40) =>
      xs.length
        ? `${xs.slice(0, max).join(', ')}${xs.length > max ? `, and ${xs.length - max} more` : ''}`
        : 'none';
    return [
      `Environment: ${env}${checked ? ` (registry last checked ${checked})` : ' (not in the registry yet)'}.`,
      `Answering here (observed): ${list(s.answering)}`,
      `Failing here (observed): ${list(s.failing)}`,
      `Registry, reachable from ${env}: ${s.listedOk.length} hosts: ${list(s.listedOk)}`,
      `Registry, unreachable from ${env}: ${s.listedUnreachable.length} hosts. Ask about specific hosts for details.`,
    ].join('\n');
  }

  /** Write `status` for this environment into the seed (for `harness domains check --save`). */
  setSeedStatus(host: string, status: ReachStatus, checked: string): void {
    const h = host.toLowerCase();
    const env = this.opts.environment;
    this.opts.seed.hosts[h] = { ...(this.opts.seed.hosts[h] ?? {}), [env]: status };
    const known = this.opts.seed.environments[env];
    this.opts.seed.environments[env] = {
      description: known?.description ?? `Deployment "${env}"`,
      checked,
    };
  }

  private scheduleFlush(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => undefined);
    }, 2000);
    this.flushTimer.unref?.();
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;
    await writeTextAtomic(this.opts.statePath, JSON.stringify(this.observations, null, 1));
  }
}

function formatAge(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'moments';
  if (min < 90) return `${min} min`;
  return `${Math.round(min / 60)} h`;
}
