import { gunzipSync } from 'node:zlib';
import { assertPublicUrl } from '../safety/net-guard';
import { ToolError } from '../util/errors';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import { computeBackoff, parseRetryAfter, sleep as defaultSleep } from '../util/retry';
import { HostRateLimiter } from './rate-limiter';
import { RobotsCache } from './robots';

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class RobotsDisallowedError extends Error {
  constructor(readonly url: string) {
    super(`robots.txt disallows ${url} for this user agent`);
    this.name = 'RobotsDisallowedError';
  }
}

export interface HttpGetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  minIntervalMs?: number;
  respectRobots?: boolean;
  etag?: string;
  lastModified?: string;
}

export interface HttpResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  notModified: boolean;
}

export interface PoliteHttpClientOptions {
  userAgent: string;
  fetch?: typeof fetch;
  limiter?: HostRateLimiter;
  robots?: RobotsCache;
  logger?: Logger;
  allowPrivateNetwork?: boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  maxBytes?: number;
  /** Told about every response and network failure (the domain registry listens here). */
  observe?: (url: string, outcome: { status?: number; error?: unknown }) => void;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Decode a body; `.gz` files (for example gzipped sitemaps) are gunzipped when they carry the gzip magic bytes. */
export function decodeBody(buf: Buffer, url: string): string {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b && /\.gz($|\?)/.test(url)) {
    return gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

/**
 * HTTP client for scrapers: honest User-Agent, robots.txt, per-host rate limiting, retries
 * with exponential backoff and full jitter (honoring Retry-After), conditional requests and
 * the SSRF guard on every redirect hop.
 */
export class PoliteHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: HostRateLimiter;
  readonly robots: RobotsCache;
  private readonly logger: Logger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PoliteHttpClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.limiter = opts.limiter ?? new HostRateLimiter();
    this.logger = opts.logger ?? silentLogger;
    this.sleep = opts.sleep ?? defaultSleep;
    this.robots =
      opts.robots ??
      new RobotsCache(async (url) => {
        const res = await this.rawGet(url, { timeoutMs: 10_000 });
        return { status: res.status, body: res.body };
      });
  }

  get userAgent(): string {
    return this.opts.userAgent;
  }

  private async rawGet(url: string, opts: HttpGetOptions): Promise<HttpResult> {
    let current = url;
    for (let hop = 0; hop < 6; hop++) {
      await assertPublicUrl(current, { allowPrivate: this.opts.allowPrivateNetwork });
      const headers: Record<string, string> = { 'user-agent': this.opts.userAgent, ...(opts.headers ?? {}) };
      if (opts.etag) headers['if-none-match'] = opts.etag;
      if (opts.lastModified) headers['if-modified-since'] = opts.lastModified;
      let res: Response;
      try {
        res = await this.fetchImpl(current, {
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
        });
      } catch (error) {
        this.opts.observe?.(current, { error });
        throw error;
      }
      this.opts.observe?.(current, { status: res.status });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && res.status !== 304 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k] = v));
      const text = res.status === 304 ? '' : decodeBody(Buffer.from(await res.arrayBuffer()), current);
      const max = this.opts.maxBytes ?? 20 * 1024 * 1024;
      return {
        url,
        finalUrl: current,
        status: res.status,
        headers: out,
        body: text.length > max ? text.slice(0, max) : text,
        notModified: res.status === 304,
      };
    }
    throw new HttpError(`too many redirects for ${url}`, 0, url);
  }

  async get(url: string, opts: HttpGetOptions = {}): Promise<HttpResult> {
    const host = new URL(url).host;
    if (opts.respectRobots !== false && !(await this.robots.isAllowed(url, this.opts.userAgent))) {
      throw new RobotsDisallowedError(url);
    }
    const crawlDelay =
      opts.respectRobots !== false ? await this.robots.crawlDelayMs(url, this.opts.userAgent) : undefined;
    const interval = Math.max(opts.minIntervalMs ?? 1_000, crawlDelay ?? 0);
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      let res: HttpResult | undefined;
      let error: unknown;
      try {
        res = await this.limiter.schedule(host, interval, () => this.rawGet(url, opts));
      } catch (err) {
        error = err;
      }
      if (res && (res.status < 400 || res.status === 304)) return res;
      const status = res?.status ?? 0;
      const retryable = error
        ? !(error instanceof HttpError) && !(error instanceof ToolError)
        : RETRYABLE.has(status);
      if (!retryable || attempt >= retries) {
        if (res) throw new HttpError(`HTTP ${status} for ${url}`, status, url);
        throw error;
      }
      const retryAfter = parseRetryAfter(res?.headers['retry-after']);
      const delay = Math.min(
        retryAfter ?? computeBackoff(attempt, { baseMs: 1_000, maxMs: 30_000 }, this.opts.random),
        120_000,
      );
      this.logger.warn('retrying request', { url, status, attempt, delay });
      await this.sleep(delay);
    }
  }
}
