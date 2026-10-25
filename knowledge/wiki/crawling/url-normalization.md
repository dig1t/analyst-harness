---
tags: [scraping, crawling, urls, normalization, deduplication]
aliases: [URL canonicalization, URL normalisation, canonical URL key, URL cleaning]
---

# URL Normalization and Canonicalization

> Sources: RFC 3986, Uniform Resource Identifier (URI): Generic Syntax, sections 5.2.4 and 6 (https://www.rfc-editor.org/rfc/rfc3986); WHATWG URL Living Standard (https://url.spec.whatwg.org/); Unicode Technical Standard #46, IDNA Compatibility Processing (https://www.unicode.org/reports/tr46/); Google Search Central, How to specify a canonical URL (https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls); w3lib URL utilities (https://w3lib.readthedocs.io/en/latest/w3lib.html#module-w3lib.url)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

The same page can be reached through dozens of URL spellings: different letter case in the host, an explicit `:443`, `./` segments, `%7E` versus `~`, reordered query parameters, `utm_source` tags, session ids, fragments. A crawler that treats each spelling as new wastes requests, inflates its frontier and produces duplicate records. Normalization maps spellings to one **key**. It comes in two layers: **safe normalizations** from RFC 3986 that never change which resource is identified, and **site-specific canonicalization** (dropping tracking parameters, choosing `www` or not, trailing slashes) that is only correct when you have evidence for it. Keep the original URL for fetching and store the normalized key next to it for deduplication.

## Safe normalizations (RFC 3986)

RFC 3986 section 6.2 describes a ladder of normalizations. The first two rungs are always safe for `http` and `https`:

| Step | RFC section | Example |
|---|---|---|
| Lowercase scheme and host | 6.2.2.1 | `HTTP://Example.COM/` to `http://example.com/` |
| Uppercase hex digits in escapes | 6.2.2.1 | `%2f` to `%2F` |
| Decode escapes of unreserved characters (`A-Z a-z 0-9 - . _ ~`) | 6.2.2.2 | `/%7Euser` to `/~user` |
| Remove dot segments (algorithm in 5.2.4) | 6.2.2.3 | `/a/./b/../c` to `/a/c` |
| Drop the default port | 6.2.3 | `https://example.com:443/` to `https://example.com/` |
| Empty path becomes `/` | 6.2.3 | `https://example.com` to `https://example.com/` |

Two more steps are safe for crawling even though they are not in that list: drop the **fragment** (`#section`), which browsers never send to the server, and convert internationalized host names to their ASCII (punycode) form, `bücher.example` to `xn--bcher-kva.example`, following UTS #46 as browsers do.

Section 6.2.4, protocol-based normalization (is `/data` the same as `/data/`?), cannot be decided from the string. Only the server knows, and it tells you through redirects and `rel=canonical` (see [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md)).

## Unsafe "normalizations" to avoid by default

- **Lowercasing the path or query.** Paths are case-sensitive on most servers; `/Report.PDF` and `/report.pdf` can be different files.
- **Decoding reserved characters.** `%2F` inside a path segment is not a `/`; `%26` inside a value is not a parameter separator.
- **Adding or removing trailing slashes, `index.html`, or `www.`** without checking that both forms return the same content (or redirect to each other).
- **Dropping the whole query string.** On many sites the query is the content (`?id=123`, `?page=2`).
- **Assuming `+` equals `%20` in paths.** `+` means space only in `application/x-www-form-urlencoded` query strings.
- **Sorting parameters for every site.** Usually harmless, but some applications depend on order or on repeated keys (`?tag=a&tag=b`). Sort for the dedupe key; fetch with the original.

## Tracking and session parameters

Marketing and analytics parameters do not change content and are the biggest source of duplicates: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `gclid`, `gbraid`, `wbraid`, `dclid`, `fbclid`, `msclkid`, `yclid`, `mc_cid`, `mc_eid`, `_ga`, `_gl`, `igshid`, `ttclid`, `twclid`, `li_fat_id`, `mkt_tok`, `_hsenc`, `_hsmi`. Session identifiers in URLs (`jsessionid`, `PHPSESSID`, `sid`, `sessionid`) create a fresh URL for every visit and are a classic spider trap (see [Spider Traps and Crawl Hygiene](spider-traps.md)).

A global blocklist is a good start, but per-site **allowlists** are more robust: once you know that a listing page only varies by `category` and `page`, keep exactly those parameters and drop everything else.

## Resolving relative links

Normalize only absolute URLs. Resolve each `href` against the right base first: the final URL after redirects (not the URL you requested), or the document's `<base href>` if present. Use the library resolver (`urllib.parse.urljoin`, `new URL(href, base)`) rather than string concatenation; it implements the RFC 3986 merge and dot-segment rules. Skip `javascript:`, `mailto:`, `tel:` and `data:` links.

## Python implementation

Tested with Python 3.13; standard library only. The built-in `idna` codec implements the older IDNA 2003 rules; install the `idna` package if you need full UTS #46 behavior.

```python
import re
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

DEFAULT_PORTS = {"http": 80, "https": 443}
TRACKING = re.compile(
    r"^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|mc_cid|mc_eid"
    r"|_ga|_gl|igshid|ttclid|twclid|li_fat_id|mkt_tok|_hsenc|_hsmi)$",
    re.IGNORECASE,
)
SESSION = re.compile(r"^(jsessionid|phpsessid|sid|sessionid|aspsessionid\w*)$", re.IGNORECASE)
UNRESERVED_ESCAPE = re.compile(r"%(?:4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A]|3[0-9]|2[DE]|5F|7E)", re.I)


def _fix_escapes(s: str, safe: str) -> str:
    """Decode escaped unreserved chars, uppercase other escapes, encode what must be encoded."""
    s = UNRESERVED_ESCAPE.sub(lambda m: chr(int(m.group(0)[1:], 16)), s)
    s = re.sub(r"%[0-9a-f]{2}", lambda m: m.group(0).upper(), s)
    return quote(s, safe=safe + "%")          # keep existing escapes, encode spaces/non-ASCII


def remove_dot_segments(path: str) -> str:
    """RFC 3986 section 5.2.4."""
    out: list[str] = []
    for seg in path.split("/"):
        if seg == "..":
            if len(out) > 1:
                out.pop()
        elif seg != ".":
            out.append(seg)
    if path.endswith(("/.", "/..")):
        out.append("")
    return "/".join(out) or "/"


def normalize_url(url: str, sort_query: bool = True) -> str:
    p = urlsplit(url.strip())
    scheme = p.scheme.lower()
    host = (p.hostname or "").rstrip(".").encode("idna").decode("ascii")  # lowercases too
    port = p.port
    netloc = host if port in (None, DEFAULT_PORTS.get(scheme)) else f"{host}:{port}"
    if p.username:                                   # keep credentials only if present
        netloc = f"{p.username}{':' + p.password if p.password else ''}@{netloc}"
    path = remove_dot_segments(_fix_escapes(p.path or "/", safe="/:@!$&'()*+,;="))
    path = re.sub(r";jsessionid=[^/?#]*", "", path, flags=re.IGNORECASE)  # path-style session ids
    pairs = [
        (k, v) for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not TRACKING.match(k) and not SESSION.match(k)
    ]
    if sort_query:
        pairs.sort()
    query = urlencode(pairs, quote_via=quote)        # spaces become %20, not +
    return urlunsplit((scheme, netloc, path, query, ""))  # fragment dropped


assert normalize_url("HTTP://Example.COM:80/a/./b/../c/%7euser?b=2&a=1&utm_source=x#top") \
    == "http://example.com/a/c/~user?a=1&b=2"
assert normalize_url("https://bücher.example/x?fbclid=1&id=7") == "https://xn--bcher-kva.example/x?id=7"
assert normalize_url("https://example.com/a;jsessionid=AB12/b?PHPSESSID=z&page=2") \
    == "https://example.com/a/b?page=2"
```

Note the trade-offs baked in: `parse_qsl` decodes `+` as a space, and a bare `?flag` becomes `?flag=`. Both are fine for a dedupe key and are exactly why you should fetch with the original URL.

## TypeScript implementation

The WHATWG URL parser (Node, Deno, browsers) already lowercases the host, drops default ports, resolves dot segments and punycodes host names. It does **not** decode `%7E` to `~`, and touching `searchParams` re-serializes the whole query as form data (`%20` becomes `+`, `?flag` becomes `?flag=`).

```typescript
const TRACKING =
  /^(utm_[a-z_]+|gclid|gbraid|wbraid|dclid|fbclid|msclkid|yclid|mc_cid|mc_eid|_ga|_gl|igshid|ttclid|twclid|li_fat_id|mkt_tok|_hsenc|_hsmi)$/i;

export function normalizeUrl(input: string, base?: string): string {
  const url = new URL(input, base); // also resolves relative links against base
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort(); // stable order for the dedupe key
  return url.href;
}

// "http://example.com/a/c/%7euser?a=1&b=2"
console.log(normalizeUrl("HTTP://Example.COM:80/a/./b/../c/%7euser?b=2&a=1&utm_source=x#frag"));
// "https://example.com/img/logo.png"
console.log(normalizeUrl("../img/logo.png", "https://example.com/docs/page.html"));
```

Python's `urllib.parse` and the WHATWG parser disagree on edge cases (backslashes, IPv4 shorthand like `http://0x7f.1/`, whitespace, non-special schemes). If a browser is the ground truth for your site, prefer a WHATWG implementation.

## Libraries

- **w3lib** (`w3lib.url.canonicalize_url`, from the Scrapy project) sorts query arguments, drops fragments, lowercases the host and fixes percent-encoding. In a quick test it kept `:80` and `utm_source` and encoded a space in the query as `+`, so add your own port and tracking-parameter rules on top.
- **SURT keys**: web archives store URLs in Sort-friendly URI Reordering Transform form, for example `com,example)/a/c?a=1`, which groups a whole domain together in sorted indexes. It doubles as a good dedupe key; see [Common Crawl and Web Archives](common-crawl-and-archives.md).

## Server-declared canonicals

After fetching, two signals beat any string rule: a permanent redirect (301, 308) to another URL, and `<link rel="canonical" href="...">`. Record both. Treat `rel=canonical` as a hint, not a fact: it can point to a different host, to the homepage (a common misconfiguration), or be missing on paginated pages. Merge two URLs only when the canonical target is on a host you crawl and the content hashes agree (see [Deduplication](deduplication.md)).

## Pitfalls

- Normalizing before resolving relative links, or resolving against the pre-redirect URL.
- Fetching with the normalized URL when the server is picky about parameter order or encoding.
- A tracking blocklist that removes a parameter the site actually uses (`ref`, `source`, `sid` sometimes carry real meaning).
- Mixing normalization versions: changing the rules mid-crawl splits your seen-set. Version the normalizer and store the version with each key.
- Ignoring IDNs and trailing dots in hosts (`example.com.`), which produce separate keys for one site.

## Checklist

- [ ] Resolve against the final URL or `<base href>`, then normalize.
- [ ] Apply RFC 3986 case, percent-encoding, dot-segment and default-port rules; drop fragments; punycode hosts.
- [ ] Strip known tracking and session parameters; prefer per-site allowlists.
- [ ] Never lowercase paths, decode reserved characters or change trailing slashes without evidence.
- [ ] Store original URL, normalized key and normalizer version together.
- [ ] Use redirects, `rel=canonical` and content hashes to merge what string rules cannot.

## See Also

- [Deduplication (URLs and Content)](deduplication.md)
- [Spider Traps and Crawl Hygiene](spider-traps.md)
- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [Redirects and Canonical URLs](../http/redirects-and-canonical-urls.md)
- [HTTP Fundamentals](../http/http-fundamentals.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
