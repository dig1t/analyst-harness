---
tags: [scraping, parsing, html, dom, parsers]
aliases: [DOM, HTML parsing, HTML parser, malformed HTML, html5lib, parse5]
---

# HTML and the DOM

> Sources: WHATWG HTML Living Standard, Parsing HTML documents (https://html.spec.whatwg.org/multipage/parsing.html); WHATWG DOM Standard (https://dom.spec.whatwg.org/); MDN Web Docs, Document Object Model (https://developer.mozilla.org/en-US/docs/Web/API/Document_Object_Model); Beautiful Soup documentation, Differences between parsers (https://www.crummy.com/software/BeautifulSoup/bs4/doc/); lxml, Parsing XML and HTML (https://lxml.de/parsing.html); html5lib documentation (https://html5lib.readthedocs.io/); parse5 (https://github.com/inikulin/parse5); selectolax Lexbor backend (https://selectolax.readthedocs.io/en/latest/lexbor.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

HTML arrives as bytes; a parser decodes it and builds a tree of nodes (the DOM) that selectors, XPath and text extraction run against. The WHATWG HTML standard defines exactly how any byte stream, including broken markup, becomes a tree: implied `<html>`, `<head>`, `<body>` and `<tbody>` elements, auto-closed paragraphs and list items, "foster parenting" of stray content out of tables, and the "adoption agency" repair of misnested tags. Browsers follow that algorithm, and so do html5lib, parse5 (cheerio, jsdom) and Lexbor (selectolax). lxml (libxml2) and Python's `html.parser` use their own recovery rules, so the same page can produce a different tree, and a selector copied from DevTools can silently fail. Pick a parser deliberately, parse the bytes your scraper actually fetched (not what DevTools shows after JavaScript ran), and remove script, style and template content before extracting text.

## From bytes to tree

1. **Decoding.** Bytes become characters using, in priority order, a byte order mark, the HTTP `Content-Type` charset, a `<meta charset>` found by a prescan of the first 1024 bytes, and finally a guess. Pass raw bytes to parsers that implement detection (BeautifulSoup records the result in `soup.original_encoding`); pass text only when you decoded it correctly yourself. See [Compression, Encodings and Character Sets](../http/compression-and-encodings.md).
2. **Tokenization.** The tokenizer emits start tags, end tags, attributes, text and comments, and decodes character references (`&amp;`, `&#8364;`). Some legacy named references work without a semicolon, which is why `&copy 2024` renders as a copyright sign.
3. **Tree construction.** Tokens are inserted according to the current "insertion mode". This stage adds implied elements, closes elements that cannot nest (a new `<p>` closes the open one), moves non-table content out of tables, and keeps only the first of duplicate attributes.
4. **The DOM.** The result is a tree of Document, Element, Text and Comment nodes. Whitespace between tags becomes Text nodes, which is why `.contents` and XPath `text()` return strings you did not expect.

## Same HTML, different trees

The table records what each parser produced for classic malformed inputs (BeautifulSoup 4.15 with each tree builder, selectolax 1.0 with Lexbor, cheerio 1.2).

| Input | WHATWG parsers (html5lib, parse5/cheerio, Lexbor) | lxml | html.parser |
|---|---|---|---|
| `<table><tr><td>1</td></tr></table>` | Inserts `<tbody>` | No `<tbody>` | No `<tbody>` |
| `<table><tr><td>1</td></tr><div>oops</div></table>` | Moves the `<div>` before the table | Leaves it inside the table | Leaves it inside the table |
| `<p><b>bold <i>both</b> italic</i></p>` | `<b>bold <i>both</i></b><i> italic</i>` | `<b>bold <i>both</i></b> italic` | Same as lxml |
| `<p>One<p>Two<div>Three</div>` | Three siblings | Three siblings | Nests each `<p>` inside the previous one |
| `<a href="/1" href="/2">` | Keeps the first value | Keeps the first value | Keeps the last value |
| `<ul><li>a<li>b</ul>` | Two sibling `<li>` | Two sibling `<li>` | Nests the second `<li>` in the first |

The `<tbody>` row is the one that bites most often: browsers always show a `<tbody>`, so an XPath copied from DevTools (`/html/body/table/tbody/tr`) matches nothing when the source omits `<tbody>` and lxml parsed the page.

## Choosing a parser

| Parser | Ecosystem | Browser-identical tree | Relative speed | Notes |
|---|---|---|---|---|
| html5lib | Python (BeautifulSoup tree builder) | Yes | Slow (pure Python) | Best fidelity in Python; use for odd pages |
| lxml / libxml2 | Python (`lxml.html`, BeautifulSoup, parsel) | No | Fast | XPath 1.0 and CSS via cssselect; the default in parsel and Scrapy |
| `html.parser` | Python standard library | No | Moderate | No dependency; weakest repair of broken markup |
| Lexbor | Python (`selectolax.lexbor`) | Yes | Very fast | CSS only; the Modest backend is deprecated since selectolax 1.0 |
| parse5 | Node (cheerio for HTML, jsdom) | Yes | Fast | `cheerio.load(html)` uses it by default |
| htmlparser2 | Node (cheerio with `{ xml: true }`) | No (forgiving, streaming) | Very fast | Use for XML and feeds |
| jsdom | Node | Yes | Slow | Full DOM API, scripts off by default |
| Real browser | Playwright, Puppeteer | Yes, after JavaScript | Slowest | Needed only when content is rendered client-side |

A practical default: lxml or selectolax for speed on well-formed pages, html5lib (Python) or cheerio (Node) when you need the same tree a browser builds, and a browser only when the data is not in the server HTML at all (see [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)).

## Working with the tree

Python, giving BeautifulSoup bytes so it can detect the encoding, and resolving links against `<base href>`:

```python
from urllib.parse import urljoin
from bs4 import BeautifulSoup

raw = (b"<html><head><meta charset='utf-8'><base href='https://example.com/shop/'></head>"
       b"<body><table><tr><td><a href='item/1'>One</a></td></tr></table></body></html>")
page_url = "https://example.com/search?q=1"

soup = BeautifulSoup(raw, "html5lib")            # same tree a browser builds
print(soup.original_encoding)                    # utf-8
base = soup.find("base", href=True)
base_url = urljoin(page_url, base["href"]) if base else page_url

for tag in soup(["script", "style", "noscript", "template"]):
    tag.decompose()                              # never extract text from these

for a in soup.select("table > tbody > tr a[href]"):   # tbody exists: html5lib inserted it
    print(a.get_text(" ", strip=True), urljoin(base_url, a["href"]))
```

The same page with selectolax (Lexbor), which is much faster on large crawls:

```python
from selectolax.lexbor import LexborHTMLParser

html = "<table><tr><td><a href='item/1'>One</a></td></tr></table>"
tree = LexborHTMLParser(html)
for a in tree.css("table > tbody > tr a[href]"):
    print(a.text(strip=True), a.attributes.get("href"))
```

TypeScript with cheerio:

```ts
import * as cheerio from 'cheerio';

const html = '<table><tr><td><a href="item/1">One</a></td></tr></table><noscript><img src="real.jpg"></noscript>';
const $ = cheerio.load(html);                    // parse5, browser-identical tree
console.log($('table > tbody > tr a').attr('href'));          // item/1
console.log($('noscript img').length);                        // 0: noscript content is raw text here
const $noJs = cheerio.load(html, { scriptingEnabled: false });
console.log($noJs('noscript img').length);                    // 1
const $xml = cheerio.load('<rss><item><title>x</title></item></rss>', { xml: true }); // htmlparser2
console.log($xml('item > title').text());
```

## Server HTML vs the live DOM

DevTools' Elements panel shows the live DOM: the parsed tree after scripts ran, after lazy images loaded and after the browser normalized everything. Your HTTP scraper sees only the server response. Before writing selectors, look at "View page source" or save the response your client received, and test selectors against that file. If the data appears only in the live DOM, look for embedded JSON or an API first ([JSON and Embedded Data](json-and-embedded-data.md)) and use a browser last.

Two spec details matter here. With the scripting flag on (parse5's and cheerio's default), `<noscript>` content is parsed as raw text, so fallback `<img>` tags inside it are invisible to selectors unless you pass `scriptingEnabled: false`. And spec-compliant parsers put `<template>` content in a separate document fragment, so `template p` matches nothing in cheerio or Lexbor, while BeautifulSoup's tree builders expose it as ordinary children.

## Pitfalls

- **Text extraction includes code.** lxml's `text_content()` and selectolax's `text()` return the contents of `<script>` and `<style>`. BeautifulSoup skips them with `html.parser` and `lxml` but not with `html5lib`. Remove those elements first.
- **No separator, glued words.** `get_text()` and `text()` concatenate text nodes, so `Line one<br>Line two` becomes `Line oneLine two`. Pass a separator (`get_text(" ", strip=True)`).
- **Decoding twice or not at all.** Passing already-decoded text with a wrong guess produces mojibake that no parser can fix. Prefer bytes plus the HTTP charset.
- **Parser drift.** Switching parsers (or upgrading libxml2) changes trees on broken pages. Pin versions and keep fixture tests ([Testing Scrapers](../data-quality/testing-scrapers.md)).
- **Huge or deeply nested documents.** libxml2 enforces limits on depth and text size by default; lxml exposes `huge_tree=True` to lift them. Use it only for trusted input.
- **Assuming the DOM is the data.** Hidden elements, A/B variants and templated placeholders are all in the tree. Validate extracted values, not just selector matches.

## Checklist

- [ ] Saved the exact bytes the scraper fetched as a fixture, with the response headers.
- [ ] Chose a parser on purpose and pinned its version.
- [ ] Confirmed selectors against the server HTML, not the DevTools DOM.
- [ ] Removed `script`, `style`, `noscript` and `template` before text extraction.
- [ ] Resolved relative URLs against `<base href>` or the final response URL.
- [ ] Used a text separator and normalized whitespace afterwards.

## See Also

- [CSS Selectors for Extraction](css-selectors.md)
- [XPath for Extraction](xpath.md)
- [Writing Robust Selectors](robust-selectors.md)
- [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)
- [Compression, Encodings and Character Sets](../http/compression-and-encodings.md)
- [Python Scraping Stack](../tools/python-scraping-stack.md)
