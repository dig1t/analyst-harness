import { promises as fsp } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { ConfigError } from '../util/errors';

export const TRANSFORMS = [
  'trim',
  'collapseWhitespace',
  'lowercase',
  'uppercase',
  'number',
  'absoluteUrl',
  'stripTags',
] as const;

export const FieldRuleSchema = z
  .object({
    /**
     * JSON and XML: dot path inside the item (`a.b.0.c`, XML attributes as `@name`); `$parent.`
     * and `$root.` read from the enclosing element or the whole document. RSS: item key. CSV:
     * the column name.
     */
    path: z.string().optional(),
    /** HTML: CSS selector relative to the item element (empty string = the item itself). */
    selector: z.string().optional(),
    /** HTML: attribute to read instead of text. */
    attr: z.string().optional(),
    /** HTML: collect every match as an array. */
    all: z.boolean().optional(),
    /** `date` keeps date and time (ISO 8601 UTC); `day` keeps the calendar day (YYYY-MM-DD). */
    type: z.enum(['string', 'number', 'integer', 'boolean', 'url', 'date', 'day', 'json']).default('string'),
    required: z.boolean().default(false),
    transform: z.array(z.enum(TRANSFORMS)).default([]),
    /** Keep the first capture group of this regex. */
    regex: z.string().optional(),
    default: z.unknown().optional(),
  })
  .strict();

export type FieldRule = z.infer<typeof FieldRuleSchema>;

const FetchSchema = z
  .object({
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
    retries: z.number().int().min(0).max(8).default(3),
    minIntervalMs: z.number().int().min(0).max(600_000).default(1_000),
    respectRobots: z.boolean().default(true),
    conditional: z.boolean().default(true),
  })
  .strict();

const SourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('json'),
      url: z.string().url(),
      /** Dot path to the array of items; empty for the root. */
      items: z.string().default(''),
      /** Turn an object map at `items` into [{key, value}] records. */
      entries: z.boolean().default(false),
      /** Fetch each item from a URL template (`{item}` is the item value, `{item.id}` a field). */
      expand: z
        .object({ url: z.string(), limit: z.number().int().min(1).max(1000).default(30) })
        .strict()
        .optional(),
      limit: z.number().int().min(1).max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('html'),
      url: z.string().url(),
      itemSelector: z.string().min(1),
      next: z
        .object({
          selector: z.string().min(1),
          attr: z.string().default('href'),
          maxPages: z.number().int().min(1).max(500).default(5),
        })
        .strict()
        .optional(),
      limit: z.number().int().min(1).max(100_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('rss'),
      url: z.string().url(),
      limit: z.number().int().min(1).max(10_000).default(100),
    })
    .strict(),
  z
    .object({
      type: z.literal('xml'),
      url: z.string().url(),
      /** Dot path to the repeated element; arrays along the way are flattened. */
      items: z.string().min(1),
      /** Drop namespace prefixes (`gesmes:Envelope` becomes `Envelope`). */
      stripNamespaces: z.boolean().default(true),
      limit: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('csv'),
      url: z.string().url(),
      delimiter: z.string().length(1).default(','),
      /** The first row names the columns (otherwise column_1, column_2, ...). */
      header: z.boolean().default(true),
      skipRows: z.number().int().min(0).max(1000).default(0),
      limit: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('sitemap'),
      url: z.string().url(),
      include: z.string().optional(),
      followIndex: z.boolean().default(true),
      limit: z.number().int().min(1).max(100_000).default(1_000),
    })
    .strict(),
]);

export const ScraperSpecSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    description: z.string().default(''),
    enabled: z.boolean().default(true),
    schedule: z.string().optional(),
    timezone: z.string().default('UTC'),
    source: SourceSchema,
    fields: z.record(z.string(), FieldRuleSchema).default({}),
    /** Field, or fields, that identify the same record across runs (default: content hash). */
    key: z.union([z.string(), z.array(z.string()).min(1).max(8)]).optional(),
    validation: z
      .object({
        minItems: z.number().int().min(0).default(1),
        maxInvalidRatio: z.number().min(0).max(1).default(0.2),
      })
      .strict()
      .default({ minItems: 1, maxInvalidRatio: 0.2 }),
    output: z
      .object({
        dataset: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-_]{0,63}$/)
          .optional(),
        mode: z.enum(['new', 'changed', 'all']).default('changed'),
      })
      .strict()
      .default({ mode: 'changed' }),
    notify: z
      .object({
        onNew: z.boolean().default(false),
        onFailure: z.boolean().default(true),
        alertAfterFailures: z.number().int().min(1).default(2),
      })
      .strict()
      .default({ onNew: false, onFailure: true, alertAfterFailures: 2 }),
    fetch: FetchSchema.default({
      headers: {},
      timeoutMs: 20_000,
      retries: 3,
      minIntervalMs: 1_000,
      respectRobots: true,
      conditional: true,
    }),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const fields = Object.keys(spec.fields);
    const keys = spec.key === undefined ? [] : Array.isArray(spec.key) ? spec.key : [spec.key];
    if (fields.length === 0) return;
    for (const k of keys)
      if (!fields.includes(k))
        ctx.addIssue({ code: 'custom', path: ['key'], message: `key "${k}" is not one of the fields` });
  });

export type ScraperSpec = z.infer<typeof ScraperSpecSchema>;
export type ScraperSpecInput = z.input<typeof ScraperSpecSchema>;

export function parseScraperSpec(input: unknown, source = 'spec'): ScraperSpec {
  const parsed = ScraperSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid scraper spec ${source}: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

export async function loadScraperSpecs(dir: string): Promise<ScraperSpec[]> {
  let files: string[];
  try {
    files = (await fsp.readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  } catch {
    return [];
  }
  const specs: ScraperSpec[] = [];
  const names = new Set<string>();
  for (const f of files) {
    const full = path.join(dir, f);
    let doc: unknown;
    try {
      doc = YAML.parse(await fsp.readFile(full, 'utf8'));
    } catch (err) {
      throw new ConfigError(`Invalid YAML in ${full}: ${(err as Error).message}`);
    }
    const spec = parseScraperSpec(doc, full);
    if (names.has(spec.name)) throw new ConfigError(`Duplicate scraper name ${spec.name} in ${full}`);
    names.add(spec.name);
    specs.push(spec);
  }
  return specs;
}
