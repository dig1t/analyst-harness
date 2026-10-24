---
tags: [scraping, apis, webhooks, websub, change-feeds]
aliases: [webhooks, WebSub, PubSubHubbub, push notifications, change feed, HMAC signature verification, polling vs push]
---

# Webhooks and Push-Based Acquisition

> Sources: W3C Recommendation, WebSub, 23 January 2018 (https://www.w3.org/TR/websub/); Standard Webhooks specification (https://github.com/standard-webhooks/standard-webhooks); GitHub Docs, Validating webhook deliveries (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries); GitHub Docs, Best practices for using webhooks (https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks); GitHub Docs, Handling failed webhook deliveries (https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries); GitHub Docs, REST API endpoints for events (https://docs.github.com/en/rest/activity/events); Stripe Docs, Webhooks (https://docs.stripe.com/webhooks); YouTube Data API, Subscribe to push notifications (https://developers.google.com/youtube/v3/guides/push_notifications)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Polling asks "anything new?" on a schedule; push lets the source tell you. **Webhooks** are HTTP POSTs a provider sends to your endpoint when something happens (GitHub, Stripe, Shopify, form and CRM tools). **WebSub**, a W3C Recommendation, does the same for public feeds through a hub: you subscribe to a topic URL and the hub delivers new content (YouTube channel uploads are a well-known example). **Change feeds** (CouchDB `_changes`, Wikimedia EventStreams over SSE, GitHub's Events API) expose an ordered log you can tail. Push gives lower latency and far fewer requests, and is the politest way to stay fresh. In exchange you must run a public HTTPS endpoint, verify every delivery's signature, respond within seconds, deduplicate by delivery id, tolerate out-of-order and missed events, and keep a periodic reconciliation poll as the safety net.

## Polling or push?

| | Polling | Push (webhooks, WebSub, feeds) |
|---|---|---|
| Latency | up to one interval | seconds |
| Requests | constant, mostly "no change" | only when something changed |
| Missed changes | none if you poll everything, but costly | possible (outages, provider bugs); reconcile |
| Infrastructure | a scheduler | a public HTTPS endpoint, queue, signature checks |
| Availability | any source | only where the provider offers it |
| Ordering | you control it | not guaranteed |

Make polling cheap where push is unavailable: conditional requests and provider hints such as GitHub's Events API, which is optimized for polling with `ETag` (a 304 does not use your rate limit) and returns an `X-Poll-Interval` header you are asked to obey (see [Incremental Crawling](../crawling/incremental-crawling.md)).

## Receiving webhooks safely

1. **HTTPS endpoint with an unguessable path**, ideally on a separate small service. For development, tunnels (GitHub suggests smee.io; `cloudflared` and `ngrok` are common) forward deliveries to your laptop.
2. **Verify the signature over the raw body** before parsing JSON. GitHub signs with HMAC-SHA256 in `X-Hub-Signature-256: sha256=<hex>` (the SHA-1 `X-Hub-Signature` exists only for compatibility); Stripe sends `Stripe-Signature` with a timestamp and `v1` signature; the Standard Webhooks specification uses `webhook-id`, `webhook-timestamp` and `webhook-signature` headers. Compare in constant time.
3. **Reject stale timestamps** where the scheme includes one (Stripe's libraries default to a 5-minute tolerance) to stop replays.
4. **Answer fast, process later.** GitHub expects a 2xx within 10 seconds or counts the delivery as failed. Put the payload on a queue and return 202 ([Queues and Workers](../operations/queues-and-workers.md)).
5. **Deduplicate.** Deliveries are at-least-once. GitHub's `X-GitHub-Delivery` stays the same on redelivery; Standard Webhooks recommends using `webhook-id` as an idempotency key.
6. **Expect disorder and gaps.** Use event timestamps or resource versions instead of arrival order, and fetch the current state from the API when an event only says "something changed".
7. **Know the retry policy.** GitHub does not automatically redeliver failed deliveries (you can redeliver recent ones manually or through the API); Stripe retries for up to three days in live mode. Either way, run a **reconciliation job** that polls the API periodically for anything missed.
8. **Never log secrets**, rotate webhook secrets periodically (Standard Webhooks allows several signatures at once during rotation), and optionally restrict source IPs to ranges the provider publishes (GitHub lists its webhook ranges in the `hooks` key of `GET /meta`).

## Code: a webhook receiver (TypeScript, no dependencies)

Node 22 (run with `node --experimental-strip-types`, or compile with `tsc`). Verifies GitHub's signature in constant time, caps the body size, deduplicates by delivery id and acknowledges with 202 before processing. Tested locally: a valid delivery got 202, its redelivery 200 ("duplicate"), and a tampered signature 401.

```typescript
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

const SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? "";
const seen = new Set<string>(); // use a database table or Redis with a TTL in production
const queue: Array<{ event: string; payload: unknown }> = [];

function readBody(req: IncomingMessage, limit = 25 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("payload too large")); req.destroy(); } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function validSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(body).digest("hex"));
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected); // constant time
}

export const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/github") { res.writeHead(404).end(); return; }
  let body: Buffer;
  try { body = await readBody(req); } catch { res.writeHead(413).end(); return; }
  if (!validSignature(SECRET, body, req.headers["x-hub-signature-256"] as string | undefined)) {
    res.writeHead(401).end(); return;
  }
  const delivery = String(req.headers["x-github-delivery"] ?? "");
  if (seen.has(delivery)) { res.writeHead(200).end("duplicate"); return; } // redeliveries reuse the id
  seen.add(delivery);
  queue.push({ event: String(req.headers["x-github-event"]), payload: JSON.parse(body.toString("utf8")) });
  res.writeHead(202).end("queued"); // answer fast (GitHub allows 10 s), process asynchronously
});

export { queue };
if (import.meta.url === `file://${process.argv[1]}`) server.listen(Number(process.env.PORT ?? 8080));
```

## Code: Standard Webhooks and WebSub (Python)

Python 3.11 with `httpx`. `verify_standard_webhook` was cross-checked against the reference `standardwebhooks` library: it accepted the library's signature and rejected a forged signature and a one-hour-old timestamp. The WebSub helpers were tested against a mocked hub.

```python
import base64
import hashlib
import hmac
import time

import httpx


def verify_standard_webhook(secret: str, headers: dict[str, str], body: bytes,
                            tolerance_s: int = 300) -> None:
    """Standard Webhooks: HMAC-SHA256 over '{webhook-id}.{webhook-timestamp}.{body}'.
    Raises ValueError unless one 'v1,<base64>' signature matches and the timestamp is fresh."""
    h = {k.lower(): v for k, v in headers.items()}
    msg_id, ts, sigs = h["webhook-id"], h["webhook-timestamp"], h["webhook-signature"]
    if abs(time.time() - int(ts)) > tolerance_s:
        raise ValueError("timestamp outside tolerance (possible replay)")
    key = base64.b64decode(secret.removeprefix("whsec_"))
    mac = hmac.new(key, f"{msg_id}.{ts}.".encode() + body, hashlib.sha256).digest()
    expected = base64.b64encode(mac).decode()
    for candidate in sigs.split():                      # several signatures during key rotation
        version, _, value = candidate.partition(",")
        if version == "v1" and hmac.compare_digest(value, expected):
            return
    raise ValueError("no valid signature")


# --- WebSub (W3C Recommendation) subscriber helpers ---------------------------------

async def discover_hub(client: httpx.AsyncClient, topic_url: str) -> tuple[str | None, str]:
    """Hub and canonical topic from Link headers (feeds may also carry <link rel="hub">)."""
    r = await client.get(topic_url, follow_redirects=True)
    hub = r.links.get("hub", {}).get("url")
    topic = r.links.get("self", {}).get("url", str(r.url))
    return hub, topic


async def subscribe(client: httpx.AsyncClient, hub: str, topic: str, callback: str,
                    secret: str, lease_seconds: int = 864_000) -> int:
    """Ask the hub to deliver updates; it answers 202 and then verifies intent at the callback."""
    r = await client.post(hub, data={
        "hub.mode": "subscribe", "hub.topic": topic, "hub.callback": callback,
        "hub.secret": secret, "hub.lease_seconds": str(lease_seconds),
    })
    return r.status_code


def answer_verification(query: dict[str, str], pending: set[str]) -> tuple[int, str]:
    """GET on the callback: echo hub.challenge only for subscriptions we actually requested."""
    if query.get("hub.mode") in ("subscribe", "unsubscribe") and query.get("hub.topic") in pending:
        return 200, query.get("hub.challenge", "")     # serve as text/plain
    return 404, ""


def valid_distribution(secret: str, body: bytes, x_hub_signature: str | None) -> bool:
    """POST on the callback: X-Hub-Signature is '<method>=<hex HMAC of the body>'."""
    method, _, sig = (x_hub_signature or "").partition("=")
    if method not in ("sha1", "sha256", "sha384", "sha512"):
        return False
    return hmac.compare_digest(sig, hmac.new(secret.encode(), body, method).hexdigest())
```

**WebSub flow in practice.** Fetch the feed and read `Link: <hub>; rel="hub"` and `Link: <topic>; rel="self"` (or the equivalent `<link>` elements inside Atom, RSS or HTML). POST a subscription to the hub with your callback and a secret; the hub answers 202 and then sends a GET to your callback with `hub.mode`, `hub.topic`, `hub.challenge` and `hub.lease_seconds`; echo the challenge only for topics you asked for. New content then arrives as POSTs signed with `X-Hub-Signature`. If a signature does not match, the spec says you MUST ignore the message (you MAY still answer 2xx). Leases expire, and hubs must not grant perpetual ones, so renew before `hub.lease_seconds` runs out. YouTube's push notifications use exactly this flow with the hub at `https://pubsubhubbub.appspot.com/` and topics of the form `https://www.youtube.com/xml/feeds/videos.xml?channel_id=CHANNEL_ID`.

## Change feeds you can tail

- **SSE feeds** such as Wikimedia EventStreams: resume with `Last-Event-ID` ([WebSockets and Server-Sent Events](websockets-and-sse.md)).
- **Database-style change logs** such as CouchDB's `_changes` (with a `since` sequence) or Firebase-backed APIs that support streaming: store the last sequence and resume from it.
- **Event APIs** (GitHub Events, audit logs): poll with ETags at the advertised interval; note that event APIs usually keep only a limited window of history, so they complement rather than replace a full sync.
- **Your own sources**: if you own the database, change data capture (logical replication, Debezium) beats any scraper.

**IndexNow** points the other way: it lets site owners push changed URLs to participating search engines. It matters if you publish data, not when you collect it.

## Pitfalls

- Parsing JSON before verifying the signature, or verifying a re-serialized body instead of the raw bytes.
- String comparison instead of a constant-time compare.
- Doing the work inside the request handler and timing out, which providers treat as failure (and some eventually disable the endpoint).
- No deduplication: redeliveries double-count events.
- Assuming push is complete; without reconciliation, one outage silently loses data.
- Forgetting WebSub lease renewal, so the subscription quietly expires after days.
- Exposing the receiver on a guessable path without signatures, letting anyone inject events.

## Checklist

- [ ] Push offered by the source? Use it; otherwise poll conditionally at the provider's advertised interval.
- [ ] HTTPS endpoint, raw-body signature verification in constant time, timestamp tolerance.
- [ ] 2xx within the provider's deadline; processing through a queue.
- [ ] Deduplication by delivery or event id; ordering by event time or version.
- [ ] Reconciliation job for missed events; alert when deliveries stop.
- [ ] Secrets in a secret store, rotated; WebSub leases renewed automatically.

## See Also

- [WebSockets and Server-Sent Events](websockets-and-sse.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [Consuming REST APIs Well](rest-api-consumption.md)
- [Queues and Workers](../operations/queues-and-workers.md)
- [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md)
- [Secrets and Configuration](../operations/secrets-and-config.md)
