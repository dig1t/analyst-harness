import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import type { HttpGetOptions, HttpResult, PoliteHttpClient } from './http-client';
import type { FieldRule, ScraperSpec } from './spec';

export type RawRecord = Record<string, unknown>;

export interface ExtractResult {
  records: RawRecord[];
  pages: number;
  notModified: boolean;
  validators?: { etag?: string; lastModified?: string };
}

export interface ExtractContext {
  http: Pick<PoliteHttpClient, 'get'>;
  validators?: { etag?: string; lastModified?: string };
}

export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path || path === '$') return obj;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(part)) cur = cur[Number(part)];
    else if (typeof cur === 'object') cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

function fetchOpts(spec: ScraperSpec, extra: Partial<HttpGetOptions> = {}): HttpGetOptions {
  return {
    headers: spec.fetch.headers,
    timeoutMs: spec.fetch.timeoutMs,
    retries: spec.fetch.retries,
    minIntervalMs: spec.fetch.minIntervalMs,
    respectRobots: spec.fetch.respectRobots,
    ...extra,
  };
}

function validatorsOf(res: HttpResult) {
  return { etag: res.headers['etag'], lastModified: res.headers['last-modified'] };
}

function conditional(spec: ScraperSpec, ctx: ExtractContext): Partial<HttpGetOptions> {
  return spec.fetch.conditional && ctx.validators
    ? { etag: ctx.validators.etag, lastModified: ctx.validators.lastModified }
    : {};
}

function parseJson(res: HttpResult): unknown {
  try {
    return JSON.parse(res.body);
  } catch {
    throw new Error(`response from ${res.finalUrl} is not valid JSON`);
  }
}

function fillTemplate(template: string, item: unknown): string {
  return template.replace(/\{item(?:\.([\w.]+))?\}/g, (_m, p: string | undefined) =>
    encodeURIComponent(String(p ? getPath(item, p) : item)),
  );
}

export async function extractJsonSource(
  spec: ScraperSpec & { source: { type: 'json' } },
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const src = spec.source;
  const res = await ctx.http.get(src.url, fetchOpts(spec, conditional(spec, ctx)));
  if (res.notModified) return { records: [], pages: 1, notModified: true, validators: ctx.validators };
  const root = getPath(parseJson(res), src.items);
  let items: unknown[];
  if (src.entries) {
    if (!root || typeof root !== 'object' || Array.isArray(root))
      throw new Error(`"${src.items}" is not an object, cannot use entries`);
    items = Object.entries(root as Record<string, unknown>).map(([key, value]) => ({ key, value }));
  } else {
    if (!Array.isArray(root))
      throw new Error(`"${src.items || '(root)'}" is not an array in the response from ${res.finalUrl}`);
    items = root;
  }
  if (src.limit) items = items.slice(0, src.limit);
  let pages = 1;
  if (src.expand) {
    const expanded: unknown[] = [];
    for (const item of items.slice(0, src.expand.limit)) {
      const r = await ctx.http.get(fillTemplate(src.expand.url, item), fetchOpts(spec));
      pages++;
      const value = parseJson(r);
      if (value !== null && value !== undefined) expanded.push(value);
    }
    items = expanded;
  }
  const records = items.map((item) =>
    mapFields(item, spec.fields, (rule) => getPath(item, rule.path), src.url),
  );
  return { records, pages, notModified: false, validators: validatorsOf(res) };
}

export async function extractHtmlSource(
  spec: ScraperSpec & { source: { type: 'html' } },
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const src = spec.source;
  const records: RawRecord[] = [];
  let url: string | undefined = src.url;
  let pages = 0;
  let firstValidators: ExtractResult['validators'];
  const maxPages = src.next?.maxPages ?? 1;
  const seen = new Set<string>();
  while (url && pages < maxPages && !seen.has(url)) {
    seen.add(url);
    const res = await ctx.http.get(url, fetchOpts(spec, pages === 0 ? conditional(spec, ctx) : {}));
    if (pages === 0) {
      if (res.notModified) return { records: [], pages: 1, notModified: true, validators: ctx.validators };
      firstValidators = validatorsOf(res);
    }
    pages++;
    const $ = cheerio.load(res.body);
    const pageUrl = res.finalUrl;
    $(src.itemSelector).each((_i, el) => {
      const item = $(el);
      if (Object.keys(spec.fields).length === 0) {
        const href = item.is('a') ? item.attr('href') : item.find('a').first().attr('href');
        records.push({
          text: item.text().replace(/\s+/g, ' ').trim(),
          href: href ? new URL(href, pageUrl).toString() : null,
        });
        return;
      }
      records.push(
        mapFields(
          item,
          spec.fields,
          (rule) => {
            const target = rule.selector ? item.find(rule.selector) : item;
            const read = (node: ReturnType<typeof item.first>) =>
              rule.attr ? node.attr(rule.attr) : node.text();
            if (rule.all) return target.toArray().map((n) => read($(n)));
            return target.length ? read(target.first()) : undefined;
          },
          pageUrl,
        ),
      );
    });
    const nextHref = src.next ? $(src.next.selector).first().attr(src.next.attr) : undefined;
    url = nextHref ? new URL(nextHref, pageUrl).toString() : undefined;
    if (src.limit && records.length >= src.limit) break;
  }
  return {
    records: src.limit ? records.slice(0, src.limit) : records,
    pages,
    notModified: false,
    validators: firstValidators,
  };
}

/** fast-xml-parser output is untyped; feeds vary too much to model precisely. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type XmlNode = Record<string, any>;

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: true,
});

function textValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return textValue(v[0]);
  if (typeof v === 'object') return textValue((v as Record<string, unknown>)['#text']);
  return undefined;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

/** Normalize RSS 2.0 / RSS 1.0 / Atom items to {id, title, link, published, summary, author, categories}. */
export function parseFeed(body: string): RawRecord[] {
  const doc = xml.parse(body) as XmlNode;
  if (doc.rss?.channel || doc['rdf:RDF']) {
    const items = asArray(doc.rss?.channel?.item ?? doc['rdf:RDF']?.item);
    return items.map((it: Record<string, unknown>) => ({
      id: textValue(it.guid) ?? textValue(it.link),
      title: textValue(it.title),
      link: textValue(it.link),
      published: textValue(it.pubDate) ?? textValue(it['dc:date']),
      summary: textValue(it.description),
      author: textValue(it.author) ?? textValue(it['dc:creator']),
      categories: asArray(it.category as unknown)
        .map(textValue)
        .filter(Boolean),
      raw: it,
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((e: XmlNode) => {
      const links = asArray(e.link) as Array<Record<string, string>>;
      const link =
        links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href'] ?? links[0]?.['@_href'];
      return {
        id: textValue(e.id),
        title: textValue(e.title)?.replace(/\s+/g, ' ').trim(),
        link,
        published: textValue(e.published) ?? textValue(e.updated),
        summary: textValue(e.summary) ?? textValue(e.content),
        author:
          asArray(e.author as unknown)
            .map((a) => textValue((a as Record<string, unknown>)?.name))
            .filter(Boolean)
            .join(', ') || undefined,
        categories: asArray(e.category as unknown)
          .map((c) => (c as Record<string, string>)?.['@_term'])
          .filter(Boolean),
        raw: e,
      };
    });
  }
  throw new Error('not an RSS or Atom feed');
}

export async function extractRssSource(
  spec: ScraperSpec & { source: { type: 'rss' } },
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const res = await ctx.http.get(spec.source.url, fetchOpts(spec, conditional(spec, ctx)));
  if (res.notModified) return { records: [], pages: 1, notModified: true, validators: ctx.validators };
  const items = parseFeed(res.body).slice(0, spec.source.limit);
  const hasFields = Object.keys(spec.fields).length > 0;
  const records = items.map((item) => {
    if (!hasFields) {
      const { raw: _raw, ...rest } = item;
      return rest;
    }
    return mapFields(item, spec.fields, (rule) => getPath(item, rule.path), spec.source.url);
  });
  return { records, pages: 1, notModified: false, validators: validatorsOf(res) };
}

export function parseSitemap(body: string): {
  urls: Array<{ loc: string; lastmod?: string }>;
  sitemaps: string[];
} {
  const doc = xml.parse(body) as XmlNode;
  const urls = asArray(doc.urlset?.url).map((u: Record<string, unknown>) => ({
    loc: String(textValue(u.loc) ?? '').trim(),
    lastmod: textValue(u.lastmod),
  }));
  const sitemaps = asArray(doc.sitemapindex?.sitemap).map((s: Record<string, unknown>) =>
    String(textValue(s.loc) ?? '').trim(),
  );
  return { urls: urls.filter((u) => u.loc), sitemaps: sitemaps.filter(Boolean) };
}

export async function extractSitemapSource(
  spec: ScraperSpec & { source: { type: 'sitemap' } },
  ctx: ExtractContext,
): Promise<ExtractResult> {
  const src = spec.source;
  const include = src.include ? new RegExp(src.include) : undefined;
  const queue = [src.url];
  const seen = new Set<string>();
  const records: RawRecord[] = [];
  let pages = 0;
  while (queue.length && records.length < src.limit && pages < 50) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await ctx.http.get(url, fetchOpts(spec));
    pages++;
    const parsed = parseSitemap(res.body);
    if (src.followIndex) queue.push(...parsed.sitemaps);
    for (const u of parsed.urls) {
      if (include && !include.test(u.loc)) continue;
      records.push({ url: u.loc, lastmod: u.lastmod });
      if (records.length >= src.limit) break;
    }
  }
  return { records, pages, notModified: false };
}

function applyRule(value: unknown, rule: FieldRule, baseUrl: string): unknown {
  let v = value;
  if (Array.isArray(v)) return v.map((x) => applyRule(x, { ...rule, all: false }, baseUrl));
  if (typeof v === 'string' && rule.regex) {
    const m = new RegExp(rule.regex).exec(v);
    v = m ? (m[1] ?? m[0]) : undefined;
  }
  for (const t of rule.transform) {
    if (typeof v !== 'string') break;
    switch (t) {
      case 'trim':
        v = (v as string).trim();
        break;
      case 'collapseWhitespace':
        v = (v as string).replace(/\s+/g, ' ').trim();
        break;
      case 'lowercase':
        v = (v as string).toLowerCase();
        break;
      case 'uppercase':
        v = (v as string).toUpperCase();
        break;
      case 'stripTags':
        v = cheerio.load(v as string).text();
        break;
      case 'number':
        v = (v as string).replace(/[^0-9.eE+-]/g, '');
        break;
      case 'absoluteUrl':
        try {
          v = new URL(v as string, baseUrl).toString();
        } catch {
          // leave as is; type validation reports it
        }
        break;
    }
  }
  return v;
}

/** Extract every configured field with `read`, then apply regex and transforms. */
export function mapFields(
  item: unknown,
  fields: Record<string, FieldRule>,
  read: (rule: FieldRule) => unknown,
  baseUrl: string,
): RawRecord {
  const names = Object.keys(fields);
  if (names.length === 0)
    return item && typeof item === 'object' && !Array.isArray(item) ? (item as RawRecord) : { value: item };
  const out: RawRecord = {};
  for (const name of names) {
    const rule = fields[name]!;
    out[name] = applyRule(read(rule), rule, baseUrl);
  }
  return out;
}

export async function extract(spec: ScraperSpec, ctx: ExtractContext): Promise<ExtractResult> {
  switch (spec.source.type) {
    case 'json':
      return extractJsonSource(spec as ScraperSpec & { source: { type: 'json' } }, ctx);
    case 'html':
      return extractHtmlSource(spec as ScraperSpec & { source: { type: 'html' } }, ctx);
    case 'rss':
      return extractRssSource(spec as ScraperSpec & { source: { type: 'rss' } }, ctx);
    case 'sitemap':
      return extractSitemapSource(spec as ScraperSpec & { source: { type: 'sitemap' } }, ctx);
  }
}
