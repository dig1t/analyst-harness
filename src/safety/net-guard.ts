import { lookup as dnsLookup } from 'node:dns/promises';
import net from 'node:net';
import { ToolError } from '../util/errors';

export interface NetGuardOptions {
  /** Allow loopback and private ranges (local development only). */
  allowPrivate?: boolean;
  /** Hostnames that skip the address check. */
  allowHosts?: string[];
  lookup?: (host: string) => Promise<Array<{ address: string; family: number }>>;
}

const defaultLookup = async (host: string) => dnsLookup(host, { all: true, verbatim: true });

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inCidr4(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved and metadata addresses. */
export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const blocks: Array<[string, number]> = [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ];
    return blocks.some(([base, bits]) => inCidr4(address, base, bits));
  }
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd)/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
  }
  return true;
}

/**
 * Reject URLs that would let a remotely-controlled agent reach internal services (SSRF):
 * cloud metadata endpoints, localhost admin ports, the Docker network. Checks the scheme and
 * every resolved address. Call it again on each redirect hop.
 */
export async function assertPublicUrl(rawUrl: string, opts: NetGuardOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ToolError(`Invalid URL: ${rawUrl}`, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ToolError(`Only http:// and https:// URLs are allowed, got ${url.protocol}`, 'invalid_url');
  }
  if (opts.allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (opts.allowHosts?.includes(host)) return url;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new ToolError(`Refusing to fetch internal host ${host}.`, 'blocked_host');
  }
  const addresses = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await (opts.lookup ?? defaultLookup)(host);
  if (addresses.length === 0) throw new ToolError(`Could not resolve ${host}.`, 'dns_error');
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new ToolError(
        `Refusing to fetch ${host}: it resolves to a private or reserved address.`,
        'blocked_host',
      );
    }
  }
  return url;
}
