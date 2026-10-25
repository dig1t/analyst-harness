---
tags: [scraping, http, protocol, rfc-9110]
aliases: [HTTP basics, HTTP semantics, Request and response, HTTP methods]
---

# HTTP Fundamentals

> Sources: RFC 9110, HTTP Semantics (https://www.rfc-editor.org/rfc/rfc9110); RFC 9112, HTTP/1.1 (https://www.rfc-editor.org/rfc/rfc9112); RFC 3986, URI Generic Syntax (https://www.rfc-editor.org/rfc/rfc3986); WHATWG URL Standard (https://url.spec.whatwg.org/); MDN, Overview of HTTP (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Overview); MDN, HTTP request methods (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Methods); httpx source code (https://github.com/encode/httpx); undici documentation (https://undici.nodejs.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

HTTP is a stateless request/response protocol. A client sends a method, a target URL and header fields; the server answers with a status code, header fields and usually a body. RFC 9110 defines these semantics once for every protocol version: HTTP/1.1, HTTP/2 and HTTP/3 carry the same messages and differ only in how they travel on the wire. For a scraper the working core is short: build URLs with a URL library, use safe methods (GET, HEAD) unless a read-only POST is unavoidable, set explicit timeouts, check the status, content type and final URL before trusting a body, and reuse one client per site. Every request costs the site real resources, which is why politeness starts at this layer.

## One request and one response on the wire

```http
GET /page/1/ HTTP/1.1
Host: quotes.toscrape.com
User-Agent: acme-research-bot/1.2 (+https://acme.example/bot; bot@acme.example)
Accept: text/html,application/xhtml+xml;q=0.9,*/*;q=0.8
Accept-Encoding: gzip, br
```

```http
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Content-Encoding: gzip
Cache-Control: max-age=600
ETag: "5f3a-1c2"
Content-Length: 4120

<!DOCTYPE html>...
```

A request is a request line (method, request target, version), header fields, an empty line and an optional body. HTTP/1.1 requires a `Host` header. HTTP/2 and HTTP/3 send the same fields in binary frames, with lowercase names and pseudo-header fields (`:method`, `:path`, `:authority`, `:scheme`, `:status`) instead of the text start line.

Behind one fetch there are several stages, each with its own failure mode and timeout:

1. DNS resolution of the host name.
2. A TCP connection (or QUIC over UDP for HTTP/3).
3. A TLS handshake: SNI tells the server which host you want, ALPN picks `h2` or `http/1.1` (see [TLS and HTTPS for Scrapers](tls-and-https.md)).
4. The request and response, possibly compressed and possibly redirected.
5. The connection stays open for reuse unless either side closes it.

A "connect timeout" covers stages 1 to 3; a "read timeout" covers waiting for response bytes. Set both.

## URL anatomy

| Part | Example | What a scraper must know |
|---|---|---|
| scheme | `https` | Default ports: 443 for https, 80 for http |
| userinfo | `user:pass@` | Deprecated in URLs; credentials here leak into logs and history |
| host | `www.example.com` | Case-insensitive; internationalized names travel as punycode (`xn--...`) |
| port | `:8443` | Omitted when it is the default |
| path | `/catalog/shoes/` | Usually case-sensitive; a trailing slash can be a different resource |
| query | `?page=2&sort=price` | Values must be percent-encoded; parameter order may or may not matter |
| fragment | `#reviews` | Never sent to the server; client-side routers may use it |

Rules that prevent most URL bugs:

- Build queries with a library (`urlencode`, `URLSearchParams`), never by string concatenation.
- Resolve relative links against the final URL after redirects, or against `<base href>` when the page declares one.
- Browsers follow the WHATWG URL Standard, which repairs inputs that RFC 3986 parsers reject or treat differently (backslashes, stray whitespace). When a link works in the browser but not in your code, compare how both parse it. Deduplication-grade normalization is covered in [URL Normalization and Canonicalization](../crawling/url-normalization.md).

```python
from urllib.parse import urljoin, urlsplit, urlencode

base = "https://example.com/catalog/shoes/?page=2#reviews"
print(urlsplit(base))
# SplitResult(scheme='https', netloc='example.com', path='/catalog/shoes/', query='page=2', fragment='reviews')
print(urljoin(base, "../hats/"))          # https://example.com/catalog/hats/
print(urljoin(base, "?page=3"))           # https://example.com/catalog/shoes/?page=3
print(urljoin(base, "//cdn.example.net/a.png"))  # https://cdn.example.net/a.png
print("https://example.com/search?" + urlencode({"q": "red shoes", "size": 42}))
# https://example.com/search?q=red+shoes&size=42
```

## Methods: safe, idempotent and what scrapers send

| Method | Safe | Idempotent | Scraper use |
|---|---|---|---|
| GET | yes | yes | Almost everything |
| HEAD | yes | yes | Status, size, type and validators without the body (some servers mishandle it) |
| OPTIONS | yes | yes | Rarely; CORS preflight is a browser mechanism |
| POST | no | no | Search forms, GraphQL queries, APIs that require a body |
| PUT, DELETE | no | yes | Not for scraping |
| PATCH | no | no | Not for scraping |

RFC 9110 (section 9.2.1) explains that the safe/unsafe distinction exists so that "automated retrieval processes (spiders)" can work without causing harm. Decision rules:

- If you only read, use GET or HEAD.
- If a site's search only works with POST, a read-only POST is acceptable, but HTTP cannot tell the server it is harmless: keep the rate low and do not retry it blindly.
- Retry automatically only idempotent requests (RFC 9110, section 9.2.2). See [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md).
- Never submit forms that buy, post, vote, message or delete. That is no longer data collection.

## Header fields, bodies and representations

- Field names are case-insensitive. A field may repeat (`Set-Cookie` always does): use `r.headers.get_list("set-cookie")` in httpx rather than a single lookup.
- `Content-Type` gives the media type and often the charset; `Content-Length` or chunked transfer coding (HTTP/1.1 only) delimits the body; `Content-Encoding` means the body is compressed (see [Compression, Encodings and Character Sets](compression-and-encodings.md)).
- One URL can return different representations depending on `Accept`, `Accept-Language`, cookies, authentication or the client's location. Servers list the request headers that influenced a response in `Vary`. Record the request headers next to every stored response so a later re-parse knows what was asked for ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

Status codes come in five classes: 1xx informational, 2xx success, 3xx redirection, 4xx client error, 5xx server error. How to react to each is in [HTTP Status Codes and How to React](http-status-codes.md).

## A sane client in Python and TypeScript

```python
import httpx

HEADERS = {
    "User-Agent": "acme-research-bot/1.2 (+https://acme.example/bot; bot@acme.example)",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.8",
}

timeout = httpx.Timeout(15.0, connect=5.0)  # read/write/pool 15 s, connect 5 s
with httpx.Client(headers=HEADERS, timeout=timeout, follow_redirects=True) as client:
    r = client.get("https://quotes.toscrape.com/page/1/")
    print(r.http_version, r.status_code, r.reason_phrase)  # HTTP/1.1 200 OK
    print(r.headers["content-type"], r.encoding)            # text/html; charset=utf-8 utf-8
    print([str(h.url) for h in r.history], "->", r.url)     # redirect chain, final URL
    r.raise_for_status()                                    # raise on 4xx/5xx
    html = r.text
```

```typescript
const res = await fetch("https://quotes.toscrape.com/page/1/", {
  headers: {
    "User-Agent": "acme-research-bot/1.2 (+https://acme.example/bot; bot@acme.example)",
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  },
  redirect: "follow",                 // the default; "manual" exposes 3xx responses
  signal: AbortSignal.timeout(15_000), // fetch has no short default timeout
});
console.log(res.status, res.headers.get("content-type"), res.url, res.redirected);
if (!res.ok) throw new Error(`HTTP ${res.status} for ${res.url}`);
const html = await res.text();

// Resolve relative links against the final URL, not the one you requested.
console.log(new URL("../2/", res.url).href); // https://quotes.toscrape.com/page/2/
```

Client defaults differ more than people expect. Values below were read from the library sources (requests 2.34, httpx 0.28.1, undici 6 to 8, curl 8):

| Behavior | requests | httpx (and httpx2) | Node fetch (undici) | curl |
|---|---|---|---|---|
| Timeout | None: can wait forever | 5 s for connect, read, write and pool | 10 s connect, 300 s for headers and between body chunks | None overall; use `--max-time` |
| Redirects | Followed (not for HEAD), max 30 | Off until `follow_redirects=True`, max 20 | Followed, max 20 | Off until `-L`, max 50 |
| Cookies | Kept per `Session` | Kept per `Client` | Not kept; add a jar | Only with `-b` and `-c` |
| HTTP/2 | No | Opt in: `http2=True` plus the `h2` package | Opt in (`allowH2`) on undici 6 and 7 (Node 22, 24); default in undici 8 (Node 26) | Negotiated by default over HTTPS |
| Default User-Agent | `python-requests/x.y` | `python-httpx/x.y` | `node` | `curl/x.y.z` |
| Decompression | gzip, deflate; br and zstd when brotli or zstandard is installed | gzip, deflate; br and zstd with extras | gzip, deflate, br; zstd advertised from undici 8 | Only with `--compressed` |

A maintenance note: httpx has had no release since 0.28.1 (December 2024). Since May 2026 Pydantic maintains a continuation named httpx2 (`pip install httpx2`, `import httpx2`) with the same API and defaults, except that it verifies TLS against the operating system trust store. The Python snippets in this vault use `import httpx`; the ones we tested also run on httpx2 with `import httpx2 as httpx`.

## Pitfalls

- **No timeout.** requests waits forever by default; one stalled server freezes a worker. Always pass a timeout.
- **A new client per request.** You lose connection reuse, pay a TLS handshake each time and look like a burst to the server. Keep one client per site.
- **Concatenated URLs.** Unencoded spaces, `&` inside values and doubled slashes produce wrong or different pages.
- **Wrong base for relative links.** Resolve against the final URL (after redirects) or `<base href>`, not the URL you asked for.
- **200 means success.** Block pages, consent walls and "not found" pages often return 200. Check the content too (see soft 404s in [HTTP Status Codes and How to React](http-status-codes.md)).
- **One URL, one representation.** Language, cookies, login state and geography change the response. Pin the headers you parse against and record them.
- **Casual POSTs and retries.** Retrying a non-idempotent request can duplicate an action on the server.
- **Credentials in URLs.** Userinfo and API keys in query strings end up in logs, proxies and `Referer` headers.

## Checklist

- [ ] Explicit connect and read timeouts on every client
- [ ] One long-lived client per site, reused across requests
- [ ] Honest `User-Agent` with a contact URL or address
- [ ] GET and HEAD only, unless a documented read-only POST is required
- [ ] URLs built and resolved with a URL library, against the final URL
- [ ] Status, `Content-Type` and final URL checked before parsing
- [ ] Request headers, final URL and fetch time stored with each response

## See Also

- [Request Headers That Matter](http-headers-for-scrapers.md)
- [HTTP Status Codes and How to React](http-status-codes.md)
- [HTTP/2, HTTP/3 and Connection Reuse](http2-http3-and-connection-reuse.md)
- [Redirects and Canonical URLs](redirects-and-canonical-urls.md)
- [Python Scraping Stack](../tools/python-scraping-stack.md)
- [curl and HTTPie Cheatsheet](curl-cheatsheet.md)
