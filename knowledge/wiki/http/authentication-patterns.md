---
tags: [scraping, http, authentication, oauth, secrets]
aliases: [Auth patterns, API keys, Bearer tokens, OAuth2, Client credentials, Basic auth]
---

# Authentication Patterns

> Sources: RFC 9110, section 11, HTTP Authentication (https://www.rfc-editor.org/rfc/rfc9110); RFC 7617, Basic (https://www.rfc-editor.org/rfc/rfc7617); RFC 6750, Bearer Token Usage (https://www.rfc-editor.org/rfc/rfc6750); RFC 6749, OAuth 2.0 (https://www.rfc-editor.org/rfc/rfc6749); RFC 7636, PKCE (https://www.rfc-editor.org/rfc/rfc7636); RFC 8628, Device Authorization Grant (https://www.rfc-editor.org/rfc/rfc8628); RFC 9700, OAuth 2.0 Security Best Current Practice (https://www.rfc-editor.org/rfc/rfc9700); OAuth 2.1 draft (https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/); MDN, HTTP authentication (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Authentication); OWASP Secrets Management Cheat Sheet (https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Authentication proves who is calling; authorization decides what that caller may read. For data acquisition, prefer credentials designed for automation: an API key, a personal or service access token, or OAuth client credentials issued for your application. Use OAuth flows with a consenting user when you act on someone's behalf, and fall back to scripted form logins only for an account you own, on a site that allows automation, when no API exists. Some boundaries are fixed: do not automate around multi-factor prompts or CAPTCHAs, do not share or borrow accounts, and do not use credentials you were not given. Keep every secret out of code and logs, scope it to read-only, and know how to revoke it in minutes.

## The patterns at a glance

| Pattern | On the wire | Typical use | Notes |
|---|---|---|---|
| Basic (RFC 7617) | `Authorization: Basic base64(user:pass)` | Internal services, simple APIs | Base64 is encoding, not encryption: HTTPS only |
| Digest (RFC 7616) | Challenge and response | Rare legacy devices and APIs | httpx has `DigestAuth` |
| API key | `X-API-Key: ...`, `Authorization: Api-Key ...` or `?api_key=` | Most data APIs | Prefer a header; query strings end up in logs |
| Bearer token (RFC 6750) | `Authorization: Bearer <token>` | Personal access tokens, OAuth access tokens, JWTs | Whoever holds it can use it |
| OAuth 2.0 (RFC 6749) | Tokens from a token endpoint | Machine access, delegated user access | Choose the grant carefully (below) |
| Session cookie | `Cookie: sid=...` after a form login | Sites without an API | See [Cookies, Sessions and State](cookies-and-sessions.md) |
| Mutual TLS | Client certificate in the handshake | B2B and financial APIs | See [TLS and HTTPS for Scrapers](tls-and-https.md) |
| Signed requests | HMAC signature headers (for example AWS Signature Version 4) | Cloud and partner APIs | Use the provider's SDK |

A 401 response must carry a `WWW-Authenticate` challenge naming the scheme the server expects (RFC 9110, section 15.5.2); read it when an endpoint rejects you.

## Keys, Basic and bearer tokens in code

```python
import os

import httpx

# Credentials come from the environment or a secret manager, never from source code.
api = httpx.Client(
    base_url="https://api.example.com",
    headers={"X-API-Key": os.environ["EXAMPLE_API_KEY"], "Accept": "application/json"},
    timeout=15.0,
)
token_client = httpx.Client(headers={"Authorization": f"Bearer {os.environ['EXAMPLE_TOKEN']}"}, timeout=15.0)
basic_client = httpx.Client(auth=(os.environ["SVC_USER"], os.environ["SVC_PASSWORD"]), timeout=15.0)
```

```typescript
const res = await fetch("https://api.example.com/v1/items?page=1", {
  headers: { Authorization: `Bearer ${process.env.EXAMPLE_TOKEN}`, Accept: "application/json" },
  signal: AbortSignal.timeout(15_000),
});
if (res.status === 401) throw new Error(`token rejected: ${res.headers.get("www-authenticate")}`);
```

Many sites that look login-only offer tokens in account settings (for example GitHub's fine-grained personal access tokens). A token beats a scripted login: it is scoped, revocable, and does not trip login defenses.

## OAuth 2.0: picking the grant

| Grant | Use when | Notes |
|---|---|---|
| Client credentials (RFC 6749, 4.4) | Your service reads an API as itself | No user involved; cache the token until `expires_in` |
| Authorization code with PKCE (RFC 7636) | You act for a user who signs in once in a browser | Store the refresh token as a secret; PKCE is mandatory in the OAuth 2.1 draft |
| Device authorization (RFC 8628) | A CLI or headless job needs a user's consent | The user approves on another device |
| Refresh token | Renewing access without the user | Providers may rotate it: persist the new one every time |
| Implicit, resource owner password | Never | RFC 9700 deprecates them and OAuth 2.1 omits them |

A client credentials flow with token caching, early renewal and one retry on 401, written as an `httpx.Auth` so it works for sync and async clients:

```python
import base64
import time
from urllib.parse import quote_plus

import httpx


class ClientCredentialsAuth(httpx.Auth):
    """OAuth 2.0 client credentials grant (RFC 6749, section 4.4) with token caching.

    The token request is yielded from the auth flow, so the same class works with
    httpx.Client and httpx.AsyncClient. Not thread-safe: use one instance per worker.
    """

    requires_response_body = True  # the flow reads the token endpoint's JSON

    def __init__(self, token_url: str, client_id: str, client_secret: str, scope: str | None = None):
        self.token_url, self.scope = token_url, scope
        # RFC 6749 section 2.3.1: form-encode id and secret, then use HTTP Basic.
        pair = f"{quote_plus(client_id)}:{quote_plus(client_secret)}".encode()
        self._basic = "Basic " + base64.b64encode(pair).decode()
        self._token: str | None = None
        self._expires_at = 0.0

    def _token_request(self) -> httpx.Request:
        data = {"grant_type": "client_credentials"}
        if self.scope:
            data["scope"] = self.scope
        return httpx.Request("POST", self.token_url, data=data, headers={"Authorization": self._basic})

    def _store(self, response: httpx.Response) -> None:
        response.raise_for_status()
        payload = response.json()
        lifetime = float(payload.get("expires_in", 300))
        self._token = payload["access_token"]
        self._expires_at = time.monotonic() + lifetime - min(60.0, lifetime * 0.1)  # renew early

    def auth_flow(self, request: httpx.Request):
        if self._token is None or time.monotonic() >= self._expires_at:
            self._store((yield self._token_request()))
        request.headers["Authorization"] = f"Bearer {self._token}"
        response = yield request
        if response.status_code == 401:  # revoked or expired early: renew once, retry once
            self._store((yield self._token_request()))
            request.headers["Authorization"] = f"Bearer {self._token}"
            yield request


auth = ClientCredentialsAuth("https://auth.example.com/oauth/token", "my-client", "my-secret", scope="read")
with httpx.Client(auth=auth, timeout=15.0) as client:
    items = client.get("https://api.example.com/v1/items").json()
```

Against a test token server issuing two-second tokens, this class fetched one token for consecutive calls, renewed it after expiry, and recovered from a server-side revocation with exactly one extra token request. For full OAuth clients (authorization code, PKCE, token storage), use a maintained library such as Authlib or requests-oauthlib in Python, or openid-client in Node, instead of hand-rolling redirects and state checks.

## Form logins

When no API or token exists and you have permission to automate your own account, script the login exactly as the site's form does: fetch the page, read the CSRF token, POST the fields, follow the 303, confirm a logged-in marker, persist the session, and re-login only on expiry. The full pattern and its pitfalls are in [Cookies, Sessions and State](cookies-and-sessions.md).

## Boundaries you do not cross

- **Multi-factor authentication** exists to prove a human is present. Do not script MFA prompts. Ask for credentials meant for automation (API tokens, service accounts, app-specific passwords where offered) or a data export.
- **CAPTCHAs at login** mean the site does not want automated logins. Stop ([CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)).
- **Shared, bought or borrowed accounts** breach terms of service and can create legal exposure for access beyond what you were authorized to do ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)).
- **Other people's data behind a login** is usually personal data with its own obligations ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Credential hygiene

- **Storage:** environment variables injected from a secret manager; never in code, notebooks, specs, issue trackers or git history. Run secret scanning on commits ([Secrets and Configuration](../operations/secrets-and-config.md)).
- **Least privilege:** read-only scopes, one credential per scraper and environment, so revoking one breaks one job.
- **Rotation:** scheduled, and immediately after a leak or staff change. Persist rotated refresh tokens atomically.
- **Redaction:** strip `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key` and token query parameters from logs, traces and saved "Copy as cURL" commands.
- **No secrets in URLs:** query-string keys leak through logs, proxies and `Referer`.
- **Know your implicit sources:** requests silently uses `~/.netrc` credentials when no auth is set (`trust_env`), curl does with `-n`, and httpx offers `NetRCAuth`.
- **Redirects:** clients drop `Authorization` when a redirect leaves the origin, but custom headers such as `X-API-Key` follow it ([Redirects and Canonical URLs](redirects-and-canonical-urls.md)).

## Pitfalls

- **Hard-coded tokens** that end up in git, screenshots or a shared notebook.
- **Ignoring `expires_in`**, so every request after an hour fails with 401.
- **Refreshing on every 401 forever**: a revoked credential becomes a request storm. Retry once, then stop.
- **Dropping the rotated refresh token** and losing access on the next run.
- **One all-powerful key** shared by every job and every environment.
- **Logging request headers at debug level** in production.
- **Using the password grant** because it is "simpler": it is deprecated for good reasons.

## Checklist

- [ ] Official API credentials or tokens preferred over scripted logins
- [ ] Secrets loaded from a secret store, scanned for in git, never logged
- [ ] Read-only scopes, one credential per job and environment
- [ ] Token expiry handled with early renewal and a single 401 retry
- [ ] Rotated refresh tokens persisted
- [ ] MFA, CAPTCHA and account warnings stop the job and alert a human
- [ ] Revocation procedure written down and tested

## See Also

- [Cookies, Sessions and State](cookies-and-sessions.md)
- [Secrets and Configuration](../operations/secrets-and-config.md)
- [Consuming REST APIs Well](../apis/rest-api-consumption.md)
- [API Rate Limits and Quotas](../apis/api-rate-limits.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
- [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)
