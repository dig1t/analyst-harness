---
tags: [scraping, parsing, css, selectors]
aliases: [CSS selector, selectors, querySelectorAll, Soup Sieve, cssselect]
---

# CSS Selectors for Extraction

> Sources: W3C, Selectors Level 4 (https://www.w3.org/TR/selectors-4/); MDN Web Docs, CSS selectors (https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_selectors); Soup Sieve documentation (https://facelessuser.github.io/soupsieve/); cssselect documentation (https://cssselect.readthedocs.io/); parsel documentation (https://parsel.readthedocs.io/en/latest/); selectolax Lexbor documentation (https://selectolax.readthedocs.io/en/latest/lexbor.html); cheerio documentation (https://cheerio.js.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

CSS selectors are the most common way to point at data in an HTML tree: short, readable, testable in the browser console with `document.querySelectorAll()`, and supported by every scraping library. Libraries implement different subsets of Selectors Level 4, and each adds its own non-standard way to match text, so a selector that works in DevTools can raise a syntax error in your scraper. Select the repeating container first and query fields relative to it, prefer stable attributes over generated class names, and know your library's support matrix (below). Results always come back in document order. When you need to walk up the tree or match on text precisely, switch to XPath ([XPath for Extraction](xpath.md)).

## Cheat sheet

| Selector | Matches | Example |
|---|---|---|
| `tag` | Elements by name | `table` |
| `.cls` | Elements whose class list contains `cls` | `.price` matches `class="price big"` |
| `#id` | Element with that id | `#main` |
| `[attr]` | Attribute present | `a[href]` |
| `[attr="v"]` | Exact value | `[data-testid="price"]` |
| `[attr~="v"]` | Whitespace-separated word | `[rel~="nofollow"]` |
| `[attr\|="en"]` | `en` or `en-...` | `[lang\|="en"]` |
| `[attr^="v"]`, `[attr$="v"]`, `[attr*="v"]` | Starts with, ends with, contains | `a[href$=".pdf"]` |
| `[attr="v" i]` | Case-insensitive value | `a[href$=".pdf" i]` |
| `A B` | B anywhere inside A | `article p` |
| `A > B` | B is a direct child of A | `ul > li` |
| `A + B` | B immediately follows A | `dt + dd` |
| `A ~ B` | B is a later sibling of A | `h2 ~ p` |
| `A, B` | Either (document order) | `h1, h2` |
| `:first-child`, `:last-child`, `:only-child` | Position among all siblings | `tr:first-child` |
| `:nth-child(an+b)` | Position formula | `tr:nth-child(odd)`, `li:nth-child(3n+1)` |
| `:nth-child(2 of .item)` | Second sibling that matches `.item` | Level 4, limited support |
| `:nth-of-type(n)`, `:first-of-type` | Position among same-tag siblings | `p:nth-of-type(2)` |
| `:not(X)` | Does not match X | `li:not(.sponsored)` |
| `:is(X, Y)`, `:where(X, Y)` | Matches any in the list | `:is(h1, h2, h3)` |
| `:has(X)` | Has a descendant (or relative match) X | `li:has(> .price)` |
| `:empty` | No children, no text | `td:empty` |
| `:checked`, `:disabled` | Form state from attributes | `input:checked` |

## Library support matrix

Measured with Soup Sieve 3.0 (BeautifulSoup 4.15), cssselect 1.3 (lxml 6, parsel 1.12), selectolax 1.0 (Lexbor) and cheerio 1.2 (css-select).

| Feature | Soup Sieve | cssselect (lxml, parsel) | Lexbor (selectolax) | cheerio |
|---|---|---|---|---|
| `:has()`, `:is()`, `:where()` | Yes | Yes | Yes | Yes |
| `:not(.a, .b)` (selector list) | Yes | No | Yes | Yes |
| `:nth-child(2 of .x)` | Yes | No | Yes | No |
| `[attr="v" i]` | Yes | No | Yes | Yes |
| Text match | `:-soup-contains("x")` | `:contains("x")` | `:lexbor-contains("x")` | `:contains("x")` |
| `::text`, `::attr(name)` | No | parsel and Scrapy only | No | No |

Browsers support the standard rows but no text-matching pseudo-class. Soup Sieve still accepts `:contains()` but warns that it is deprecated. Playwright adds its own engines (`:has-text()`, role and text locators), covered in [Playwright](../browser-automation/playwright.md). cssselect works by translating CSS to XPath 1.0, which explains its limits:

```python
from cssselect import HTMLTranslator
print(HTMLTranslator().css_to_xpath("p.price > b"))
# descendant-or-self::p[@class and contains(concat(' ', normalize-space(@class), ' '), ' price ')]/b
```

## The card pattern

Select each repeating record (a product card, a table row, a search result), then query its fields relative to it. Never select all titles and all prices separately and zip them: one missing price shifts every later row.

Python with parsel (Scrapy uses the same API):

```python
from parsel import Selector

html = """<ul id="results">
  <li class="result" data-id="101"><a href="/item/101">First item</a><span class="price">$12.50</span></li>
  <li class="result sponsored" data-id="102"><a href="/item/102">Ad</a></li>
  <li class="result" data-id="103"><a href="/item/103">Third</a></li>
</ul>"""

sel = Selector(text=html)
for card in sel.css("#results > li.result:not(.sponsored)"):
    print({
        "id": card.attrib.get("data-id"),
        "title": card.css("a::text").get(default="").strip(),
        "url": card.css("a::attr(href)").get(),
        "price": card.css(".price::text").get(),     # None when missing, row stays aligned
    })
```

BeautifulSoup and selectolax:

```python
from bs4 import BeautifulSoup
from selectolax.lexbor import LexborHTMLParser

soup = BeautifulSoup(html, "lxml")
for card in soup.select("#results > li.result:not(.sponsored)"):
    price = card.select_one(".price")
    print(card["data-id"], card.select_one("a").get_text(strip=True), price.get_text(strip=True) if price else None)

tree = LexborHTMLParser(html)
for card in tree.css("#results > li.result:not(.sponsored)"):
    price = card.css_first(".price")
    print(card.attributes.get("data-id"), card.css_first("a").text(strip=True), price.text(strip=True) if price else None)
```

TypeScript with cheerio, resolving links against the page URL:

```ts
import * as cheerio from 'cheerio';

const html = `<ul id="results">
  <li class="result" data-id="101"><a href="/item/101">First item</a><span class="price">$12.50</span></li>
  <li class="result sponsored" data-id="102"><a href="/item/102">Ad</a></li>
</ul>`;
const $ = cheerio.load(html);
const base = 'https://shop.example.com/search?q=kettle';
const rows = $('#results > li.result:not(.sponsored)')
  .map((_, li) => {
    const $li = $(li);
    const href = $li.find('a[href]').attr('href');
    return {
      id: $li.attr('data-id') ?? null,
      title: $li.find('a').text().trim(),
      url: href ? new URL(href, base).href : null,
      price: $li.find('.price').first().text().trim() || null,
    };
  })
  .get();
```

## Useful patterns

| Goal | Selector |
|---|---|
| Value next to a label | `dt:-soup-contains("SKU") + dd` (Soup Sieve), or XPath when unsupported |
| Rows that have a price | `tr:has(td.price)` |
| Links to documents | `a[href$=".pdf" i]` |
| Skip ads and placeholders | `.card:not(.ad):not([aria-hidden="true"])` |
| Microdata properties | `[itemprop="price"]` and its `content` attribute |
| Test hooks | `[data-testid="product-title"]`, `[data-qa="price"]` |
| Main content | `main article`, `[role="main"]` |

Test a selector in the browser console with `document.querySelectorAll('...').length`, then against the saved server HTML in your library, because the two trees can differ ([HTML and the DOM](html-and-the-dom.md)).

## Pitfalls

- **`:nth-child` counts all siblings.** `li.item:nth-child(2)` means "the second child, if it is `li.item`", not "the second `li.item`". Use `:nth-child(2 of .item)` where supported, or index the result list in code.
- **Exact class attribute.** `[class="price"]` fails on `class="price big"`; use `.price`. Conversely `.price` does not match `price-old`, but a substring test `[class*="price"]` does.
- **Generated class names.** Hashes from CSS Modules, styled-components or utility frameworks (`.css-1q2w3e`, `.sc-AxjAm`) change on every deploy. Anchor on ids, `data-*`, `itemprop`, ARIA roles or labels ([Writing Robust Selectors](robust-selectors.md)).
- **Identifiers that need escaping.** `#123` and `#item:1` are syntax errors. Use `[id="123"]`, escape (`#item\:1`) or call `soupsieve.escape()`.
- **Pseudo-elements outside parsel.** `::text` and `::attr()` are parsel extensions; BeautifulSoup, selectolax and cheerio reject them.
- **Global search inside a scope.** In parsel and lxml a nested `.css()` is relative to the element, but a nested XPath starting with `//` searches the whole document; start it with `.//`.
- **Missing `<tbody>`.** `table > tbody > tr` fails with lxml-based parsers on pages that omit it; `table tr` works everywhere.
- **Hidden duplicates.** Responsive sites render the same price twice (mobile and desktop). Scope to one visible container or deduplicate.

## Checklist

- [ ] Selected the record container first, then fields relative to it.
- [ ] Verified the selector against saved server HTML with the production library.
- [ ] Avoided generated classes, long descendant chains and positional selectors.
- [ ] Used only features your library supports (matrix above).
- [ ] Returned `None` for missing fields instead of shifting lists.
- [ ] Added a fixture test that fails when the selector stops matching.

## See Also

- [XPath for Extraction](xpath.md)
- [Writing Robust Selectors](robust-selectors.md)
- [HTML and the DOM](html-and-the-dom.md)
- [Shadow DOM, iframes and Web Components](../browser-automation/shadow-dom-and-iframes.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [Python Scraping Stack](../tools/python-scraping-stack.md)
