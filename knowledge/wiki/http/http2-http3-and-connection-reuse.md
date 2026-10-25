---
tags: [scraping, http, http2, http3, connection-pooling]
aliases: [HTTP/2, HTTP/3, QUIC, Keep-alive, Connection pooling, Multiplexing]
---

# HTTP/2, HTTP/3 and Connection Reuse

> Sources: RFC 9112, HTTP/1.1, section 9 (connection management) (https://www.rfc-editor.org/rfc/rfc9112); RFC 9113, HTTP/2 (https://www.rfc-editor.org/rfc/rfc9113); RFC 9114, HTTP/3 (https://www.rfc-editor.org/rfc/rfc9114); RFC 9000, QUIC (https://www.rfc-editor.org/rfc/rfc9000); RFC 7838, HTTP Alternative Services (https://www.rfc-editor.org/rfc/rfc7838); RFC 9460, SVCB and HTTPS DNS records (https://www.rfc-editor.org/rfc/rfc9460); Ilya Grigorik, High Performance Browser Networking, O'Reilly (https://hpbn.co/); MDN, Connection management in HTTP/1.x (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Connection_management_in_HTTP_1.x); undici Client documentation (https://undici.nodejs.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

For small requests, setting up a connection (DNS, TCP, TLS) costs more than the request itself, so reusing connections is the cheapest performance win in scraping and also the politest one: fewer handshakes for the server to pay for. HTTP/1.1 reuses a connection for sequential requests (keep-alive); HTTP/2 multiplexes many concurrent requests over one TCP connection; HTTP/3 does the same over QUIC on UDP and removes TCP head-of-line blocking. In practice: keep one long-lived client per site with a bounded pool, cap concurrency per host, enable HTTP/2 where your client supports it and measure, and treat HTTP/3 as optional. Multiplexing lowers the cost per request; it does not raise how many requests a site should receive.

## What a new connection costs

With a round-trip time (RTT) of 100 ms, a cold HTTPS request spends roughly one RTT on the TCP handshake and one on a TLS 1.3 handshake (two for TLS 1.2) before the request can even be sent. A request on a warm, reused connection skips all of that. Across thousands of pages, connection reuse cuts wall time severalfold and removes the same number of handshakes from the server's load. TLS session resumption shortens repeat handshakes, and 0-RTT "early data" can remove one more round trip at the cost of replay risk (servers may answer 425 Too Early).

## HTTP/1.1: keep-alive and pools

- Connections are persistent by default in HTTP/1.1 (RFC 9112, section 9.3); `Connection: close` ends them.
- Only one request is in flight per connection. Pipelining is defined but effectively unused, so parallelism means several connections.
- RFC 9112 (section 9.4) asks clients to be conservative with simultaneous connections and warns that servers may treat many connections from one client as abuse.
- Servers close idle connections after their own timeout. A pooled connection can be dead when you reuse it, so expect an occasional reset and retry idempotent requests once.

Library pools: requests (urllib3) keeps up to 10 connections per host by default (`HTTPAdapter(pool_maxsize=10)`); httpx allows 100 connections in total, keeps 20 idle ones and expires idle connections after 5 seconds (`httpx.Limits`).

## HTTP/2: one connection, many streams

| Feature | What it means for a scraper |
|---|---|
| Binary framing and streams | Many requests in flight on one TCP connection |
| HPACK header compression | Repeated headers (cookies, user agent) cost little |
| `SETTINGS_MAX_CONCURRENT_STREAMS` | The server caps your parallel streams per connection |
| ALPN `h2` over TLS | Negotiated during the TLS handshake; nothing to configure on the URL |
| Connection coalescing | One connection may serve several host names covered by the same certificate and IP (RFC 9113, section 9.1.1); a 421 means "not this connection" |
| GOAWAY | Graceful shutdown; finish in-flight streams and reconnect |

RFC 9113 (section 9.1) says clients SHOULD NOT open more than one HTTP/2 connection to a given host and port. It also deprecates the old cleartext upgrade to `h2c`; HTTP/2 without TLS only works with prior knowledge. HTTP/2 still runs on TCP, so one lost packet stalls every stream on the connection (TCP head-of-line blocking).

```python
import ssl

import httpx  # pip install "httpx[http2]"

ctx = ssl.create_default_context(cafile="corp-root-ca.pem")  # or omit verify= for the default store
with httpx.Client(http2=True, verify=ctx, timeout=15.0) as client:
    r = client.get("https://h2.example.com/")
    print(r.http_version, r.text)  # HTTP/2 when the server offers h2 in ALPN, else HTTP/1.1
```

Without the `h2` package, `httpx.Client(http2=True)` raises an `ImportError` that tells you to install `httpx[http2]`. Always log `r.http_version` instead of assuming.

A bounded async batch over a multiplexed connection:

```python
import asyncio
import ssl

import httpx

ctx = ssl.create_default_context(cafile="corp-root-ca.pem")


async def fetch_all(urls: list[str], per_host: int = 4) -> list[tuple[str, int, str]]:
    limits = httpx.Limits(max_connections=per_host, max_keepalive_connections=per_host)
    gate = asyncio.Semaphore(per_host)  # multiplexing lowers cost per request, not the politeness cap

    async with httpx.AsyncClient(http2=True, verify=ctx, limits=limits, timeout=20.0) as client:
        async def one(url: str):
            async with gate:
                r = await client.get(url)
                return url, r.status_code, r.http_version

        return await asyncio.gather(*(one(u) for u in urls))


results = asyncio.run(fetch_all([f"https://h2.example.com/item/{i}" for i in range(8)]))
print(results[:2], len(results))
```

In Node, the built-in `fetch` of Node 22 and 24 (undici 6 and 7) speaks HTTP/1.1 unless you supply a dispatcher with `allowH2`; undici 8, bundled with Node 26, enables HTTP/2 by default. Using the npm package keeps behavior independent of the Node version:

```typescript
// npm install undici   (the npm package, so the API does not depend on the Node version)
import { Agent, fetch } from "undici";

const dispatcher = new Agent({
  allowH2: true,         // opt in on undici 6 and 7; the default from undici 8
  connections: 4,        // per-origin socket cap
  keepAliveTimeout: 10_000,
});

const res = await fetch("https://h2.example.com/", { dispatcher, signal: AbortSignal.timeout(15_000) });
console.log(res.status, await res.text()); // the server reports which protocol it saw
await dispatcher.close();
```

## HTTP/3 and QUIC

QUIC (RFC 9000) runs over UDP with TLS 1.3 built in. Each stream is independent, so packet loss on one does not stall others, connections survive network changes, and repeat connections can use 0-RTT. Clients discover HTTP/3 through an `Alt-Svc` response header such as `Alt-Svc: h3=":443"; ma=86400` (RFC 9114, section 3.1.1) or through HTTPS DNS records (RFC 9460); browsers usually connect with HTTP/2 first and switch later. Corporate networks often block UDP, so every HTTP/3 client needs a TCP fallback.

For scrapers HTTP/3 rarely matters: every public site still serves HTTP/1.1 and HTTP/2, and gains show up mainly on lossy mobile links. Use it when you have measured a benefit or when you are testing what browsers see.

## Client support

| Client | HTTP/1.1 keep-alive | HTTP/2 | HTTP/3 |
|---|---|---|---|
| requests | Yes | No | No |
| httpx, httpx2 | Yes | `http2=True` plus `h2` | No |
| aiohttp | Yes | No | No |
| niquests | Yes | Yes, by default | Yes, when its QUIC dependency is available |
| Node fetch (undici) | Yes | `allowH2` on undici 6 and 7, default on undici 8 | No |
| curl | Yes, across URLs in one command | Default over HTTPS | `--http3` on builds that include HTTP/3 (check `curl -V`) |
| Chromium via Playwright | Yes | Yes | Yes, chosen by the browser |

curl reuses one connection for several URLs given in the same command: `curl -sS -o /dev/null -o /dev/null -w '%{num_connects} ' URL1 URL2` prints `1 0`.

## Politeness and multiplexing

Each stream still costs the server CPU, database queries and bandwidth. Keep the same per-host limits you would use over HTTP/1.1 (often one to four requests in flight for a small site, more only with permission or a documented API quota), keep delays between requests, and back off on 429 and 503 ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)). A scheduler that enforces per-host budgets matters more than the protocol version ([Concurrency and Async IO](../operations/concurrency-and-async.md)).

## Pitfalls

- **A client per request.** No reuse, a full handshake every time, and a burst pattern the server notices.
- **Unbounded `gather`.** Launching ten thousand coroutines without a semaphore exhausts sockets and overloads the site.
- **Pool smaller than concurrency.** httpx raises `PoolTimeout` after waiting for a free connection; it looks like a slow server but is your own limit.
- **Assuming HTTP/2.** Missing `h2`, a proxy in the middle, or a server without `h2` in ALPN silently gives HTTP/1.1. Log the negotiated version.
- **Stale pooled connections** in long-running workers (NAT and load balancers drop idle flows). Retry idempotent requests once on a reset.
- **Very long-lived clients** keep connecting to an old IP after a DNS change. Recycle clients periodically in daemons.
- **HTTP/3 without fallback** on networks that block UDP.
- **Treating multiplexing as a license for more load.** It is not.

## Checklist

- [ ] One client per site, created once and closed at shutdown
- [ ] Pool size, per-host concurrency and delays configured explicitly
- [ ] HTTP/2 enabled where supported, negotiated version logged
- [ ] Idempotent requests retried once on connection resets
- [ ] Clients recycled periodically in long-running processes
- [ ] HTTP/3 only with a measured benefit and a TCP fallback

## See Also

- [HTTP Fundamentals](http-fundamentals.md)
- [TLS and HTTPS for Scrapers](tls-and-https.md)
- [Concurrency and Async IO](../operations/concurrency-and-async.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Making Browsers Cheap](../browser-automation/browser-resource-optimization.md)
