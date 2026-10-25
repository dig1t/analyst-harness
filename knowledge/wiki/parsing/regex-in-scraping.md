---
tags: [scraping, parsing, regex, text-processing]
aliases: [regex, regular expressions, re module, ReDoS, catastrophic backtracking]
---

# Regular Expressions: When and When Not

> Sources: Python documentation, re module (https://docs.python.org/3/library/re.html); Python documentation, Regular Expression HOWTO (https://docs.python.org/3/howto/regex.html); regex package (https://pypi.org/project/regex/); MDN Web Docs, Regular expressions guide (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Regular_expressions); OWASP, Regular expression Denial of Service (https://owasp.org/www-community/attacks/Regular_expression_Denial_of_Service_-_ReDoS); RE2 syntax reference (https://github.com/google/re2/wiki/Syntax)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Regular expressions are a text tool, not a document tool. They are excellent for cleaning strings you already extracted, pulling identifiers out of URLs and script text, validating formats and splitting numbers from units. They are the wrong tool for HTML structure: markup nests, attribute order and quoting vary, and comments and scripts contain look-alike text, so a pattern that works on one page silently returns wrong data on the next. The rule: parse structure with a parser (see [CSS Selectors for Extraction](css-selectors.md) and [XPath for Extraction](xpath.md)), then apply small, anchored patterns to small strings. Know the engine's semantics (in Python `\d` matches Arabic-Indic and fullwidth digits, in JavaScript it does not), and avoid nested quantifiers, which can make matching time explode on hostile or simply long input.

## Good and bad uses

| Task | Regex? | Better tool or follow-up |
|---|---|---|
| Product id from a URL path | Yes | `urllib.parse` for query parameters |
| Locate a JavaScript assignment that holds JSON | Yes, to locate | `json` or chompjs to parse ([JSON and Embedded Data](json-and-embedded-data.md)) |
| Collapse whitespace, strip zero-width characters | Yes | |
| Split `12.5 kg` into value and unit | Yes | |
| Validate a SKU or ISO date shape | Yes, with `fullmatch` | Then parse with `datetime` |
| Find a price token in a sentence | Yes | Interpret with a locale-aware parser ([Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)) |
| All links in a page | No | `a[href]` with a parser |
| Text of an element with nested tags | No | `normalize-space()` or `get_text(" ", strip=True)` |
| A table | No | [Extracting HTML Tables](html-tables.md) |
| JSON or a query string | No | `json.loads`, `urllib.parse.parse_qs` |

## Why not HTML

```python
import re
from parsel import Selector

html = '''<a href="/a">A</a> <a class="btn" href='/b'>B</a> <a
  href=/c>C</a> <!-- <a href="/old">old</a> --> <script>var t = '<a href="/fake">';</script>'''

print(re.findall(r'<a href="([^"]+)"', html))       # ['/a', '/old', '/fake']
print(Selector(text=html).css("a::attr(href)").getall())  # ['/a', '/b', '/c']
```

The regex misses two real links (single quotes, unquoted value, extra attribute, newline) and returns two fake ones (a comment and a string inside a script). The parser gets all of it right because it implements the HTML tokenizer.

## Python essentials

- Use raw strings (`r"\d+"`) and compile once at module level.
- `re.search` finds anywhere, `re.match` anchors only at the start, `re.fullmatch` anchors both ends (use it for validation).
- `re.findall` returns the group's strings when the pattern has one group and tuples when it has several; `re.finditer` yields match objects with `m["name"]`.
- Named groups `(?P<amount>...)` and `re.VERBOSE` keep long patterns readable.
- Flags: `re.IGNORECASE`, `re.DOTALL` (`.` matches newline), `re.MULTILINE` (`^` and `$` per line), `re.ASCII` (ASCII-only `\d`, `\w`, `\s`).
- `re.escape(text)` before embedding configured literal text in a pattern.
- Python 3.11 added atomic groups `(?>...)` and possessive quantifiers (`*+`, `++`, `?+`), which stop backtracking.
- The third-party `regex` module adds Unicode property classes (`\p{L}`), fuzzy matching and a `timeout` argument.

## Recipes

| Goal | Pattern | Note |
|---|---|---|
| Collapse whitespace | `\s+` replaced by one space | Python `\s` includes NBSP and other Unicode spaces |
| Remove zero-width characters | `[\u200b\u2060\ufeff]` | Keep U+200C and U+200D: some scripts and emoji need them |
| ASCII digits only | `[0-9]+` or `re.ASCII` | `\d` also matches `٣` and `３` in Python |
| Number with grouping | `\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?` | The locale decides which mark is decimal |
| Value of a JS string variable | `productId\s*=\s*"([^"]+)"` | Locate only, then validate; allow `'` too if the site uses it |
| Numeric field in inline JSON | `"itemId"\s*:\s*(\d+)` | Prefer parsing the whole object |
| Id between path delimiters | `/dp/([A-Z0-9]{10})(?:[/?]\|$)` | Anchor on delimiters, not on position |
| ISO date shape | `\b(\d{4})-(\d{2})-(\d{2})\b` | Then construct a `date` to validate |

A small cleanup module built from those patterns:

```python
import re

WS = re.compile(r"\s+")
ZERO_WIDTH = re.compile(r"[\u200b\u2060\ufeff]")
UNIT = re.compile(r"(?P<value>[0-9]+(?:[.,][0-9]+)?)\s*(?P<unit>kg|g|lb|oz|ml|l)\b", re.IGNORECASE)

def clean(s: str) -> str:
    return WS.sub(" ", ZERO_WIDTH.sub("", s)).strip()

def parse_quantity(s: str):
    m = UNIT.search(clean(s))
    if not m:
        return None
    return float(m["value"].replace(",", ".")), m["unit"].lower()

print(clean("  Acme\u200b Kettle\u00a0 1.7 L \n"))   # Acme Kettle 1.7 L
print(parse_quantity("Weight: 2,5 kg"))             # (2.5, 'kg')
print(parse_quantity("500ml"))                      # (500.0, 'ml')
```

TypeScript, where named groups and `matchAll` are the idiomatic tools:

```ts
const script = 'window.cfg = {"itemId": 98765, "sku": "SKU-12345"};';
const m = script.match(/"itemId"\s*:\s*(\d+)/);
const itemId = m ? Number(m[1]) : null;                  // 98765

for (const { groups } of 'a=1; b=22'.matchAll(/(?<key>\w+)=(?<val>\d+)/g)) {
  console.log(groups?.key, groups?.val);
}
const word = /\p{L}+/u.exec('Ünïcödé 123')?.[0];        // Unicode letters need the u flag and \p{L}
```

## Engine differences that bite

| Behavior | Python `re` (str patterns) | JavaScript |
|---|---|---|
| `\d` | Any Unicode decimal digit | `[0-9]` only, even with `u` |
| `\w` | Unicode letters and digits | `[A-Za-z0-9_]` only |
| `\s` | Unicode whitespace, including NBSP | Unicode whitespace, including NBSP and U+FEFF |
| Named group syntax | `(?P<name>...)` only (`(?<name>...)` is a syntax error) | `(?<name>...)` |
| Atomic and possessive | 3.11+ | Not supported |
| Dot matches newline | `re.DOTALL` | `s` flag |

Python's `int("٣٤٥")` returns 345, so Unicode digits pass straight into numbers. That is usually what you want for display text, and a surprise when validating identifiers.

## Catastrophic backtracking

Nested or overlapping quantifiers make a backtracking engine try exponentially many ways to fail. Timing `re.match(r"(a+)+$", "a" * n + "!")` on CPython 3.13 gave 0.012 s for n = 18, 0.046 s for n = 20 and 0.18 s for n = 22: four times slower for every two characters. A 40-character input would take hours. Real-world triggers look innocent: `(\w+\s?)*$`, `(\s*\w+)*:` and `(.*,)*;` each took 0.2 to 0.4 s on just 22 characters of non-matching input, and scrapers often run such patterns over a whole page.

Mitigations:

- Avoid nested quantifiers and alternatives that can match the same text (`(a|aa)+`).
- Bound the input: run patterns on the one script or attribute you located, not on the full document.
- Use possessive quantifiers or atomic groups (Python 3.11+) where backtracking is never needed.
- For patterns or inputs you do not control, use a linear-time engine (RE2 via the `google-re2` package) or the `regex` module's `timeout`.

## Pitfalls

- **Greedy matches.** `<b>(.*)</b>` on `<b>1</b> and <b>2</b>` captures `1</b> and <b>2`; use `.*?` or, better, a parser.
- **Validation with `match`.** `re.match(r"[A-Z]{3}-\d{4}", "SKU-1234x")` succeeds; `fullmatch` correctly fails.
- **Entity-encoded targets.** In raw HTML, JSON inside attributes appears as `&quot;`; extract the attribute with a parser so entities are decoded first.
- **Locale-blind number patterns.** A regex can find `1.234`, but only the source locale says whether it is 1234 or 1.234.
- **Harvesting personal data.** Patterns for emails and phone numbers make collection easy and lawful use hard; minimize and justify it ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- **Silent drift.** A pattern that stops matching returns `None` or an empty list, not an error. Count misses and alert on them.

## Checklist

- [ ] Structure is parsed with a parser; regex only touches extracted strings.
- [ ] Patterns are compiled once, anchored (`fullmatch`, delimiters) and tested on fixtures.
- [ ] Digit and word classes match the intended alphabet (`[0-9]`, `re.ASCII`).
- [ ] No nested quantifiers on unbounded input; long inputs are bounded or use RE2.
- [ ] Misses are counted and surfaced in monitoring.

## See Also

- [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)
- [JSON and Embedded Data](json-and-embedded-data.md)
- [Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)
- [CSS Selectors for Extraction](css-selectors.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
