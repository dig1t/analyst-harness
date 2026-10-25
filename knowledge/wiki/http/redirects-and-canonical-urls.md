---
tags: [scraping, http, redirects, canonical, deduplication]
aliases: [Redirects, 301 vs 302, Meta refresh, rel=canonical, Canonical URL]
---

# Redirects and Canonical URLs

> Sources: RFC 9110, section 15.4, Redirection 3xx (https://www.rfc-editor.org/rfc/rfc9110); RFC 6596, The Canonical Link Relation (https://www.rfc-editor.org/rfc/rfc6596); RFC 8288, Web Linking (https://www.rfc-editor.org/rfc/rfc8288); MDN, Redirections in HTTP (https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Redirections); Google Search Central, Redirects and Google Search (https://developers.google.com/search/docs/crawling-indexing/301-redirects); Google Search Central, How to specify a canonical URL (https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls); WHATWG HTML, meta refresh (https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-http-equiv-refresh)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A redirect says "this resource is answered elsewhere", either temporarily or permanently; a canonical link says "of the several URLs showing this content, this one is the primary". A scraper should follow redirects with a hop limit and loop detection, record the whole chain, update stored URLs only on permanent moves, know which redirects turn a POST into a GET, notice redirects that HTTP does not show (meta refresh, JavaScript), and keep credentials from following a redirect to another host. Canonical links are excellent deduplication keys once validated, but they are hints written by templates that can be wrong, so record the fetched URL, the final URL and the declared canonical separately.

## HTTP redirects

| Code | Permanent | What clients do with a POST | Store |
|---|---|---|---|
| 301 Moved Permanently | Yes | Usually switch to GET (allowed "for historical reasons") | New URL becomes the identifier |
| 302 Found | No | Switch to GET in practice | Keep the original URL |
| 303 See Other | No | Always GET (typical after a form POST) | Keep the original URL |
| 307 Temporary Redirect | No | Keep method and body | Keep the original URL |
| 308 Permanent Redirect | Yes | Keep method and body | New URL becomes the identifier |

This is what httpx 0.28 and requests 2.34 actually did when a POST with a body hit each redirect on a test server:

| Code | httpx | requests |
|---|---|---|
| 301, 302, 303 | GET, body dropped | GET, body dropped |
| 307, 308 | POST, body resent | POST, body resent |

Library defaults: requests follows redirects (up to 30, but not for HEAD); httpx follows only with `follow_redirects=True` (up to 20); Node's fetch follows up to 20 and, unlike a browser, `redirect: "manual"` exposes the 3xx status and `Location`; curl follows only with `-L` (up to 50). RFC 9110 asks clients to detect redirect loops; Googlebot follows up to 10 hops. Ten is a sensible cap for scrapers too.

Rules for following safely:

- **Resolve `Location` against the URL that answered**; it may be relative.
- **Credentials stay home.** httpx drops `Authorization` when a redirect leaves the origin (except a plain http to https upgrade); requests drops it when the host changes. Both rebuild `Cookie` from the jar, so a hand-set `Cookie` header disappears. Custom auth headers (`X-API-Key`) are not stripped automatically: follow cross-host redirects manually when you send them.
- **Watch where you land.** Redirects to `/login` (session expired), consent pages, a locale root such as `/en-us/`, the home page (a deleted item, effectively a soft 404) or a challenge page all need a different reaction than "parse".
- **Learn from permanent moves.** After a 301 or 308, update the stored URL so the next run skips the hop. After 302, 303 or 307, keep requesting the original.

## Redirects that HTTP does not show

- **Meta refresh**: `<meta http-equiv="refresh" content="0; url=/new-page">`, or the equivalent `Refresh` response header. Google treats an instant meta refresh as permanent and a delayed one as temporary.
- **JavaScript**: `location.href = ...`, `location.replace(...)`, `window.location = ...`. Simple cases can be read from inline scripts; anything computed needs a browser ([When You Need a Browser](../browser-automation/when-to-use-a-browser.md)).
- **Auto-submitting forms**: single sign-on flows return a page whose script POSTs a hidden form. Treat these as part of an authentication flow, not as content.

In a browser, HTTP redirects run first, JavaScript redirects during load next, and meta refresh only after the page has loaded.

## Following redirects by hand

Following manually gives you the chain for provenance, a loop guard, meta-refresh handling and the canonical link in one place:

```python
import re
from urllib.parse import urljoin

import httpx
from selectolax.lexbor import LexborHTMLParser

REFRESH_URL = re.compile(r"^\s*\d+(?:\.\d+)?\s*[;,]\s*(?:url\s*=\s*)?['\"]?([^'\"]+)", re.I)


def resolve(client: httpx.Client, url: str, max_hops: int = 10):
    """Follow HTTP and meta-refresh redirects by hand; return (response, chain, canonical)."""
    chain: list[str] = []
    while True:
        if url in chain or len(chain) >= max_hops:
            raise RuntimeError(f"redirect loop or too many hops: {chain + [url]}")
        chain.append(url)
        r = client.get(url)  # the client must have follow_redirects=False
        if r.is_redirect:  # 301, 302, 303, 307 or 308 with a Location header
            url = urljoin(url, r.headers["Location"])  # Location may be relative
            continue
        if "html" not in r.headers.get("content-type", ""):
            return r, chain, None
        doc = LexborHTMLParser(r.text)
        for meta in doc.css("meta[http-equiv]"):
            if meta.attributes.get("http-equiv", "").lower() == "refresh":
                m = REFRESH_URL.match(meta.attributes.get("content") or "")
                if m:
                    url = urljoin(str(r.url), m.group(1).strip())
                    break
        else:
            link = doc.css_first("link[rel~=canonical]")
            href = link.attributes.get("href") if link else None
            return r, chain, urljoin(str(r.url), href) if href else None


with httpx.Client(follow_redirects=False, timeout=15.0) as client:
    resp, chain, canonical = resolve(client, "https://example.com/old-product")
    print(resp.status_code, chain, canonical)
```

## Canonical URLs

Sites declare the preferred URL with `<link rel="canonical" href="...">` (RFC 6596) or, for PDFs and other non-HTML files, a `Link: <https://example.com/doc.pdf>; rel="canonical"` response header (RFC 8288). Related signals: `og:url`, `hreflang` alternates for language versions, and the URLs listed in sitemaps. Google treats redirects and `rel="canonical"` as strong signals and sitemap inclusion as a weak one, and still picks its own canonical when the signals disagree.

For a scraper, the canonical is a candidate identity, useful for collapsing `?utm_source=` variants, session ids and duplicate category paths ([Deduplication (URLs and Content)](../crawling/deduplication.md)). Validate it before trusting it:

```python
from urllib.parse import urlsplit


def choose_identity(final_url: str, canonical: str | None, allowed_hosts: frozenset[str] = frozenset()) -> str:
    """Adopt the declared canonical only when it is plausible; otherwise keep the final URL."""
    if not canonical:
        return final_url
    c, f = urlsplit(canonical), urlsplit(final_url)
    if c.scheme not in ("http", "https") or c.hostname not in allowed_hosts | {f.hostname}:
        return final_url  # cross-site canonical: syndication or a bug, decide per source
    if c.path in ("", "/") and f.path not in ("", "/"):
        return final_url  # every page pointing at the home page is a template bug
    return canonical


print(choose_identity("https://shop.example/p/123?utm_source=x", "https://shop.example/p/123"))
# https://shop.example/p/123
print(choose_identity("https://m.shop.example/p/123", "https://shop.example/p/123", frozenset({"shop.example"})))
# https://shop.example/p/123
```

Known canonical mistakes in the wild: every page pointing to the home page, paginated pages 2..N pointing to page 1 (do not collapse them, they hold different items), canonicals still on `http://` after an HTTPS migration, canonicals with tracking parameters, and canonicals that only appear in the rendered DOM because JavaScript inserts them. Normalize whatever you adopt with the same rules as every other URL ([URL Normalization and Canonicalization](../crawling/url-normalization.md)).

## Pitfalls

- **Following redirects without a cap**, or without loop detection.
- **Overwriting the identifier on temporary redirects**, so the next run asks for a URL the site never meant to keep.
- **Losing the chain.** Without it, you cannot explain why a record's URL differs from what you requested.
- **Sending API keys across hosts** because a custom header survived a cross-domain redirect.
- **Re-POSTing on 307 or 308 by surprise**, or losing the body on 301 and 302.
- **Treating a redirect to the login or home page as content.**
- **Missing meta refresh and JavaScript redirects** and parsing an interstitial page.
- **Trusting `rel="canonical"` blindly** and merging different pages into one record.

## Checklist

- [ ] Redirect cap (10) and loop detection
- [ ] Full chain, final URL and canonical stored with each record
- [ ] Stored URLs updated only after 301 or 308
- [ ] Auth headers kept from crossing hosts
- [ ] Landing pages checked (login, consent, home, challenge)
- [ ] Meta refresh handled; JavaScript redirects flagged for review
- [ ] Canonicals validated before being used as keys

## See Also

- [URL Normalization and Canonicalization](../crawling/url-normalization.md)
- [Deduplication (URLs and Content)](../crawling/deduplication.md)
- [HTTP Status Codes and How to React](http-status-codes.md)
- [Spider Traps and Crawl Hygiene](../crawling/spider-traps.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
