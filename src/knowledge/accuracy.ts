import { existsSync } from 'node:fs';
import path from 'node:path';
import { extractLinks, extractUrls, type KnowledgeVault } from './vault';

export interface ArticleAccuracy {
  path: string;
  title: string;
  topic: string;
  /** The Raw line links to captures that exist under raw/. */
  grounded: boolean;
  seed: boolean;
  rawFiles: string[];
  citedUrls: string[];
  citedHosts: string[];
  /** Cited hosts known to answer from this environment. */
  reachableHosts: string[];
  /** Cited hosts known not to answer from here. */
  unreachableHosts: string[];
  updated?: string;
  ageDays?: number;
  stale: boolean;
  inbound: number;
  /** Higher goes first in the verification queue. */
  priority: number;
  reasons: string[];
}

export interface AccuracyReport {
  environment: string;
  /** Every article except lessons, highest priority first. */
  articles: ArticleAccuracy[];
  totals: {
    articles: number;
    grounded: number;
    seed: number;
    stale: number;
    citations: number;
    hosts: number;
    hostsReachable: number;
    hostsUnreachable: number;
    /** Articles with at least one cited host that answers from here. */
    verifiableNow: number;
  };
}

export interface AccuracyOptions {
  environment: string;
  /** true: answers from here, false: does not, undefined: unknown. */
  answers: (host: string) => boolean | undefined;
  today?: string;
  /** Articles not updated for this many days count as stale (default 365). */
  staleDays?: number;
}

const DAY = 86_400_000;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * How well each article is grounded: captured raw sources, citations and whether their hosts
 * answer from here, age and centrality. The ranking is the verification queue: ungrounded,
 * stale, much-linked articles whose sources can be fetched from here come first.
 */
export async function accuracyReport(vault: KnowledgeVault, opts: AccuracyOptions): Promise<AccuracyReport> {
  const today = Date.parse(opts.today ?? new Date().toISOString().slice(0, 10));
  const staleDays = opts.staleDays ?? 365;
  const articles = (await vault.articles()).filter((a) => a.topic !== 'lessons');
  const inbound = new Map<string, number>();
  for (const a of articles)
    for (const link of a.links) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(a.path), link));
      inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }

  const rows = articles.map((a): ArticleAccuracy => {
    const rawFiles = extractLinks(a.meta.Raw ?? '')
      .map((l) => path.posix.normalize(path.posix.join(path.posix.dirname(a.path), l)))
      .filter((p) => p.startsWith('raw/') && existsSync(path.join(vault.dir, p)));
    const citedUrls = [...new Set([...extractUrls(a.meta.Sources ?? ''), ...extractUrls(a.body)])];
    const citedHosts = [...new Set(citedUrls.map(hostOf).filter((h): h is string => !!h))].sort();
    const reachableHosts = citedHosts.filter((h) => opts.answers(h) === true);
    const unreachableHosts = citedHosts.filter((h) => opts.answers(h) === false);
    const updated = /^\d{4}-\d{2}-\d{2}$/.test(a.meta.Updated ?? '') ? a.meta.Updated : undefined;
    const ageDays = updated ? Math.max(0, Math.floor((today - Date.parse(updated)) / DAY)) : undefined;
    const stale = ageDays === undefined || ageDays > staleDays;
    const links = inbound.get(a.path) ?? 0;
    const grounded = rawFiles.length > 0;
    const reasons: string[] = [];
    let priority = 0;
    if (!grounded) {
      priority += a.seed ? 4 : 3;
      reasons.push(a.seed ? 'seed article (no captured source)' : 'no captured source');
    }
    if (stale) {
      priority += 2;
      reasons.push(updated ? `not updated for ${ageDays} days` : 'no valid Updated date');
    }
    if (links >= 3) {
      priority += Math.min(3, Math.floor(links / 3));
      reasons.push(`${links} articles link here`);
    }
    const needed = !grounded || stale;
    if (!needed) reasons.push('grounded and current');
    else if (citedHosts.length === 0) {
      priority -= 3;
      reasons.push('cites no URL (find a source first)');
    } else if (reachableHosts.length) {
      priority += 2;
      reasons.push(`${reachableHosts.length} of ${citedHosts.length} cited hosts answer here`);
    } else if (unreachableHosts.length === citedHosts.length) {
      priority -= 2;
      reasons.push('no cited host answers here');
    }
    return {
      path: a.path,
      title: a.title,
      topic: a.topic,
      grounded,
      seed: a.seed,
      rawFiles,
      citedUrls,
      citedHosts,
      reachableHosts,
      unreachableHosts,
      updated,
      ageDays,
      stale,
      inbound: links,
      priority,
      reasons,
    };
  });
  rows.sort((a, b) => b.priority - a.priority || b.inbound - a.inbound || a.path.localeCompare(b.path));

  const hosts = new Set(rows.flatMap((r) => r.citedHosts));
  const known = [...hosts].map((h) => opts.answers(h));
  return {
    environment: opts.environment,
    articles: rows,
    totals: {
      articles: rows.length,
      grounded: rows.filter((r) => r.grounded).length,
      seed: rows.filter((r) => r.seed).length,
      stale: rows.filter((r) => r.stale).length,
      citations: rows.reduce((n, r) => n + r.citedUrls.length, 0),
      hosts: hosts.size,
      hostsReachable: known.filter((k) => k === true).length,
      hostsUnreachable: known.filter((k) => k === false).length,
      verifiableNow: rows.filter((r) => r.reachableHosts.length > 0).length,
    },
  };
}

/** A terminal or Discord summary with the top of the queue. */
export function formatAccuracy(report: AccuracyReport, limit = 10): string {
  const t = report.totals;
  const pct = (n: number) => `${t.articles ? Math.round((n / t.articles) * 100) : 0}%`;
  const lines = [
    `${t.articles} articles: ${t.grounded} grounded in captured sources (${pct(t.grounded)}), ${t.seed} seed, ${t.stale} stale`,
    `${t.citations} citations to ${t.hosts} hosts; from ${report.environment}: ${t.hostsReachable} answer, ${t.hostsUnreachable} do not, ${t.hosts - t.hostsReachable - t.hostsUnreachable} unknown`,
    `${t.verifiableNow} articles can be verified from here now`,
    '',
    'Verification queue:',
    ...report.articles
      .slice(0, limit)
      .map((a, i) => `${String(i + 1).padStart(3)}. [${a.priority}] ${a.path}: ${a.reasons.join('; ')}`),
  ];
  return lines.join('\n');
}

/** The librarian's task for grounding one article in its sources. */
export function verificationTask(a: ArticleAccuracy, today: string): string {
  const urls = a.citedUrls.slice(0, 8);
  return `Verify the vault article knowledge/${a.path} ("${a.title}") against its sources. Today is ${today}.
1. Read knowledge/AGENTS.md (the vault schema) and the article.
2. For each cited source${urls.length ? ` (${urls.join(', ')})` : ''}, check domain_status, then fetch it with web_fetch. Skip sources that do not answer and say which.
3. Save what you used from each source as a raw capture: knowledge/raw/${a.topic}/${today}-<source-slug>.md, starting with the URL and the fetch date, then the relevant passages quoted verbatim. Never edit a raw file after saving it.
4. Check every load-bearing claim (numbers, dates, names, defaults, limits, quotes) against the captures. Correct what is wrong. Mark what you cannot confirm with a "Status: Unverified" note instead of deleting it.
5. Update the metadata block: link the captures on the Raw line (replacing "none yet (seed article)") and set Updated to ${today}. Append a log entry to knowledge/wiki/log.md.
6. Finish with what you confirmed, what you corrected (old and new text) and what you could not confirm.`;
}

export interface LinkCheck {
  url: string;
  status: string;
  articles: string[];
}

/**
 * Check every cited URL once. `skip` names hosts known not to answer from here (they are
 * reported as unchecked, not broken); `probe` returns a reach status such as `ok` or `http-404`.
 */
export async function checkVaultLinks(
  vault: KnowledgeVault,
  opts: {
    probe: (url: string) => Promise<string>;
    skip?: (url: string) => string | null;
    concurrency?: number;
  },
): Promise<{ broken: LinkCheck[]; unchecked: LinkCheck[]; ok: number }> {
  const byUrl = new Map<string, Set<string>>();
  for (const a of await vault.articles())
    for (const url of extractUrls(a.body)) {
      const articles = byUrl.get(url) ?? new Set<string>();
      articles.add(a.path);
      byUrl.set(url, articles);
    }
  const urls = [...byUrl.keys()].sort();
  const results: LinkCheck[] = new Array(urls.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < urls.length; i = next++) {
      const url = urls[i]!;
      const skipped = opts.skip?.(url);
      const status = skipped ? 'unchecked' : await opts.probe(url);
      results[i] = { url, status, articles: [...byUrl.get(url)!].sort() };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 8) }, worker));
  const network = new Set(['unchecked', 'unreachable', 'timeout', 'blocked']);
  return {
    broken: results.filter((r) => r.status.startsWith('http-') && !/^http-(401|403|405|429)$/.test(r.status)),
    unchecked: results.filter((r) => network.has(r.status)),
    ok: results.filter((r) => r.status === 'ok' || /^http-(401|403|405|429)$/.test(r.status)).length,
  };
}
