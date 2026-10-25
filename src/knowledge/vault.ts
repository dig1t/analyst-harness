import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { KnowledgeSearchHit, KnowledgeService } from '../tools/types';
import { ensureDir, walkFiles } from '../util/fs';
import { parseFrontmatter } from '../util/frontmatter';
import { todayUtc } from '../util/ids';
import { slugify } from '../util/text';
import { Bm25Index, bestSnippet } from './bm25';

export interface Article {
  /** Vault-relative POSIX path, e.g. `wiki/http/cookies-and-sessions.md`. */
  path: string;
  topic: string;
  slug: string;
  title: string;
  tags: string[];
  aliases: string[];
  frontmatterKeys: string[];
  meta: Record<string, string>;
  body: string;
  links: string[];
  seed: boolean;
}

export interface LintIssue {
  severity: 'error' | 'warning';
  file: string;
  message: string;
}

export interface Lesson {
  title: string;
  context: string;
  lesson: string;
  evidence: string;
  tags?: string[];
  runId: string;
  date?: string;
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const SPECIAL = new Set(['index.md', 'log.md']);

export const TOPIC_DESCRIPTIONS: Record<string, string> = {
  fundamentals: 'What scraping is, how to choose an acquisition strategy, and the vocabulary.',
  http: 'The protocol layer: requests, headers, cookies, status codes, TLS, caching and auth.',
  parsing: 'Turning responses into data: HTML, selectors, embedded JSON, tables, PDFs, text cleanup.',
  'browser-automation': 'Headless browsers for JavaScript-heavy sites, and how to keep them cheap.',
  crawling: 'Crawling at scale: frontiers, normalization, deduplication, robots.txt, sitemaps, pagination.',
  apis: 'Official, open and undocumented APIs, GraphQL, real-time feeds and rate limits.',
  'anti-bot': 'How bot defenses work and how a responsible scraper responds to them.',
  'legal-ethics': 'Laws, cases, contracts, personal data and the ethics of scraping (not legal advice).',
  'data-quality': 'Cleaning, validation, deduplication, change detection, monitoring and testing.',
  storage: 'File formats and databases for scraped data, raw archives and data modeling.',
  operations: 'Running scrapers in production: scheduling, retries, monitoring, hosting, cost.',
  tools: 'The tooling landscape across languages, CLIs, services and DevTools.',
  'llm-scraping': 'Using LLMs to extract, validate and maintain scraped data, and AI crawler opt-outs.',
  sources: 'Playbooks for common source types: news, e-commerce, jobs, open data, finance, research.',
  harness: 'How this harness defines, schedules and learns from scrapers.',
  lessons: 'Lessons the harness learned from its own runs (machine written, advisory).',
};

function parseMeta(body: string): { title: string; meta: Record<string, string> } {
  const lines = body.split('\n');
  let title = '';
  const meta: Record<string, string> = {};
  let i = 0;
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('# ')) {
      title = line.slice(2).trim();
      i++;
      break;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) {
      if (Object.keys(meta).length) break;
      continue;
    }
    const m = /^>\s*([A-Za-z]+):\s*(.*)$/.exec(line);
    if (!m) break;
    meta[m[1]!] = m[2]!.trim();
  }
  return { title, meta };
}

/** Markdown without fenced blocks and inline code, so examples of syntax are not linted as usage. */
export function stripCode(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
}

const URL_RE = /https?:\/\/[^\s)\]>"'`,;|]+/g;

/** Absolute http(s) URLs in prose and links, outside code (code holds examples, not sources). */
export function extractUrls(body: string): string[] {
  return [...new Set([...stripCode(body).matchAll(URL_RE)].map((m) => m[0].replace(/[.:]+$/, '')))];
}

export function extractLinks(body: string): string[] {
  const out: string[] = [];
  for (const m of stripCode(body).matchAll(LINK_RE)) {
    const target = m[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    out.push(target.split('#')[0]!);
  }
  return out.filter(Boolean);
}

/** The Obsidian/LLM-wiki knowledge vault: parsing, search, lint, index and lessons. */
export class KnowledgeVault implements KnowledgeService {
  private cache?: { signature: string; articles: Article[]; index: Bm25Index };

  constructor(
    readonly dir: string,
    /** Workspace alias the vault is mounted under, used in returned paths. */
    readonly mountAlias = 'knowledge',
  ) {}

  get wikiDir(): string {
    return path.join(this.dir, 'wiki');
  }

  async articles(): Promise<Article[]> {
    return (await this.load()).articles;
  }

  /** Every external URL the wiki cites, grouped by host, with the articles that cite it. */
  async externalUrls(): Promise<Map<string, { urls: Set<string>; articles: Set<string> }>> {
    const byHost = new Map<string, { urls: Set<string>; articles: Set<string> }>();
    for (const a of await this.articles())
      for (const url of extractUrls(a.body)) {
        let host: string;
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          continue;
        }
        const entry = byHost.get(host) ?? { urls: new Set<string>(), articles: new Set<string>() };
        entry.urls.add(url);
        entry.articles.add(a.path);
        byHost.set(host, entry);
      }
    return byHost;
  }

  private async signature(files: string[]): Promise<string> {
    let latest = 0;
    for (const f of files) {
      const st = await fsp.stat(path.join(this.wikiDir, f)).catch(() => null);
      if (st && st.mtimeMs > latest) latest = st.mtimeMs;
    }
    return `${files.length}:${latest}`;
  }

  private async load(): Promise<{ articles: Article[]; index: Bm25Index }> {
    const files = (await walkFiles(this.wikiDir, (rel) => rel.startsWith('.'))).filter((f) =>
      f.endsWith('.md'),
    );
    const signature = await this.signature(files);
    if (this.cache?.signature === signature) return this.cache;
    const articles: Article[] = [];
    for (const rel of files) {
      if (SPECIAL.has(rel)) continue;
      const text = await fsp.readFile(path.join(this.wikiDir, rel), 'utf8');
      articles.push(this.parseArticle(`wiki/${rel}`, text));
    }
    const index = new Bm25Index(
      articles.map((a) => ({
        id: a.path,
        fields: [
          { text: a.title, weight: 4 },
          { text: [...a.aliases, ...a.tags].join(' '), weight: 3 },
          { text: a.body, weight: 1 },
        ],
      })),
    );
    this.cache = { signature, articles, index };
    return this.cache;
  }

  parseArticle(relPath: string, text: string): Article {
    let data: Record<string, unknown> = {};
    let body = text;
    try {
      const doc = parseFrontmatter(text);
      data = doc.data;
      body = doc.body;
    } catch {
      // Invalid YAML is reported by lint; treat the whole file as body.
    }
    const parts = relPath.split('/');
    const { title, meta } = parseMeta(body);
    const asList = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);
    return {
      path: relPath,
      topic: parts.length >= 3 ? parts[1]! : '',
      slug: path.posix.basename(relPath, '.md'),
      title,
      tags: asList(data.tags),
      aliases: asList(data.aliases),
      frontmatterKeys: Object.keys(data),
      meta,
      body,
      links: extractLinks(body),
      seed: /none yet/i.test(meta.Raw ?? ''),
    };
  }

  async search(query: string, opts: { limit?: number; topic?: string } = {}): Promise<KnowledgeSearchHit[]> {
    const { articles, index } = await this.load();
    const byPath = new Map(articles.map((a) => [a.path, a]));
    const raw = index.search(query, Math.max(50, (opts.limit ?? 5) * 5));
    const hits: KnowledgeSearchHit[] = [];
    for (const r of raw) {
      const a = byPath.get(r.id)!;
      if (opts.topic && a.topic !== opts.topic) continue;
      hits.push({
        path: `${this.mountAlias}/${a.path}`,
        title: a.title || a.slug,
        score: r.score,
        snippet: bestSnippet(a.body, query),
      });
      if (hits.length >= (opts.limit ?? 5)) break;
    }
    return hits;
  }

  // ----- lint -----

  async lint(opts: { checkIndex?: boolean } = {}): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    const articles = await this.articles();
    const allFiles = new Set((await walkFiles(this.dir, (rel) => rel.startsWith('.'))).map((f) => f));
    const inbound = new Map<string, number>();
    for (const a of articles) {
      const file = a.path;
      const raw = await fsp.readFile(path.join(this.dir, file), 'utf8');
      if (a.path.split('/').length > 3)
        issues.push({ severity: 'error', file, message: 'nested topic folder (only one level is allowed)' });
      if (!/^[a-z0-9]+(-[a-z0-9]+)*\.md$/.test(path.posix.basename(file)))
        issues.push({ severity: 'warning', file, message: 'file name is not kebab-case' });
      if (!a.title) issues.push({ severity: 'error', file, message: 'missing H1 title' });
      for (const key of ['Sources', 'Raw', 'Updated']) {
        if (!a.meta[key] && !(key === 'Raw' && a.meta.Archived))
          issues.push({ severity: 'error', file, message: `missing "> ${key}:" metadata line` });
      }
      if (a.meta.Updated && !/^\d{4}-\d{2}-\d{2}$/.test(a.meta.Updated))
        issues.push({ severity: 'warning', file, message: `Updated is not YYYY-MM-DD: ${a.meta.Updated}` });
      if (raw.includes('\u2014'))
        issues.push({ severity: 'error', file, message: 'contains an em dash (U+2014)' });
      if (raw.includes('\u2013'))
        issues.push({ severity: 'warning', file, message: 'contains an en dash (U+2013)' });
      if (/\[\[[^\]]+\]\]/.test(stripCode(raw)))
        issues.push({ severity: 'error', file, message: 'uses [[wikilinks]]; use relative Markdown links' });
      const extraKeys = a.frontmatterKeys.filter((k) => k !== 'tags' && k !== 'aliases');
      if (extraKeys.length)
        issues.push({
          severity: 'warning',
          file,
          message: `frontmatter keys other than tags/aliases: ${extraKeys.join(', ')}`,
        });
      if (!/^## See Also\s*$/m.test(a.body))
        issues.push({ severity: 'warning', file, message: 'missing "## See Also" section' });
      for (const link of a.links) {
        const target = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), decodeURIComponent(link)),
        );
        if (!allFiles.has(target)) issues.push({ severity: 'error', file, message: `broken link: ${link}` });
        else inbound.set(target, (inbound.get(target) ?? 0) + 1);
      }
    }
    for (const a of articles) {
      if (a.topic !== 'lessons' && !inbound.get(a.path))
        issues.push({
          severity: 'warning',
          file: a.path,
          message: 'orphan: no inbound links from other articles',
        });
    }
    if (opts.checkIndex !== false) issues.push(...(await this.lintIndex(articles)));
    return issues;
  }

  private async lintIndex(articles: Article[]): Promise<LintIssue[]> {
    const issues: LintIssue[] = [];
    let text: string;
    try {
      text = await fsp.readFile(path.join(this.wikiDir, 'index.md'), 'utf8');
    } catch {
      return [{ severity: 'error', file: 'wiki/index.md', message: 'index.md is missing' }];
    }
    const listed = new Set(extractLinks(text).map((l) => `wiki/${path.posix.normalize(l)}`));
    for (const a of articles)
      if (!listed.has(a.path))
        issues.push({ severity: 'error', file: 'wiki/index.md', message: `article not in index: ${a.path}` });
    const known = new Set(articles.map((a) => a.path));
    for (const l of listed)
      if (!known.has(l))
        issues.push({
          severity: 'error',
          file: 'wiki/index.md',
          message: `index entry points to a missing article: ${l}`,
        });
    return issues;
  }

  // ----- index and log -----

  static summarize(article: Article): string {
    const overview = /## Overview\s*\n+([\s\S]*?)(\n## |\n*$)/.exec(article.body)?.[1] ?? article.body;
    const plain = overview.replace(LINK_RE, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
    const sentence = /^(.{20,260}?[.!?])(\s|$)/.exec(plain)?.[1] ?? plain.slice(0, 200);
    return sentence.replace(/\|/g, '/');
  }

  async buildIndex(
    summaries: Record<string, string> = {},
    order: string[] = Object.keys(TOPIC_DESCRIPTIONS),
  ): Promise<string> {
    const articles = await this.articles();
    const topics = [...new Set([...order, ...articles.map((a) => a.topic)])].filter((t) =>
      articles.some((a) => a.topic === t),
    );
    const out = ['# Knowledge Base Index', ''];
    for (const topic of topics) {
      out.push(
        `## ${topic}`,
        '',
        TOPIC_DESCRIPTIONS[topic] ?? '',
        '',
        '| Article | Summary | Updated |',
        '|---------|---------|---------|',
      );
      for (const a of articles
        .filter((x) => x.topic === topic)
        .sort((x, y) => x.title.localeCompare(y.title))) {
        const rel = a.path.replace(/^wiki\//, '');
        const summary = summaries[rel] ?? summaries[a.path] ?? KnowledgeVault.summarize(a);
        out.push(
          `| [${a.title.replace(/\|/g, '/')}](${rel}) | ${summary.replace(/\|/g, '/')} | ${a.meta.Updated ?? ''} |`,
        );
      }
      out.push('');
    }
    return out.join('\n');
  }

  async writeIndex(summaries?: Record<string, string>): Promise<void> {
    await fsp.writeFile(path.join(this.wikiDir, 'index.md'), await this.buildIndex(summaries), 'utf8');
    this.cache = undefined;
  }

  /** Insert or update one index row without regenerating hand-written summaries. */
  async upsertIndexRow(
    topic: string,
    relPath: string,
    title: string,
    summary: string,
    updated: string,
  ): Promise<void> {
    const file = path.join(this.wikiDir, 'index.md');
    let text: string;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      text = '# Knowledge Base Index\n';
    }
    const row = `| [${title.replace(/\|/g, '/')}](${relPath}) | ${summary.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()} | ${updated} |`;
    const lines = text.split('\n');
    const existing = lines.findIndex((l) => l.includes(`](${relPath})`));
    if (existing >= 0) {
      lines[existing] = row;
    } else {
      const heading = lines.findIndex((l) => l.trim() === `## ${topic}`);
      if (heading < 0) {
        lines.push(
          '',
          `## ${topic}`,
          '',
          TOPIC_DESCRIPTIONS[topic] ?? '',
          '',
          '| Article | Summary | Updated |',
          '|---------|---------|---------|',
          row,
        );
      } else {
        let insertAt = heading + 1;
        while (insertAt < lines.length && !lines[insertAt]!.startsWith('## ')) insertAt++;
        while (insertAt > heading + 1 && lines[insertAt - 1]!.trim() === '') insertAt--;
        lines.splice(insertAt, 0, row);
      }
    }
    await fsp.writeFile(file, lines.join('\n').replace(/\n*$/, '\n'), 'utf8');
  }

  async appendLog(heading: string, lines: string[] = [], date = todayUtc()): Promise<void> {
    const file = path.join(this.wikiDir, 'log.md');
    let existing: string;
    try {
      existing = await fsp.readFile(file, 'utf8');
    } catch {
      existing = '# Wiki Log\n';
    }
    const entry = `\n## [${date}] ${heading}\n${lines.map((l) => `- ${l}`).join('\n')}${lines.length ? '\n' : ''}`;
    await fsp.writeFile(file, existing.replace(/\n*$/, '\n') + entry, 'utf8');
  }

  // ----- lessons -----

  async writeLesson(lesson: Lesson): Promise<{ path: string; created: boolean }> {
    const date = lesson.date ?? todayUtc();
    const dir = path.join(this.wikiDir, 'lessons');
    await ensureDir(dir);
    const slug = slugify(lesson.title, 60);
    const rel = `wiki/lessons/${slug}.md`;
    const abs = path.join(this.dir, rel);
    const clean = (s: string) =>
      s
        .replace(/\u2014/g, ',')
        .replace(/\u2013/g, '-')
        .trim();
    let created = false;
    try {
      const existing = await fsp.readFile(abs, 'utf8');
      const addition = `\n- Confirmed again by run ${lesson.runId} (${date}): ${clean(lesson.evidence)}`;
      const updated = existing.replace(
        /(## Evidence\n[\s\S]*?)(\n## See Also|$)/,
        (_m, ev: string, tail: string) => `${ev.trimEnd()}${addition}\n${tail}`,
      );
      await fsp.writeFile(abs, updated.replace(/> Updated: \d{4}-\d{2}-\d{2}/, `> Updated: ${date}`), 'utf8');
    } catch {
      created = true;
      const tags = ['scraping', 'lessons', ...(lesson.tags ?? []).map((t) => slugify(t, 30))]
        .filter((t, i, a) => a.indexOf(t) === i)
        .slice(0, 6);
      const text = [
        '---',
        `tags: [${tags.join(', ')}]`,
        '---',
        '',
        `# Lesson: ${clean(lesson.title)}`,
        '',
        `> Sources: harness run ${lesson.runId}`,
        '> Raw: none yet (harness lesson)',
        `> Updated: ${date}`,
        '',
        '## Context',
        '',
        clean(lesson.context),
        '',
        '## Lesson',
        '',
        clean(lesson.lesson),
        '',
        '## Evidence',
        '',
        `- Run ${lesson.runId} (${date}): ${clean(lesson.evidence)}`,
        '',
        '## See Also',
        '',
        '- [How the Agents Use and Grow This Vault](../harness/harness-knowledge-workflow.md)',
        '',
      ].join('\n');
      await fsp.writeFile(abs, text, 'utf8');
    }
    this.cache = undefined;
    return { path: rel, created };
  }
}
