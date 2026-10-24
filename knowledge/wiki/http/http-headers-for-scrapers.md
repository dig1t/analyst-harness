---
tags: [scraping, http, headers, user-agent]
aliases: [Request headers, User-Agent header, Accept-Language, Referer header, Scraper headers]
---

# Request Headers That Matter

> Sources: RFC 9110, sections 10.1 (request context fields) and 12.5 (content negotiation) (https://www.rfc-editor.org/rfc/rfc9110); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); MDN, User-Agent (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/User-Agent); MDN, Accept (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept); MDN, Referrer-Policy (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy); MDN, Sec-Fetch-Site (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Sec-Fetch-Site); Google robots.txt parser (https://github.com/google/robotstxt)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Request headers tell a server who is asking, what representation it wants and in what context it asks. For scrapers they fall into three groups. Identity headers (`User-Agent`, `From`) must be honest: name your software and give a way to reach you. Content negotiation headers (`Accept`, `Accept-Language`, `Accept-Encoding`) should be pinned to what your parsers expect, because they change what the server returns. Context headers (`Referer`, `Origin`, cookies, CSRF tokens, app-specific `X-` headers) should mirror what the site's own pages send for the same request, and nothing more. Never forge headers to pass as a browser, as another company's crawler, or as a different network location.

## The headers that change outcomes

| Header | What it tells the server | Practice for scrapers |
|---|---|---|
| `User-Agent` | The software making the request | Product token, version and contact URL or email. Stable across runs. |
| `From` | Email of the person responsible | RFC 9110 (10.1.2): a robotic user agent SHOULD send it. Use a monitored mailbox. |
| `Accept` | Media types you can use | `text/html` for pages, `application/json` for APIs. Some endpoints switch format on it. |
| `Accept-Language` | Preferred languages | Pin it. Content, currency and number formats may vary on it. |
| `Accept-Encoding` | Compressions you can decode | Let the library set it; it only advertises what it can decode. |
| `Referer` | The page that linked to this URL | Send the page you actually came from when the site's own navigation would. |
| `Origin` | The origin that initiated a CORS request or a POST | Only when replaying the site's own same-origin call. |
| `Cookie` | Session and preference state | Managed by a cookie jar, see [Cookies, Sessions and State](cookies-and-sessions.md). |
| `Authorization` | Credentials | See [Authentication Patterns](authentication-patterns.md). |
| `If-None-Match`, `If-Modified-Since` | What you already have | See [HTTP Caching and Conditional Requests](caching-and-conditional-requests.md). |
| `X-Requested-With: XMLHttpRequest` | Legacy marker for script-initiated requests | Some frameworks return JSON or HTML fragments only when it is present. |
| App headers (`X-CSRF-Token`, `X-API-Key`, version headers) | Whatever the application defines | Copy only the ones the endpoint needs; fetch volatile values at runtime. |

## Writing an honest User-Agent

A good scraper User-Agent has three parts: a product token, a version and a contact.

```text
acme-price-monitor/2.0 (+https://acme.example/bot; ops@acme.example)
```

- **Product token.** robots.txt groups are matched against it, case-insensitively. Google's reference parser only treats letters, hyphens and underscores as part of the token, so `acme-price-monitor` matches but `bot2` would be read as `bot`. Keep the token stable so site owners can write `User-agent: acme-price-monitor` rules ([robots.txt (RFC 9309)](../crawling/robots-txt.md)).
- **Version.** Lets operators correlate behavior changes with your releases.
- **Contact URL.** A page saying what the bot collects, how often, how to opt out and how to reach you. This is what turns an angry block into an email ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)).

Library defaults (`python-requests/2.x`, `python-httpx/0.x`, `node`, `curl/8.x`) identify nothing useful and are blocked by many sites precisely because they are anonymous.

When you must drive a real browser, keep its User-Agent and append your token, the way Google's own crawlers do (`... Chrome/W.X.Y.Z Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)`). Browsers have also frozen most of their User-Agent string ("User-Agent reduction") and moved details into `Sec-CH-UA-*` client hints, which only browsers generate.

## Content negotiation in practice

- **Accept.** The same URL can return HTML to a browser and JSON to `Accept: application/json`. When replaying an XHR you found in DevTools, send the `Accept` it sent (axios, for example, sends `application/json, text/plain, */*`).
- **Accept-Language.** A cloud runner in another region can receive another language or currency. Pin `Accept-Language` (and any locale cookie) to the variant your parser and number parsing expect ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)).
- **Weights.** `q` values express preference from 0 to 1: `en-GB,en;q=0.8,*;q=0.1`. Servers are free to ignore them.
- **Accept-Encoding.** Advertising `br` or `zstd` without a decoder installed gets you bytes you cannot read. Leave it to the client ([Compression, Encodings and Character Sets](compression-and-encodings.md)).

## Context headers: Referer and Origin

Browsers send `Referer` according to `Referrer-Policy`, whose default is `strict-origin-when-cross-origin`: the full URL for same-origin requests, only the origin for cross-origin ones, nothing when going from HTTPS to HTTP. Some image hosts and download endpoints refuse requests without a same-site `Referer` (hotlink protection). Sending the URL of the page you really fetched is accurate context; inventing one is not.

`Origin` accompanies CORS requests and POSTs. Servers use it, together with CSRF tokens, to protect their users' sessions from cross-site attacks. When you replay the site's own same-origin API call with your own session, send the same `Origin` the page sends.

## Mirroring a page's own request

1. Open DevTools, Network panel, and trigger the action ([Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)).
2. Right-click the request and copy it as cURL ([curl and HTTPie Cheatsheet](curl-cheatsheet.md)).
3. Delete headers one at a time and re-run until the response changes. Keep only what is needed.
4. Replace volatile values (CSRF tokens, signed timestamps) with values fetched at runtime.
5. Replace the browser's identity headers with your own honest `User-Agent`.

```python
import httpx

BOT_UA = "acme-price-monitor/2.0 (+https://acme.example/bot; ops@acme.example)"

client = httpx.Client(
    headers={
        "User-Agent": BOT_UA,
        "From": "ops@acme.example",  # RFC 9110 asks robots to send a contact address
        "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-GB,en;q=0.8",  # pin the locale your parsers expect
        # Leave Accept-Encoding to the library: it advertises only what it can decode.
    },
    timeout=15.0,
)

# A JSON endpoint the page itself calls: send what the page sends, nothing invented.
r = client.get(
    "https://example.com/api/products",
    params={"page": 1},
    headers={"Accept": "application/json", "Referer": "https://example.com/products"},
)
for name, value in r.request.headers.items():  # what actually went on the wire
    print(f"{name}: {value}")
```

```typescript
const UA = "acme-price-monitor/2.0 (+https://acme.example/bot; ops@acme.example)";

const res = await fetch("https://example.com/api/products?page=1", {
  headers: {
    "User-Agent": UA,
    "From": "ops@acme.example",
    "Accept": "application/json",
    "Referer": "https://example.com/products",
  },
  signal: AbortSignal.timeout(15_000),
});
```

Printing `r.request.headers` is the quickest way to see the defaults your library added.

## Headers you should not send

- **A browser User-Agent used to pass as a human visitor**, or browser-only fields (`Sec-Fetch-*`, `Sec-CH-UA-*`) from a non-browser client. Fetch metadata headers are "forbidden" for page scripts to set: their presence claims a browser generated the request.
- **Another crawler's identity.** Large search engines publish ways to verify their crawlers (reverse DNS, published IP ranges), and impersonating them is deceptive.
- **`X-Forwarded-For`, `Forwarded`, `X-Real-IP`.** Proxies set these to report the client address. Forging them misrepresents where requests come from.
- **Secrets copied from your browser.** A "Copy as cURL" command contains your cookies and tokens. Strip them before sharing, logging or committing.

Header order and capitalization carry no meaning in HTTP semantics, and HTTP/2 lowercases names. Some bot-management systems still use them as fingerprint signals ([Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md)). The responsible answer to being treated as a bot is to be an identifiable one and ask for access, not to mimic a browser more closely.

## Pitfalls

- **Pasting all 20 headers from DevTools.** You inherit stale CSRF tokens, session cookies and browser-only fields; the scraper breaks when any of them changes.
- **Rotating User-Agents** to spread load across fake identities. It is evasion, and it removes the one handle a site owner has to contact you.
- **No `Accept-Language`.** The same code returns a different language or currency when it moves to a runner in another region.
- **Hard-coded `Accept-Encoding: br, zstd`** without the decoders installed.
- **Wrong `Accept` for an API**, which then returns an HTML error page with status 200.
- **Setting `Host` by hand.** The client derives it from the URL; overriding it breaks virtual hosting and TLS name checks.
- **Not looking at what was sent.** Libraries add defaults; inspect the request object or an echo endpoint.

## Checklist

- [ ] `User-Agent` has a stable product token (letters, hyphens, underscores), a version and a contact URL or email
- [ ] `From` points to a monitored mailbox
- [ ] `Accept` and `Accept-Language` pinned to what parsers expect
- [ ] `Accept-Encoding` left to the client library
- [ ] `Referer` and `Origin` only when replaying the site's own navigation or call
- [ ] No forged browser, crawler or client-IP headers
- [ ] Request headers stored with each response for provenance

## See Also

- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [Cookies, Sessions and State](cookies-and-sessions.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Browser and TLS Fingerprinting](../anti-bot/fingerprinting.md)
- [HTTP Fundamentals](http-fundamentals.md)
