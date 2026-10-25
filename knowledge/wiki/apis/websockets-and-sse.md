---
tags: [scraping, apis, websockets, server-sent-events, real-time]
aliases: [WebSocket, SSE, EventSource, text/event-stream, real-time feeds, streaming APIs, Socket.IO]
---

# WebSockets and Server-Sent Events

> Sources: RFC 6455, The WebSocket Protocol (https://www.rfc-editor.org/rfc/rfc6455); RFC 8441, Bootstrapping WebSockets with HTTP/2 (https://www.rfc-editor.org/rfc/rfc8441); RFC 9220, Bootstrapping WebSockets with HTTP/3 (https://www.rfc-editor.org/rfc/rfc9220); WHATWG HTML Living Standard, Server-sent events (https://html.spec.whatwg.org/multipage/server-sent-events.html); websockets library documentation (https://websockets.readthedocs.io/); Playwright documentation, WebSocket class (https://playwright.dev/docs/api/class-websocket); graphql-ws protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Live prices, scores, chat, dashboards, notifications and LLM token streams do not arrive through ordinary request-response calls. They use **WebSockets** (RFC 6455: a bidirectional, message-framed connection upgraded from HTTP) or **Server-Sent Events** (SSE, defined in the WHATWG HTML standard: a long-lived HTTP response of type `text/event-stream` that the server keeps writing to). For data collection the job is the same in both cases: find the stream, connect with an honest client, subscribe to only what you need, **record every message with a local receive timestamp**, survive disconnects (reconnect with backoff, resubscribe, resume from the last event id or a fresh snapshot), and detect gaps. Prefer documented streaming APIs; an undocumented real-time feed of a commercial site is often licensed data, and polling a feed harder is never a substitute for permission.

## Recognizing them

- **DevTools**: filter the Network panel to WebSocket connections (the WS or Socket filter, depending on the browser version); the Messages tab lists frames in both directions. SSE requests show the `text/event-stream` response type, and Chrome displays an EventStream tab for `EventSource` connections. See [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md).
- **Page source**: `new WebSocket(`, `new EventSource(`, `io(` (Socket.IO), SignalR or Phoenix client libraries in the bundle.
- **URLs**: `wss://` endpoints, paths like `/socket.io/?EIO=4&transport=websocket`, `/stream`, `/events`, `/sse`.

## WebSocket essentials

- **Handshake**: an HTTP GET with `Upgrade: websocket`, `Connection: Upgrade`, `Sec-WebSocket-Version: 13` and a random `Sec-WebSocket-Key`; the server answers `101 Switching Protocols` with `Sec-WebSocket-Accept`, the base64 SHA-1 of the key concatenated with the fixed GUID `258EAFA5-E914-47DA-95CA-C5AB0DC85B11`. Libraries do this for you; it matters when debugging proxies.
- **Subprotocols** (`Sec-WebSocket-Protocol`) name the application protocol, for example `graphql-transport-ws`.
- **Frames**: text, binary, ping, pong and close. Clients must mask frames they send. Servers ping to detect dead clients; good libraries answer automatically.
- **Close codes**: 1000 normal, 1001 going away, 1008 policy violation, 1011 server error; 1006 is never sent on the wire and means the connection dropped without a close frame.
- **Transport**: WebSockets also run over HTTP/2 (RFC 8441) and HTTP/3 (RFC 9220), though most clients still use HTTP/1.1 upgrades.
- **Auth**: cookies sent with the handshake, a token in the URL, or a token in the first message. Servers usually check the `Origin` header.

**Application protocols on top.** Raw JSON messages (`{"op": "subscribe", "channel": "..."}`) are common, but many sites use a framework protocol: Socket.IO (Engine.IO packets such as `40` for connect and `42["event", data]` for events), SignalR, STOMP, MQTT over WebSockets, Phoenix channels, or graphql-ws for GraphQL subscriptions ([GraphQL Endpoints](graphql.md)). Use the framework's official client library (for example `python-socketio`) instead of re-implementing its framing; payloads may also be binary (Protocol Buffers, MessagePack).

## SSE essentials

An SSE response is UTF-8 text in blocks separated by blank lines. Each line is `field: value`:

```text
: keep-alive comment
retry: 5000
id: 1729760000-42
event: price
data: {"symbol": "ABC", "last": 101.5}

data: first line
data: second line

```

- `data` lines accumulate (joined with newlines); a blank line dispatches the event; a block with no `data` dispatches nothing.
- `event` sets the type (default `message`); `id` sets the last event id; `retry` sets the reconnection delay in milliseconds; lines starting with `:` are comments, typically keep-alives.
- On reconnect the client sends the `Last-Event-ID` header, and a server that supports it resumes from there. This is SSE's big advantage for collection: resumption is built in.
- Many LLM APIs stream responses as SSE, and public change feeds use it too; Wikimedia's EventStreams service, for example, publishes recent changes at `https://stream.wikimedia.org/v2/stream/recentchange` (send a descriptive User-Agent; see [Catalog of Useful Open APIs](official-apis-catalog.md)).

## Code: recording a WebSocket and reading SSE

Python 3.11 with `websockets` (version 13 or newer, which provides the reconnecting `async for ... in connect(...)` loop) and `httpx`. Tested against a local WebSocket server that dropped the first connection with code 1011 and skipped a sequence number (the client reconnected, resubscribed and reported the gap), and against a mocked SSE stream with CRLF line endings, multi-line data, an empty event type, comments, `retry` and an id-only block (the reader followed the WHATWG rules and resumed with `Last-Event-ID`).

```python
import asyncio
import json
import time
from collections.abc import AsyncIterator

import httpx
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

UA = "ExampleBot/1.0 (+https://example.org/bot; bot@example.org)"


async def record_websocket(uri: str, subscribe: dict, out_path: str, max_messages: int | None = None,
                           on_gap=None) -> None:
    """Append every message to JSONL with a local receive time; resubscribe after reconnects;
    report sequence gaps (fetch a fresh snapshot when one happens)."""
    last_seq, count = None, 0
    with open(out_path, "a", encoding="utf-8") as out:
        # `async for` reconnects automatically, with exponential backoff, after network errors
        async for ws in connect(uri, user_agent_header=UA, ping_interval=20, ping_timeout=20,
                                max_size=4 * 2**20):
            try:
                await ws.send(json.dumps(subscribe))          # subscriptions die with the socket
                async for raw in ws:
                    received_at = time.time()
                    msg = json.loads(raw)
                    seq = msg.get("seq")
                    if seq is not None and last_seq is not None and seq != last_seq + 1 and on_gap:
                        await on_gap(last_seq, seq)
                    last_seq = seq if seq is not None else last_seq
                    out.write(json.dumps({"received_at": received_at, "msg": msg}) + "\n")
                    count += 1
                    if max_messages and count >= max_messages:
                        return
            except ConnectionClosed:
                continue                                       # connect() backs off and retries


async def sse_events(client: httpx.AsyncClient, url: str, last_event_id: str | None = None,
                     max_reconnects: int | None = None) -> AsyncIterator[tuple[str, str, str | None]]:
    """Yield (event, data, id) following the WHATWG event-stream rules; reconnect with Last-Event-ID."""
    retry_s, reconnects = 3.0, 0
    while max_reconnects is None or reconnects <= max_reconnects:
        headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache", "User-Agent": UA}
        if last_event_id:
            headers["Last-Event-ID"] = last_event_id
        try:
            # read timeout above the server's keep-alive interval; None would hang on dead links
            async with client.stream("GET", url, headers=headers,
                                     timeout=httpx.Timeout(10.0, read=120.0)) as r:
                r.raise_for_status()
                event, data = "", []
                async for line in r.aiter_lines():
                    if line == "":                             # blank line: dispatch
                        if data:
                            yield event or "message", "\n".join(data), last_event_id
                        event, data = "", []
                        continue
                    if line.startswith(":"):
                        continue                               # comment, often a keep-alive
                    field, _, value = line.partition(":")
                    value = value[1:] if value.startswith(" ") else value
                    if field == "data":
                        data.append(value)
                    elif field == "event":
                        event = value
                    elif field == "id" and "\0" not in value:
                        last_event_id = value
                    elif field == "retry" and value.isdigit():
                        retry_s = int(value) / 1000
        except (httpx.TransportError, httpx.HTTPStatusError):
            pass                                               # fall through to reconnect
        reconnects += 1
        await asyncio.sleep(retry_s)
```

Run the recorder as a long-lived service with `asyncio.run(record_websocket("wss://stream.example.com/v1", {"op": "subscribe", "channel": "prices"}, "prices.jsonl"))`, and parse the JSONL in a separate stage. For SSE: `async for event, data, event_id in sse_events(client, url): ...`.

## Capture and replay

- **Record raw first.** Write each message with its local receive time (and the server timestamp if present) before any parsing; the recording is your raw archive and your test fixture ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).
- **Replay for tests.** Feed recorded JSONL into the parser to reproduce bugs and build regression tests ([Testing Scrapers](../data-quality/testing-scrapers.md)).
- **From a browser**: when a stream only works inside the page (complex auth, obfuscated protocol), Playwright's `page.on("websocket", ...)` exposes each socket, whose `framereceived` and `framesent` events carry the payloads ([Network Interception and Response Capture](../browser-automation/network-interception.md)). Chrome's HAR export also includes WebSocket messages in a non-standard `_webSocketMessages` field.

## Reliability patterns

- **Reconnect with backoff and jitter**, then **resubscribe**: subscriptions belong to the connection, not to you.
- **Heartbeats**: rely on protocol pings, plus application-level pings where the protocol requires them; treat silence longer than the expected heartbeat as a dead connection.
- **Sequence numbers and gaps**: if messages carry a sequence, check continuity. On a gap, refetch a snapshot.
- **Snapshot plus deltas**: for order books and similar state, fetch a REST snapshot, buffer deltas from the stream, then apply only deltas newer than the snapshot's sequence.
- **Decouple receiving from processing**: put messages on a queue and parse elsewhere, so slow processing never causes missed pings or server-side buffer overflows.
- **Periodic reconciliation**: streams miss things. Compare against a REST or bulk source on a schedule ([Webhooks and Push-Based Acquisition](webhooks-and-push.md)).

## Responsible use

- Look for a documented stream first; many data providers publish WebSocket or SSE APIs with terms and limits.
- Open one connection and multiplex subscriptions over it rather than one connection per symbol or channel; respect connection limits.
- Identify your client honestly. Do not forge `Origin` headers or session tokens to get past checks meant to keep the stream to the site's own pages; that is circumvention, not collection ([Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)).
- Real-time feeds of prices, odds and market data are frequently licensed commercially; check before storing or redistributing.

## Pitfalls

- Parsing in the receive loop and stalling the socket.
- Forgetting to resubscribe after a reconnect, then recording a silent but "connected" socket.
- No receive timestamps, so latency and ordering questions cannot be answered later.
- SSE clients with no read timeout that hang forever on a dead connection, or with one shorter than the server's keep-alive interval.
- Ignoring `Last-Event-ID` and losing events across reconnects.
- Re-implementing Socket.IO or SignalR framing by hand.

## Checklist

- [ ] Documented streaming API checked first; terms and licensing reviewed.
- [ ] One connection, minimal subscriptions, honest User-Agent.
- [ ] Raw messages recorded as JSONL with local receive time before parsing.
- [ ] Reconnect with backoff, resubscribe, resume via `Last-Event-ID` or a snapshot.
- [ ] Sequence gaps detected and repaired; periodic reconciliation against a REST or bulk source.
- [ ] Processing decoupled from receiving through a queue.

## See Also

- [Webhooks and Push-Based Acquisition](webhooks-and-push.md)
- [GraphQL Endpoints](graphql.md)
- [Finding Hidden APIs with DevTools](finding-hidden-apis.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [Queues and Workers](../operations/queues-and-workers.md)
