---
tags: [scraping, parsing, unicode, text-cleaning, normalization]
aliases: [Unicode normalization, NFC, NFKC, mojibake, whitespace cleanup, HTML entities, ftfy]
---

# Text Cleaning and Unicode Normalization

> Sources: Unicode Standard Annex #15, Unicode Normalization Forms (https://unicode.org/reports/tr15/); W3C, Character Model for the World Wide Web: String Matching (https://www.w3.org/TR/charmod-norm/); Python documentation, unicodedata (https://docs.python.org/3/library/unicodedata.html); Python documentation, html module (https://docs.python.org/3/library/html.html); WHATWG HTML Living Standard, Named character references (https://html.spec.whatwg.org/multipage/named-characters.html); ftfy documentation (https://ftfy.readthedocs.io/en/latest/); MDN Web Docs, String.prototype.normalize() (https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/String/normalize)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Scraped text arrives with non-breaking and thin spaces, invisible zero-width characters, soft hyphens, the same letter encoded two ways (precomposed or with a combining accent), compatibility variants (ligatures, fullwidth digits), leftover entities, mojibake from a wrong charset, and template boilerplate. Clean it in a fixed, idempotent order and keep the raw value next to the cleaned one. Use **NFC** for storage and display; use **NFKC plus casefold** only to build matching keys, because compatibility normalization changes meaning (`m²` becomes `m2`, `10³` becomes `103`). Repair mojibake with ftfy before anything else, let the HTML parser decode entities exactly once, and never strip characters that carry meaning, such as the zero-width joiner inside emoji sequences.

## A cleaning order that works

1. **Decode bytes correctly** using the HTTP charset, BOM or `<meta charset>` ([Compression, Encodings and Character Sets](../http/compression-and-encodings.md)).
2. **Parse the HTML** and let the parser decode entities; drop `script`, `style` and hidden elements ([HTML and the DOM](html-and-the-dom.md)).
3. **Repair mojibake** when detected (ftfy).
4. **Normalize to NFC.**
5. **Fix invisible characters and whitespace**: remove zero-width spaces, BOMs and soft hyphens; turn exotic spaces into ASCII spaces; unify line breaks.
6. **Collapse and strip** whitespace runs.
7. **Field-specific rules** only where needed (quotes, dashes, case, units).
8. **Derive match keys** separately (NFKC, casefold, punctuation removal).

## Normalization forms

| Form | Effect | Example | Use it for |
|---|---|---|---|
| NFC | Canonical composition | `e` + U+0301 becomes one `é` | Storage, display, equality |
| NFD | Canonical decomposition | `é` becomes `e` + U+0301 | A step in accent folding |
| NFKC | Compatibility decomposition, then composition | `ﬁ` to `fi`, `２０２４` to `2024`, NBSP to space, `…` to `...`, `℃` to `°C`, `m²` to `m2`, `½` to `1⁄2` | Search and deduplication keys |
| NFKD | Compatibility decomposition | As NFKC, accents left decomposed | ASCII folding pipelines |

Two strings that look identical can differ in bytes until both are NFC-normalized, which silently breaks joins and deduplication. JavaScript has the same tool: `s.normalize('NFC')`.

## Whitespace and invisible characters

| Code point | Name | `str.isspace()` | Where it shows up |
|---|---|---|---|
| U+00A0 | No-break space | True | `&nbsp;`, prices like `1 000`, between value and unit |
| U+2009 | Thin space | True | Number grouping, typography |
| U+202F | Narrow no-break space | True | French grouping, CLDR number formats |
| U+3000 | Ideographic space | True | CJK text |
| U+200B | Zero-width space | False | Line-break hints, copy-paste debris |
| U+FEFF | Zero-width no-break space (BOM) | False | File starts, concatenated fragments |
| U+00AD | Soft hyphen | False | Hyphenation hints, PDF text |
| U+200C, U+200D | Zero-width non-joiner and joiner | False | Persian and Indic scripts, emoji sequences: keep them |
| U+2028, U+2029 | Line and paragraph separator | True | Treat as newlines |

`" ".join(s.split())` collapses every `isspace()` character, NBSP included, but leaves zero-width spaces in place, and `str.strip()` does not remove U+200B or U+FEFF either.

## Entities

The HTML parser decodes `&amp;`, `&eacute;`, `&#8364;` and friends, including the legacy forms without a semicolon (`&copy 2024` becomes `© 2024`), and it applies HTML's attribute rules, so a URL like `/s?a=1&copy=2` in an `href` stays intact. Do not call `html.unescape()` again on parsed text: a page that literally shows `&amp;` would turn into `&`, and escaped markup into real markup. Reserve `html.unescape()` for strings that are still escaped, such as HTML fragments inside JSON fields or feed summaries.

## Mojibake

Mojibake is UTF-8 decoded as Windows-1252 or Latin-1: `café` becomes `cafÃ©`, `€` becomes `â‚¬`, `über` becomes `Ã¼ber`. Fix the charset at the source when you can. Otherwise ftfy repairs it:

```python
import ftfy

print(ftfy.fix_encoding("cafÃ© â‚¬ Ã¼ber"))         # café € über (encoding repair only)
print(ftfy.fix_text("“quotes”"))                    # "quotes": fix_text straightens curly quotes by default
print(ftfy.fix_text("“quotes”", uncurl_quotes=False))
```

`fix_text` does more than encoding repair: by default it also unescapes entities in text that does not look like HTML, replaces Latin ligatures, converts fullwidth characters, uncurls quotes, fixes line breaks, removes control characters and applies NFC. Turn off what you need to preserve, or call `fix_encoding` alone. The manual repair `s.encode("cp1252").decode("utf-8")` works only for clean cases and raises on bytes that Windows-1252 does not define.

## Implementation

```python
import re
import unicodedata
from collections import Counter
import ftfy

INVISIBLE = dict.fromkeys(map(ord, "\u200b\u2060\ufeff\u00ad"), None)  # ZWSP, word joiner, BOM, soft hyphen
SPACES = re.compile(r"[^\S\n]+")                                       # any whitespace except newline
BLANK_LINES = re.compile(r"\n{3,}")

def clean_text(s: str, *, repair: bool = True) -> str:
    """Display-safe cleanup. Idempotent: clean_text(clean_text(s)) == clean_text(s)."""
    if repair:
        s = ftfy.fix_text(s, uncurl_quotes=False, unescape_html=False)  # the parser already decoded entities
    s = unicodedata.normalize("NFC", s)
    s = s.translate(INVISIBLE)
    s = s.replace("\r\n", "\n").replace("\r", "\n").replace("\u2028", "\n").replace("\u2029", "\n\n")
    s = SPACES.sub(" ", s)
    s = "\n".join(line.strip() for line in s.split("\n"))
    return BLANK_LINES.sub("\n\n", s).strip()

def match_key(s: str, *, fold_accents: bool = False) -> str:
    """Aggressive key for joins and deduplication. Never display or store it as the value."""
    s = unicodedata.normalize("NFKC", clean_text(s)).casefold()
    if fold_accents:
        s = "".join(ch for ch in unicodedata.normalize("NFD", s) if not unicodedata.combining(ch))
    return re.sub(r"[\W_]+", " ", s).strip()

raw = "  CafÃ©\u00a0\u00a0Crème\u200b  “Best”\r\n\r\n\r\n\u00a0Price:\u202f1\u202f299,00\u00a0€  "
print(repr(clean_text(raw)))      # 'Café Crème “Best”\n\nPrice: 1 299,00 €'
print(match_key("Ｃａｆé  Déjà-vu"))                       # café déjà vu
print(match_key("Ｃａｆé  Déjà-vu", fold_accents=True))    # cafe deja vu
```

TypeScript equivalents: `s.normalize('NFC')`, `s.replace(/[\u200b\u2060\ufeff\u00ad]/g, '')` and `s.replace(/\s+/g, ' ').trim()` (JavaScript's `\s` already includes NBSP and U+FEFF).

## Boilerplate

Navigation, footers, cookie banners, "related stories" and share widgets pollute text. Remove elements by tag and role first (`nav`, `footer`, `aside`, `[role="navigation"]`, `[aria-hidden="true"]`), use main-content extraction for articles ([Converting HTML to Markdown and Text](html-to-markdown.md)), and drop lines that repeat across many pages of the same site:

```python
def template_lines(pages: list[str], threshold: float = 0.5) -> set[str]:
    """Lines present on at least `threshold` of a site's pages are template text."""
    counts = Counter(line for text in pages for line in set(text.splitlines()) if line.strip())
    return {line for line, n in counts.items() if n / len(pages) >= threshold}

pages = ["Home | News\nStory one\nCookie notice",
         "Home | News\nStory two\nCookie notice",
         "Home | News\nStory three\nCookie notice"]
print(template_lines(pages))      # {'Home | News', 'Cookie notice'}
```

## Pitfalls

- **NFKC changes meaning.** `m²` becomes `m2`, `10³` becomes `103`, `½` becomes `1⁄2`. Never apply it to stored values, numbers with superscripts or units.
- **Accent folding merges words.** With folding, Spanish `año` (year) and `ano` collide. Fold only when your matching tolerates it.
- **Case mapping is language-sensitive.** `"Straße".casefold()` is `"strasse"` while `.lower()` keeps `ß`; `"İ".lower()` returns two code points; Turkish dotless `ı` needs locale-aware handling.
- **Stripping joiners.** Removing U+200D breaks emoji sequences into separate symbols; removing U+200C changes Persian words.
- **Double unescaping.** Running `html.unescape()` or `ftfy.fix_text()` on parsed text can decode entities a second time.
- **Hashes shift when cleaning changes.** Content hashes for change detection must be computed over a versioned cleaning function, or every rule change looks like a content change ([Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).
- **Overcleaning.** Keep the raw string; cleaning rules evolve and you will want to re-run them.

## Checklist

- [ ] Bytes decoded with the right charset; entities decoded exactly once by the parser.
- [ ] Mojibake detection and repair runs before other steps.
- [ ] Stored text is NFC with invisible characters removed and whitespace collapsed.
- [ ] Match keys use NFKC and casefold, computed separately from stored values.
- [ ] Joiners, superscripts and units are preserved where they carry meaning.
- [ ] Raw text is kept and the cleaning function is versioned.

## See Also

- [Compression, Encodings and Character Sets](../http/compression-and-encodings.md)
- [Converting HTML to Markdown and Text](html-to-markdown.md)
- [Regular Expressions: When and When Not](regex-in-scraping.md)
- [Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)
- [Data Cleaning Pipeline](../data-quality/data-cleaning-pipeline.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
