import { assertPublicUrl } from '../safety/net-guard';
import type { FetchOutcome } from './domains';

export interface ProbeResult extends FetchOutcome {
  url: string;
  finalUrl: string;
  ms: number;
}

/**
 * One GET with manual redirects (each hop passes the SSRF guard), reading no more than the
 * headers: enough to tell whether a host answers from this environment.
 */
export async function probeUrl(
  url: string,
  opts: { userAgent: string; fetch?: typeof fetch; timeoutMs?: number; allowPrivate?: boolean },
): Promise<ProbeResult> {
  const doFetch = opts.fetch ?? fetch;
  const started = Date.now();
  let current = url;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      await assertPublicUrl(current, { allowPrivate: opts.allowPrivate });
      const res = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        // Some sites (single-page apps such as crates.io) answer 404 unless asked for HTML.
        headers: {
          'user-agent': opts.userAgent,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      await res.body?.cancel().catch(() => undefined);
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        current = new URL(location, current).toString();
        continue;
      }
      return { url, finalUrl: current, status: res.status, ms: Date.now() - started };
    }
    return { url, finalUrl: current, error: new Error('too many redirects'), ms: Date.now() - started };
  } catch (error) {
    return { url, finalUrl: current, error, ms: Date.now() - started };
  }
}
