---
tags: [scraping, http, compression, charset, unicode]
aliases: [Content-Encoding, gzip brotli zstd, Character encoding, Charset detection, Mojibake]
---

# Compression, Encodings and Character Sets

> Sources: RFC 9110, section 8.4 (Content-Encoding) and 12.5.3 (Accept-Encoding) (https://www.rfc-editor.org/rfc/rfc9110); RFC 1950, 1951 and 1952 (zlib, DEFLATE, gzip) (https://www.rfc-editor.org/rfc/rfc1952); RFC 7932, Brotli (https://www.rfc-editor.org/rfc/rfc7932); RFC 8878, Zstandard (https://www.rfc-editor.org/rfc/rfc8878); RFC 9659, Window Sizing for Zstandard Content Encoding (https://www.rfc-editor.org/rfc/rfc9659); RFC 9842, Compression Dictionary Transport (https://www.rfc-editor.org/rfc/rfc9842); WHATWG Encoding Standard (https://encoding.spec.whatwg.org/); WHATWG HTML, determining the character encoding (https://html.spec.whatwg.org/multipage/parsing.html#determining-the-character-encoding); MDN, Accept-Encoding (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Accept-Encoding); ftfy documentation (https://ftfy.readthedocs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Two unrelated layers turn a response into text, and scrapers break on both. Content coding (gzip, deflate, br, zstd) compresses bytes on the wire: the client advertises what it can decode in `Accept-Encoding`, the server labels what it used in `Content-Encoding`, and the HTTP library should undo it. Character encoding (UTF-8, windows-1252, Shift_JIS and others) maps the decompressed bytes to characters: it comes from a byte order mark, the `charset` in `Content-Type` or a `<meta charset>` in the page, and getting it wrong produces mojibake such as `cafÃ©`. The rules: install the decoders your client advertises, cap decompressed size, keep the raw bytes, choose the charset in the order the HTML standard uses, treat `ISO-8859-1` labels as windows-1252, and only then clean and normalize text.

## Content codings

| Coding | Spec | Notes for scrapers |
|---|---|---|
| `gzip` | RFC 1952 | Universal. `x-gzip` means the same (RFC 9110). |
| `deflate` | RFC 1950 wrapping RFC 1951 | Ambiguous in practice: some servers send raw DEFLATE without the zlib wrapper. Good decoders accept both. |
| `br` | RFC 7932 | Common on CDNs. Python needs `brotli` or `brotlicffi`. |
| `zstd` | RFC 8878, window limits in RFC 9659 | Supported by Chrome 123+, Firefox 126+ and recent Safari. Python needs `zstandard` (or `compression.zstd` in Python 3.14). |
| `dcb`, `dcz` | RFC 9842 | Brotli and Zstandard with a shared dictionary. Only sent to clients that announce an available dictionary; ignore unless you implement it. |
| `identity` | RFC 9110 | No coding. |

`Transfer-Encoding: chunked` is HTTP/1.1 message framing, not compression, and HTTP/2 has no chunked coding at all. Servers that vary compression should send `Vary: Accept-Encoding`.

What clients do by default:

| Client | Advertises and decodes |
|---|---|
| requests (urllib3 2.x) | gzip, deflate; plus br and zstd when `brotli` / `zstandard` are installed |
| httpx | gzip, deflate; plus br and zstd with `httpx[brotli,zstd]` |
| Node fetch (undici) | gzip, deflate, br; zstd advertised from undici 8 (Node 26) |
| curl | Nothing unless `--compressed` |

Never hard-code an `Accept-Encoding` that lists a coding your process cannot decode; the result is binary garbage in `.text`.

## Raw bytes, decoded bytes and decompression bombs

Store responses in one consistent form. Either keep wire bytes together with their `Content-Encoding` header, or keep decoded bytes and drop that header. curl's documentation warns that saved headers are not modified after `--compressed` decoding, so they keep claiming compression. Archive formats such as WARC record this explicitly ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

A small compressed body can expand enormously. Stream and cap the decoded size:

```python
import httpx

MAX_DECODED = 20 * 1024 * 1024  # 20 MiB after decompression


def fetch_capped(client: httpx.Client, url: str, limit: int = MAX_DECODED) -> tuple[httpx.Response, bytes]:
    """Stream the body and stop early if it decompresses to more than `limit` bytes."""
    with client.stream("GET", url) as r:
        body = bytearray()
        for chunk in r.iter_bytes():  # decompressed bytes; iter_raw() yields wire bytes
            body += chunk
            if len(body) > limit:
                raise ValueError(f"{url}: more than {limit} bytes after decompression")
    return r, bytes(body)  # status and headers stay readable after the stream closes
```

## Choosing the character encoding

The HTML standard's encoding sniffing algorithm decides in this order:

1. **Byte order mark** (UTF-8, UTF-16LE, UTF-16BE). It wins over everything.
2. **The transport layer**: `charset` in `Content-Type`.
3. **A prescan of the first 1024 bytes** for `<meta charset="...">` or `<meta http-equiv="Content-Type" content="text/html; charset=...">`.
4. **Heuristics**: the parent frame, history, frequency-based detection.
5. **A locale default**, typically windows-1252 for Western locales.

The WHATWG Encoding Standard then maps labels to decoders, and the mapping is not what most standard libraries assume: `iso-8859-1`, `latin1`, `ascii` and `us-ascii` all mean windows-1252, and `gb2312` means GBK. The difference matters for bytes 0x80 to 0x9F, which windows-1252 uses for `€`, curly quotes and dashes, and ISO-8859-1 maps to invisible C1 control characters.

Library behavior that bites:

- **requests** uses the header charset; for `text/*` without one it falls back to ISO-8859-1 (an old RFC 2616 rule), so a UTF-8 page served without a charset decodes as mojibake. `r.apparent_encoding` runs a detector.
- **httpx** uses the header charset, otherwise `default_encoding` (UTF-8 unless you pass a name or a detector callable). It does not read `<meta charset>`.
- **Node `res.text()`** always decodes as UTF-8, whatever the headers say.
- **HTML parsers given bytes** (BeautifulSoup, lxml) read `<meta charset>` but cannot see your HTTP header, which per the standard has priority.

A decoder that follows the standard's order:

```python
import codecs
import re

import charset_normalizer

HEADER_CHARSET = re.compile(r"""charset\s*=\s*["']?([^;"'\s]+)""", re.I)
META_CHARSET = re.compile(rb"""<meta[^>]+charset\s*=\s*["']?\s*([A-Za-z0-9_.:-]+)""", re.I)
BOMS = ((codecs.BOM_UTF8, "utf-8-sig"), (codecs.BOM_UTF16_LE, "utf-16"), (codecs.BOM_UTF16_BE, "utf-16"))
# WHATWG Encoding Standard: browsers decode these labels as windows-1252.
WEB_LABELS = {"iso-8859-1": "cp1252", "latin1": "cp1252", "l1": "cp1252", "us-ascii": "cp1252", "ascii": "cp1252"}


def sniff_encoding(raw: bytes, content_type: str | None) -> str:
    """Approximate the HTML spec order: BOM, HTTP charset, <meta> in the first 1024 bytes, detection."""
    for bom, name in BOMS:
        if raw.startswith(bom):
            return name
    labels = []
    if content_type and (m := HEADER_CHARSET.search(content_type)):
        labels.append(m.group(1))
    if m := META_CHARSET.search(raw[:1024]):
        labels.append(m.group(1).decode("ascii", "ignore"))
    for label in labels:
        name = WEB_LABELS.get(label.strip().lower(), label.strip().lower())
        try:
            return codecs.lookup(name).name
        except LookupError:
            continue  # unknown label: fall through to the next signal
    best = charset_normalizer.from_bytes(raw[:200_000]).best()
    return best.encoding if best else "utf-8"


def decode_html(raw: bytes, content_type: str | None) -> str:
    return raw.decode(sniff_encoding(raw, content_type), errors="replace")
```

On a windows-1252 page served as `text/html` without a charset, httpx's default produces `quoted� �5`, while `decode_html` gives `quoted” €5`. Python's `cp1252` codec rejects five bytes (0x81, 0x8D, 0x8F, 0x90, 0x9D) that browsers pass through, which is one reason to decode with `errors="replace"` and log replacements.

In Node, read bytes and decode yourself. Use iconv-lite for legacy charsets: in testing, Node 20.20 and 22.22 decoded `TextDecoder("windows-1252")` bytes 0x80 to 0x9F as C1 controls instead of `€` and curly quotes (Node 21.7 did not), so check your runtime before relying on `TextDecoder` for windows-1252.

```typescript
import iconv from "iconv-lite"; // npm install iconv-lite

const res = await fetch("https://example.com/legacy-page");
const bytes = Buffer.from(await res.arrayBuffer()); // res.text() always decodes as UTF-8

const header = res.headers.get("content-type") ?? "";
const head = bytes.subarray(0, 1024).toString("latin1"); // byte-preserving view for the prescan
let label =
  /charset\s*=\s*["']?([\w.:-]+)/i.exec(header)?.[1] ??
  /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head)?.[1] ??
  "utf-8";
if (/^(iso-8859-1|latin-?1|us-ascii|ascii)$/i.test(label)) label = "windows-1252"; // WHATWG rule

const html = iconv.encodingExists(label) ? iconv.decode(bytes, label) : bytes.toString("utf8");
```

Detection is a last resort. Detectors guess from byte statistics and misfire on short texts (charset_normalizer labeled a short German windows-1252 sample as cp1250 in our test, which happened to decode the same characters). UTF-8 has a very distinctive byte pattern, so "does it decode strictly as UTF-8?" is a strong first check before any statistical guess.

## Recognizing and repairing mojibake

| You see | What happened | Fix |
|---|---|---|
| `cafÃ©`, `â‚¬`, `â€™` | UTF-8 bytes decoded as windows-1252 or ISO-8859-1 | Re-decode the raw bytes as UTF-8; if only text survives, `ftfy.fix_text` |
| `\x80`, `\x93` control characters | windows-1252 bytes decoded as ISO-8859-1 | Decode as windows-1252 |
| `�` (U+FFFD) | Bytes invalid in the chosen encoding, replaced | Information is lost: decode the raw bytes again with the right charset |
| `?` in place of letters | Text encoded to a narrow charset with replacement on save | Lost: always write UTF-8 |
| `Ã\x83Â©` | Mojibake applied twice | `ftfy` usually reverses it |

```python
import ftfy  # pip install ftfy

print(ftfy.fix_text("cafÃ© costs â‚¬5"))                      # café costs €5
print(ftfy.fix_text("itâ€™s", uncurl_quotes=False))         # it’s (default would straighten the quote)
```

After decoding, normalize Unicode (NFC or NFKC), whitespace (`\xa0`) and entities as described in [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md), and write files with an explicit `encoding="utf-8"`: the default for `open()` depends on the platform.

## Pitfalls

- **Advertising codings you cannot decode**, usually a copied `Accept-Encoding: gzip, deflate, br, zstd` without the packages.
- **Unbounded decompression** of untrusted responses.
- **Mixing raw and decoded bytes** with headers that describe the other form.
- **Trusting requests' ISO-8859-1 fallback** for HTML without a charset.
- **Using `res.text()` in Node** for pages that are not UTF-8.
- **Letting a detector override a declared charset** that was correct.
- **Decoding ISO-8859-1 literally** and storing C1 controls instead of `€` and quotes.
- **Fixing mojibake in text when the raw bytes are still available.** Re-decode from bytes instead.

## Checklist

- [ ] brotli and zstandard decoders installed wherever they are advertised
- [ ] Decompressed size capped for every response
- [ ] Raw bytes archived with matching headers
- [ ] Charset chosen by BOM, header, meta prescan, then detection
- [ ] `iso-8859-1`, `latin1` and `ascii` labels decoded as windows-1252
- [ ] Replacement characters counted and alerted on
- [ ] All output written as UTF-8 explicitly

## See Also

- [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)
- [HTML and the DOM](../parsing/html-and-the-dom.md)
- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
- [Request Headers That Matter](http-headers-for-scrapers.md)
- [Cost Control](../operations/cost-control.md)
