---
tags: [scraping, http, cookies, sessions, csrf]
aliases: [Cookies, Cookie jar, Session persistence, CSRF tokens, Login sessions]
---

# Cookies, Sessions and State

> Sources: RFC 6265, HTTP State Management Mechanism (https://www.rfc-editor.org/rfc/rfc6265); draft-ietf-httpbis-rfc6265bis (https://datatracker.ietf.org/doc/draft-ietf-httpbis-rfc6265bis/); MDN, Using HTTP cookies (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Cookies); MDN, Set-Cookie (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie); OWASP, Cross-Site Request Forgery Prevention Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html); Python http.cookiejar (https://docs.python.org/3/library/http.cookiejar.html); tough-cookie (https://github.com/salesforce/tough-cookie)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

HTTP is stateless, so sites keep state in cookies: a server sends `Set-Cookie`, the client stores it and returns it in `Cookie` on later matching requests. A scraper needs a real cookie jar (one that applies domain, path, secure and expiry rules), one jar per identity, deliberate persistence between runs, and a login flow that handles CSRF tokens and detects expired sessions. Cookies also change content without any login: consent choices, locale, currency and A/B buckets all live there. Treat session cookies exactly like passwords, and treat scraping behind a login as a higher-risk activity that needs explicit permission.

## How cookies work

```http
HTTP/1.1 200 OK
Set-Cookie: sid=31d4d96e407aad42; Path=/; Secure; HttpOnly; SameSite=Lax
Set-Cookie: lang=en-GB; Max-Age=31536000; Path=/

GET /account HTTP/1.1
Host: shop.example
Cookie: sid=31d4d96e407aad42; lang=en-GB
```

| Attribute | Meaning | Matters for a scraper because |
|---|---|---|
| `Domain` | Send to this domain and its subdomains. Absent: only the exact host that set it | A cookie from `www.shop.example` may not reach `api.shop.example` |
| `Path` | Send only for request paths under this prefix | `/docs` matches `/docs/web` but not `/docsets` |
| `Expires`, `Max-Age` | When to delete; `Max-Age` wins when both are present; neither means a session cookie | Session cookies vanish if you persist the jar carelessly |
| `Secure` | Send only over HTTPS | Your jar must not leak it over plain HTTP |
| `HttpOnly` | Hidden from page JavaScript | No effect on HTTP clients; it hints that this is the session cookie |
| `SameSite` | Browser rule for cross-site requests (`Strict`, `Lax`, `None`) | Browsers enforce it; HTTP-client jars mostly ignore it |
| `Partitioned` | Third-party cookie stored per top-level site (CHIPS) | Matters only inside browsers |
| `__Secure-`, `__Host-` name prefixes | Browser-enforced constraints on how the cookie was set | Useful clues about which cookie carries authentication |

RFC 6265 asks general-purpose clients to support at least 4096 bytes per cookie, 50 cookies per domain and 3000 cookies in total. Its successor draft, rfc6265bis, is what browsers implement today (for example, some browsers treat a missing `SameSite` as `Lax`).

## The jar: Python and Node

`requests.Session` and `httpx.Client` keep a jar for their lifetime. To survive between runs, back the client with a file jar. `MozillaCookieJar` uses the Netscape format, the same file format as `curl -c` and `curl -b`.

The flow below logs in only when needed, handles a CSRF token, and persists the session. It is the pattern for a site where you have an account and permission to automate.

```python
import os
from http.cookiejar import MozillaCookieJar

import httpx
from selectolax.lexbor import LexborHTMLParser

BASE = "https://example.com"
jar = MozillaCookieJar("session-cookies.txt")  # Netscape format, same as curl -c
if os.path.exists(jar.filename):
    jar.load(ignore_discard=True, ignore_expires=True)

with httpx.Client(cookies=jar, follow_redirects=True, timeout=15.0) as client:
    page = client.get(f"{BASE}/account")
    if page.url.path == "/login":  # session missing or expired: log in again
        form = client.get(f"{BASE}/login")
        token = LexborHTMLParser(form.text).css_first("input[name=csrf_token]").attributes["value"]
        resp = client.post(
            f"{BASE}/login",
            data={
                "csrf_token": token,
                "username": os.environ["SITE_USER"],
                "password": os.environ["SITE_PASSWORD"],
            },
        )
        resp.raise_for_status()  # 303 to /account is followed automatically
        page = client.get(f"{BASE}/account")
    print(page.status_code, page.url.path, LexborHTMLParser(page.text).css_first("h1").text())

jar.save(ignore_discard=True, ignore_expires=True)  # keep session cookies too
```

Node's built-in `fetch` stores no cookies at all. Pair it with `tough-cookie` (an RFC 6265 jar) through `fetch-cookie`:

```typescript
import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";

const jar = new CookieJar();
const fetchWithCookies = makeFetchCookie(fetch, jar); // Node's fetch keeps no cookies itself

const form = await fetchWithCookies("https://example.com/login");
const csrf = cheerio.load(await form.text())("input[name=csrf_token]").attr("value");

const login = await fetchWithCookies("https://example.com/login", {
  method: "POST",
  body: new URLSearchParams({
    csrf_token: csrf ?? "",
    username: process.env.SITE_USER ?? "",
    password: process.env.SITE_PASSWORD ?? "",
  }),
});
console.log(login.status, login.url); // 200 https://example.com/account (after the 303)
console.log(await jar.getCookieString("https://example.com/")); // sid=...
```

Browser automation keeps cookies per browser context and can save them as "storage state" ([Playwright](../browser-automation/playwright.md)). A common hybrid is to log in once with a browser, export the cookies, and continue with a plain HTTP client.

## CSRF tokens

Sites protect state-changing requests with a token the attacker cannot know. Your scraper, using its own session, simply has to read the token and send it back. Common framework conventions:

| Framework | Where the token appears | Where it goes back |
|---|---|---|
| Django | `csrftoken` cookie, `csrfmiddlewaretoken` form field | Form field or `X-CSRFToken` header |
| Rails | `<meta name="csrf-token">`, `authenticity_token` form field | Form field or `X-CSRF-Token` header |
| Laravel | `_token` form field, `XSRF-TOKEN` cookie | Form field, `X-CSRF-TOKEN` or `X-XSRF-TOKEN` header |
| Angular clients | `XSRF-TOKEN` cookie | `X-XSRF-TOKEN` header |

Decision rules:

- If you get 403 (or 419 on Laravel) right after a POST, suspect a stale or missing token. Fetch the form again in the same session and resend.
- If the token is per-form, fetch it immediately before each submission.
- If the token is in a cookie and must be echoed in a header (double-submit pattern), read it from the jar, not from a hard-coded value.

## Cookies that change content without a login

- **Locale and currency.** `lang`, `currency` or region cookies select what you parse. Set them explicitly and keep them constant.
- **Consent walls.** Some sites show a consent dialog instead of content until a choice is stored. If you replicate a choice, replicate "reject non-essential", never consent to tracking on nobody's behalf.
- **Experiments.** A/B bucket cookies can change markup between runs. Pin the bucket or expect two layouts.
- **Bot-management cookies.** Cookies set by JavaScript challenges belong to the site's defenses. Do not forge or harvest them; slow down and read [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md).

## Session lifecycle

- **Detect expiry explicitly**: a redirect to the login page, a 401 or 403, or a missing logged-in marker in a 200 page.
- **Re-authenticate at most once or twice per run.** Repeated logins look like credential stuffing and can lock the account.
- **Stop on MFA or CAPTCHA.** Do not automate around multi-factor prompts or challenges. Ask the operator for an API token, a service account or a data export ([Authentication Patterns](authentication-patterns.md)).
- **Respect the terms you accepted.** Logging in usually means agreeing to terms of service, which raises contract risk ([Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)).
- **Store jars as secrets**: outside git, encrypted at rest, readable only by the scraper ([Secrets and Configuration](../operations/secrets-and-config.md)).

## Pitfalls

- **A new client per request.** Every request starts a new session; CSRF tokens never match their session.
- **Saving a jar without `ignore_discard=True`.** `MozillaCookieJar.save()` silently drops session cookies (those without an expiry), producing a login loop.
- **Setting the `Cookie` header by hand.** Both requests and httpx drop a hand-set `Cookie` header on redirects and rebuild it from the jar, so the value disappears after the first redirect. Put cookies in the jar instead.
- **One session shared by concurrent workers** when the server keeps per-session state (search cursors, carts, filters). Workers overwrite each other's state.
- **Cookies in logs.** Debug logging of request headers prints session tokens. Redact `Cookie`, `Set-Cookie` and `Authorization`.
- **Assuming `HttpOnly` or `SameSite` protect anything in your client.** They are browser rules.
- **Logged-out pages that return 200.** The parser yields nothing and the run "succeeds". Check a logged-in marker.

## Checklist

- [ ] One cookie jar per identity, locale and purpose
- [ ] Jar persisted with session cookies kept, stored as a secret
- [ ] Login only when the session is missing or expired, with a cap on attempts
- [ ] CSRF token read from the same session, right before the POST
- [ ] Session expiry detected by redirect, status and page marker
- [ ] Stop and escalate on MFA, CAPTCHA or account warnings
- [ ] Locale, currency and consent cookies set explicitly
- [ ] Cookie and auth headers redacted from logs

## See Also

- [Authentication Patterns](authentication-patterns.md)
- [Request Headers That Matter](http-headers-for-scrapers.md)
- [Secrets and Configuration](../operations/secrets-and-config.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
- [Playwright](../browser-automation/playwright.md)
