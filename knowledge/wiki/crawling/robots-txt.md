---
tags: [scraping, crawling, robots-txt, politeness, standards]
aliases: [robots.txt, Robots Exclusion Protocol, REP, RFC 9309, crawl-delay]
---

# robots.txt (RFC 9309)

> Sources: RFC 9309, Robots Exclusion Protocol, Koster, Illyes, Zeller and Sassman, September 2022 (https://www.rfc-editor.org/rfc/rfc9309); Google Search Central, How Google interprets the robots.txt specification (https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt); Google Search Central blog, A note on unsupported rules in robots.txt, 2019 (https://developers.google.com/search/blog/2019/07/a-note-on-unsupported-rules-in-robotstxt); Python documentation, urllib.robotparser (https://docs.python.org/3/library/urllib.robotparser.html); CPython issue gh-138907, Support RFC 9309 in robotparser (https://github.com/python/cpython/issues/138907); Protego parser (https://github.com/scrapy/protego); Google robots.txt parser (https://github.com/google/robotstxt)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

robots.txt is a plain-text file at the root of a host that tells crawlers which paths they may fetch. After 28 years as an informal convention it became an IETF standard, RFC 9309, in September 2022. The rules that matter in practice: use the group (or groups, merged) whose `user-agent` matches your product token, falling back to `*`; then among those `allow` and `disallow` rules the **longest matching pattern wins**, `allow` wins a tie, and no match means allowed. A 4xx response for robots.txt means "no restrictions", a 5xx or network failure means "assume everything is disallowed", and a cached copy should not be reused for more than 24 hours. `crawl-delay` is not part of the standard. The RFC itself states that these rules "are not a form of access authorization": they are a request from the site owner, and a well-behaved scraper honors them anyway.

## Where the file lives and what it covers

The RFC requires the file to be named `/robots.txt` (all lowercase) "in the top-level path of the service", UTF-8 encoded, served as `text/plain`. Scope is the authority it was fetched from: `https://example.com/robots.txt` says nothing about `https://shop.example.com/` or `http://example.com:8080/`. Cache and evaluate robots.txt per scheme, host and port.

## Syntax

A file is a sequence of **groups**. A group starts with one or more `user-agent` lines followed by `allow` and `disallow` rules. Field names are case-insensitive, `#` starts a comment, and unknown lines are ignored.

```text
# Applies to every crawler without a more specific group
User-agent: *
Disallow: /private/
Allow: /private/annual-report.html
Disallow: /*.pdf$
Disallow: /search

# Two user-agent lines share one group
User-agent: ExampleBot
User-agent: OtherBot
Disallow: /tmp/

Sitemap: https://www.example.com/sitemap.xml
```

`Sitemap` lines are "other records" in RFC terms: they are not part of any group and crawlers MAY use them (see [XML Sitemaps](sitemaps.md)).

## Choosing the group

1. Your crawler has a **product token**, which the RFC limits to letters, `_` and `-` (for example `ExampleBot`) and which SHOULD appear in your HTTP `User-Agent` header (see [Identifying Your Bot](../anti-bot/identifying-your-bot.md)).
2. Find groups whose `user-agent` value matches the token, case-insensitively. If several groups match, their rules MUST be combined into one group.
3. If no group matches, obey the group(s) with `user-agent: *`.
4. If neither exists, or the file has no groups, no rules apply.

A specific group **replaces** the `*` group, it does not extend it. In the example above, `ExampleBot` may fetch `/private/` because only its own group applies. Sites that want a rule for everyone must repeat it in every named group, and you must not merge `*` rules into a named group "to be safe" and call that RFC behavior.

## Matching rules

The RFC wording is short and precise: matching SHOULD be case-sensitive, MUST start at the first octet of the path, and "the most specific match is the match that has the most octets". If an `allow` and a `disallow` rule are equivalent, `allow` SHOULD be used. If nothing matches, the URI is allowed, and `/robots.txt` itself is always allowed.

- Match against the path plus query string (`/search?q=x`), never the fragment.
- `*` matches zero or more of any character; `$` anchors the end of the pattern. Without `$`, every pattern is a prefix match.
- Specificity is measured on the pattern, so `Allow: /private/annual-report.html` (27 octets) beats `Disallow: /private/` (9 octets).
- Empty `Disallow:` means "nothing is disallowed"; skip it rather than treating it as a zero-length rule.
- Normalize before comparing: non-ASCII characters are percent-encoded as UTF-8 (`/foo/bar/ツ` becomes `/foo/bar/%E3%83%84`), and escapes of unreserved characters are decoded (`/foo/bar/%62%61%7A` matches `/foo/bar/baz`). To match a literal `*` or `$` in a URL, a rule writes `%2A` or `%24`.

| URL path | Winning rule | Result |
|---|---|---|
| `/private/a.html` | `Disallow: /private/` | blocked |
| `/private/annual-report.html` | `Allow: /private/annual-report.html` (longer) | allowed |
| `/files/report.pdf` | `Disallow: /*.pdf$` | blocked |
| `/files/report.pdf?v=2` | none (`$` anchors the end) | allowed |
| `/searchresults` | `Disallow: /search` (prefix) | blocked |

## Fetching: status codes, redirects and limits

| Outcome | RFC 9309 meaning | What to do |
|---|---|---|
| 2xx | Rules available | Parse every line you can; use the parseable rules |
| 3xx | Redirect | Follow at least five hops, even across hosts; apply the result to the original host. More than five: MAY treat as unavailable |
| 4xx ("unavailable") | No robots.txt | MAY crawl everything |
| 5xx or network error ("unreachable") | Undefined | MUST assume complete disallow; after a long outage (the RFC's example is 30 days) MAY treat as unavailable or keep using a cached copy |

Two practical refinements. The RFC does not single out 429, but Google documents that it treats 429 like a 5xx, and so should you: a rate-limited robots.txt fetch is a signal to slow down, not permission. Some parsers (CPython's included) treat 401 and 403 as "disallow all", which is stricter than the RFC; that conservative choice is fine. Parsers SHOULD impose a size limit, and the limit MUST be at least 500 KiB; Google ignores content beyond 500 KiB.

## Caching

Crawlers MAY cache robots.txt and MAY honor standard HTTP cache headers, but SHOULD NOT reuse a copy for more than 24 hours unless the file is unreachable. Keep the last good copy per origin: when a refresh hits a 5xx, continue with the old rules instead of flipping to "allow all".

## Non-standard extensions

- **Crawl-delay**: not in RFC 9309. Google ignores it; Bing has historically honored it. The common reading is "minimum seconds between requests". Treat it as a floor for your per-host delay (see [Politeness and Rate Limiting](politeness-and-rate-limiting.md)). CPython's `crawl_delay()` only accepts whole numbers, so `Crawl-delay: 0.5` comes back as `None`; Protego returns floats.
- **Request-rate**, **Host**, **Clean-param**: legacy or engine-specific; parse them if you like, never rely on them.
- **Noindex in robots.txt**: Google stopped honoring it in September 2019. Indexing control belongs in `<meta name="robots">` or the `X-Robots-Tag` header.
- **AI-specific tokens** such as `GPTBot` or `Google-Extended` are ordinary product tokens; see [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md).

## Code: an RFC 9309 evaluator

This is a compact, tested implementation of the rules above. It is meant to make the semantics concrete; in production, use a maintained parser and test it with the same cases.

```python
"""Minimal RFC 9309 evaluator: group selection, longest match, allow wins ties."""
import re
from urllib.parse import urlsplit

UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
_ESCAPE = re.compile(r"%([0-9A-Fa-f]{2})")


def normalize(path: str) -> str:
    """Encode non-ASCII as UTF-8 escapes, decode escaped unreserved chars, uppercase hex."""
    path = "".join(c if ord(c) < 128 else "".join(f"%{b:02X}" for b in c.encode()) for c in path)

    def fix(m: re.Match) -> str:
        ch = chr(int(m.group(1), 16))
        return ch if ch in UNRESERVED else "%" + m.group(1).upper()

    return _ESCAPE.sub(fix, path)


class Rule:
    def __init__(self, allow: bool, pattern: str):
        self.allow = allow
        self.pattern = normalize(pattern)
        self.length = len(self.pattern.encode())  # specificity = octets in the pattern
        anchored = self.pattern.endswith("$")
        body = self.pattern[:-1] if anchored else self.pattern
        regex = ".*".join(re.escape(part) for part in body.split("*"))
        self.regex = re.compile(regex + (r"\Z" if anchored else ""), re.DOTALL)

    def matches(self, target: str) -> bool:
        return self.regex.match(target) is not None


class Robots:
    def __init__(self, text: str):
        self.groups: list[tuple[set[str], list[Rule]]] = []
        self.sitemaps: list[str] = []
        agents: set[str] | None = None
        rules: list[Rule] = []
        in_rules = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            key, value = (s.strip() for s in line.split(":", 1))
            key = key.lower()
            if key == "user-agent":
                if agents is None or in_rules:          # a new group starts
                    agents, rules, in_rules = set(), [], False
                    self.groups.append((agents, rules))
                token = "*" if value.startswith("*") else re.match(r"[A-Za-z_-]*", value).group(0)
                agents.add(token.lower())
            elif key in ("allow", "disallow"):
                if agents is None:
                    continue                          # rule before any user-agent line
                in_rules = True
                if value:                             # empty value: no restriction
                    rules.append(Rule(key == "allow", value))
            elif key == "sitemap":
                self.sitemaps.append(value)           # not part of any group

    def rules_for(self, product_token: str) -> list[Rule]:
        token = product_token.lower()
        matched = [r for agents, rs in self.groups if token in agents for r in rs]
        if any(token in agents for agents, _ in self.groups):
            return matched                            # all matching groups combined
        return [r for agents, rs in self.groups if "*" in agents for r in rs]

    def allowed(self, url: str, product_token: str) -> bool:
        parts = urlsplit(url)
        target = normalize((parts.path or "/") + (f"?{parts.query}" if parts.query else ""))
        target = target.replace("*", "%2A").replace("$", "%24")  # literal chars in the URL
        if target == "/robots.txt":
            return True
        best: Rule | None = None
        for rule in self.rules_for(product_token):
            if rule.matches(target) and (
                best is None
                or rule.length > best.length
                or (rule.length == best.length and rule.allow)
            ):
                best = rule
        return True if best is None else best.allow
```

Fetching and caching, with the status handling from the table (save the evaluator as `robots9309.py`):

```python
import time
from urllib.parse import urlsplit

import httpx

from robots9309 import Robots

ALLOW_ALL, DISALLOW_ALL = Robots(""), Robots("User-agent: *\nDisallow: /\n")
MAX_BYTES = 500 * 1024          # RFC 9309: parse at least 500 KiB
TTL = 24 * 3600                 # RFC 9309: do not reuse a copy for more than 24 hours


class RobotsCache:
    def __init__(self, client: httpx.AsyncClient, product_token: str):
        self.client, self.token = client, product_token
        self.cache: dict[str, tuple[float, Robots]] = {}   # origin -> (expires_at, rules)

    async def allowed(self, url: str) -> bool:
        p = urlsplit(url)
        origin = f"{p.scheme}://{p.netloc}"               # scheme + host + port
        expires, robots = self.cache.get(origin, (0.0, None))
        if robots is None or time.time() >= expires:
            robots, ttl = await self._fetch(origin, previous=robots)
            self.cache[origin] = (time.time() + ttl, robots)
        return robots.allowed(url, self.token)

    async def _fetch(self, origin: str, previous: Robots | None) -> tuple[Robots, float]:
        try:
            # the client is built with max_redirects=5 (RFC: follow at least five)
            r = await self.client.get(f"{origin}/robots.txt", follow_redirects=True)
        except httpx.TooManyRedirects:
            return ALLOW_ALL, TTL                     # MAY treat as unavailable
        except httpx.TransportError:
            return previous or DISALLOW_ALL, 600      # unreachable: complete disallow, retry soon
        if r.is_success:
            text = r.content[:MAX_BYTES].decode("utf-8-sig", errors="replace")
            return Robots(text), TTL
        if r.status_code == 429 or r.status_code >= 500:
            return previous or DISALLOW_ALL, 600      # unreachable: keep old copy or disallow
        return ALLOW_ALL, TTL                         # other 4xx: unavailable, no restrictions
```

Create the client as `httpx.AsyncClient(max_redirects=5, headers={"User-Agent": "ExampleBot/1.0 (+https://example.org/bot)"}, timeout=10)` and call `await cache.allowed(url)` before every fetch.

## Parsers in the wild

- **Python `urllib.robotparser`**: CPython adopted RFC 9309 matching (longest match, `allow` on ties, `*` and `$`, merged groups) in 2026 under gh-138907, in 3.15 and backported to maintenance releases. Older interpreters use **first match in file order** and treat `*` inside paths literally, which silently gives wrong answers on modern files. Test your interpreter with the table above. Pass the bare product token (`"ExampleBot"`), not your full User-Agent string, and fetch the file yourself (with your own User-Agent and timeouts) and call `parse()`, because `read()` uses urllib defaults. `can_fetch()` returns `False` until `read()` or `parse()` has run.
- **Protego**: Scrapy's default `ROBOTSTXT_PARSER`, used when `ROBOTSTXT_OBEY = True` (off in Scrapy's global defaults, on in the `startproject` template). Supports wildcards and longest match, returns float crawl delays. See [Scrapy](../tools/scrapy.md).
- **google/robotstxt**: the C++ library Google open-sourced alongside the standardization effort; the closest thing to a reference implementation.
- Whatever you use, keep a regression test with the RFC examples (merged groups, `$` anchors, percent-encoding, ties).

## Pitfalls

- Using first-match semantics (old Python, hand-rolled code) and crawling paths the site meant to block, or the reverse.
- Assuming a named group inherits `*` rules, or ignoring a named group that matches your token.
- Treating a 5xx or timeout on robots.txt as "no file, crawl everything".
- Fetching robots.txt once per run and never refreshing on long crawls, or refetching it for every request.
- Evaluating rules for `example.com` against `www.example.com` or `http` against `https`.
- Reading `Disallow:` (empty) as "disallow everything".
- Treating robots.txt as permission. Allowed paths are still subject to terms, rate limits, personal-data law and copyright (see [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)).
- Probing paths listed under `Disallow` because they look interesting. Listing a path is not an invitation.

## Checklist

- [ ] One cached robots.txt per scheme, host and port, refreshed at least every 24 hours.
- [ ] 2xx parsed, 4xx treated as allow-all, 5xx/429/network errors treated as disallow-all (or last good copy).
- [ ] Redirects followed up to five hops; at least 500 KiB parsed.
- [ ] Group chosen by product token, case-insensitively, merged across groups, `*` only as a fallback.
- [ ] Longest match with `allow` winning ties; `*`, `$` and percent-encoding handled; tested against RFC examples.
- [ ] `Crawl-delay` honored as a minimum delay even though it is non-standard.
- [ ] Product token appears in the User-Agent header with contact information.

## See Also

- [XML Sitemaps](sitemaps.md)
- [Politeness and Rate Limiting](politeness-and-rate-limiting.md)
- [Crawler Architecture](crawler-architecture.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)
