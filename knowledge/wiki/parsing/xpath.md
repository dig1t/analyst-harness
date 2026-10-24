---
tags: [scraping, parsing, xpath, selectors]
aliases: [XPath, XPath 1.0, XPath selectors, lxml xpath]
---

# XPath for Extraction

> Sources: W3C, XML Path Language (XPath) Version 1.0 (https://www.w3.org/TR/1999/REC-xpath-19991116/); W3C, XPath 3.1 (https://www.w3.org/TR/xpath-31/); MDN Web Docs, XPath (https://developer.mozilla.org/en-US/docs/Web/XPath); lxml, XPath and XSLT with lxml (https://lxml.de/xpathxslt.html); parsel documentation (https://parsel.readthedocs.io/en/latest/); Scrapy documentation, Selectors (https://docs.scrapy.org/en/latest/topics/selectors.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

XPath is a path language for trees. It does what CSS selectors cannot: walk up to parents and ancestors, step to the sibling after a label, return attribute values and text nodes directly, match on whitespace-normalized text, and compute strings and counts. lxml, parsel and Scrapy, browsers (`document.evaluate`, `$x()` in the DevTools console), Playwright and Selenium all speak it. Nearly all of them implement only **XPath 1.0**, so the newer `matches()`, `lower-case()` and `ends-with()` raise "Unregistered function" in lxml. The three habits that prevent most bugs: scope nested queries with `.//`, compare text through `normalize-space()`, and remember that `//li[1]` and `(//li)[1]` mean different things. cheerio, selectolax and BeautifulSoup have no XPath; use CSS there ([CSS Selectors for Extraction](css-selectors.md)).

## Syntax in one minute

A path is a sequence of steps, each `axis::node-test[predicate]`. The abbreviations cover most use:

| Syntax | Meaning |
|---|---|
| `/html/body` | Child steps from the root |
| `//a` | Any descendant `a` (`/descendant-or-self::node()/child::a`) |
| `.//a` | Descendants of the current node only |
| `..` | Parent |
| `@href` | Attribute (`attribute::href`) |
| `*` | Any element |
| `text()`, `comment()`, `node()` | Text nodes, comments, any node |
| `[...]` | Predicate filter; a number means position (`[1]`, `[last()]`) |
| `a \| b` | Union, returned in document order |

## Axes

| Axis | Selects | Example |
|---|---|---|
| `child::` (default) | Children | `ul/li` |
| `descendant::`, `descendant-or-self::` | Everything below | `//div[@id='main']//a` |
| `parent::` (`..`) | The parent | `//span[@class='price']/..` |
| `ancestor::`, `ancestor-or-self::` | Everything above | `//td[.='Total']/ancestor::table[1]` |
| `following-sibling::` | Later siblings | `//dt[.='SKU']/following-sibling::dd[1]` |
| `preceding-sibling::` | Earlier siblings | `//li[.='two']/preceding-sibling::li` |
| `following::`, `preceding::` | Everything after or before in document order | `//h2[.='Specs']/following::table[1]` |
| `self::` | The node itself | `//*[self::h1 or self::h2]` |

On reverse axes (`ancestor`, `preceding`, `preceding-sibling`) position 1 is the **nearest** node, so `ancestor::div[1]` is the closest enclosing `div`.

## Cheat sheet

Every expression below was checked against lxml 6 and parsel 1.12.

| Goal | XPath |
|---|---|
| All link URLs | `//a/@href` |
| Element by id | `//*[@id='main']` |
| Exact class token | `//p[contains(concat(' ', normalize-space(@class), ' '), ' price ')]` |
| Class token (parsel and Scrapy extension) | `//p[has-class('price')]` |
| Attribute prefix | `//a[starts-with(@href, '/product/')]` |
| Text equals, whitespace normalized | `//a[normalize-space()='Next page']` |
| Text contains | `//h2[contains(., 'Specifications')]` |
| Value next to a table label | `//th[normalize-space()='Weight']/following-sibling::td[1]` |
| Value next to a definition term | `//dt[normalize-space()='SKU']/following-sibling::dd[1]` |
| Rows that have a price cell | `//tr[td[@class='price']]` |
| Exclude a class | `//p[not(contains(@class, 'old'))]` |
| First match in the whole document | `(//li)[1]` |
| First `li` of every list | `//li[1]` |
| Last match in the document | `(//li)[last()]` |
| A range of positions | `//li[position() > 1 and position() <= 4]` |
| Nearest record container around a marker | `//span[.='Sold out']/ancestor::*[@data-product-id][1]` |
| All text, collapsed to one string | `normalize-space(//h1)` |
| Count matches | `count(//table//tr)` |
| Either of two tags | `//*[self::h1 or self::h2]` |
| Case-insensitive contains | `//a[contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'next')]` |
| Tail text after a child | `//div[@class='c']/b/following-sibling::text()[1]` |
| Part of an attribute | `substring-after(//a[1]/@href, 'id=')` |
| Regex (lxml, EXSLT) | `//a[re:test(@href, 'id=\d+$')]` with `re` bound to `http://exslt.org/regular-expressions` (parsel binds it by default) |
| Comments | `//div[@id='x']/comment()` |

## Python

parsel (the Scrapy selector library) supports XPath variables, which avoid quoting bugs when the label comes from configuration:

```python
from parsel import Selector

html = """<table class="specs"><tr><th>Weight</th><td> 2 kg </td></tr><tr><th>Price</th><td>7</td></tr></table>
<ul><li>a1</li><li>a2</li></ul><ul><li>b1</li></ul>"""
sel = Selector(text=html)

weight = sel.xpath("normalize-space(//th[normalize-space()='Weight']/following-sibling::td[1])").get()
price = sel.xpath("//th[normalize-space()=$label]/following-sibling::td[1]/text()", label="Price").get()
print(weight, price)                          # 2 kg 7

print(sel.xpath("//li[1]/text()").getall())   # ['a1', 'b1']: first li of EACH list
print(sel.xpath("(//li)[1]/text()").getall()) # ['a1']: first li in the document

for ul in sel.xpath("//ul"):
    print(ul.xpath(".//li/text()").getall())  # scoped to this list
    # ul.xpath("//li") would search the whole document again
```

lxml directly, including EXSLT regular expressions:

```python
import lxml.html

doc = lxml.html.fromstring('<div><a href="/a?id=123">A</a><a href="/b?id=x45">B</a></div>')
ns = {"re": "http://exslt.org/regular-expressions"}
print(doc.xpath(r"//a[re:test(@href, 'id=\d+$')]/@href", namespaces=ns))  # ['/a?id=123']
print(doc.xpath("string(//a[2])"))                                         # B
```

In a browser context (DevTools console, or inside Playwright's `page.evaluate`), TypeScript:

```ts
export function rowsByXPath(): string[] {
  const snap = document.evaluate(
    "//table[@id='prices']//tr[td]",
    document,
    null,
    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
    null,
  );
  return Array.from({ length: snap.snapshotLength }, (_, i) => (snap.snapshotItem(i) as HTMLElement).innerText);
}
```

## XPath or CSS?

| Capability | CSS | XPath 1.0 |
|---|---|---|
| Readability for simple paths | Better | Verbose |
| Go up to a parent or ancestor | Only indirectly via `:has()` | `..`, `ancestor::` |
| Sibling after a label | Forward only (`+`, `~`) | Both directions |
| Return text or attribute values | parsel `::text` and `::attr()` only | `text()`, `@href`, `string()` |
| Text matching | Non-standard, differs per library | `contains()`, `starts-with()`, `normalize-space()` |
| Position in the whole result set | No | `(//x)[n]` |
| String and number functions | No | `substring-after()`, `translate()`, `count()` |
| Library support | Everywhere | lxml, parsel, Scrapy, browsers, Playwright, Selenium |

cssselect translates CSS to XPath, so performance is the same in lxml and parsel. Use CSS for straightforward structure and XPath for label-relative values, upward navigation and text conditions. Mixing both in parsel is idiomatic: `sel.css("table.specs").xpath(".//th[.='Weight']/following-sibling::td[1]")`.

For XPath 2.0 and 3.1 features in Python, the `elementpath` package evaluates them over ElementTree and lxml trees; Saxon offers them for Java, .NET and Python. Most scrapers never need them.

## Pitfalls

- **NBSP is not whitespace in XPath.** `normalize-space()` only collapses space, tab, CR and LF, so `contains(., 'Total: ')` fails on `Total:&nbsp;12`. Use `translate(., '\u00a0', ' ')` (pass the real character from Python) or clean the text afterwards ([Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)).
- **`text()` is not the text.** `//a/text()` returns only direct text nodes, split around child elements (`Alpha <em>new</em>` yields `"Alpha "`). Use `string(.)` or `normalize-space(.)` for the full text.
- **`contains(@class, 'price')` over-matches** `price-old` and `noprice`. Use the `concat` idiom or `has-class()`.
- **Copied XPaths are brittle.** DevTools "Copy full XPath" produces `/html/body/div[3]/div[2]/table/tbody/tr[4]`: positional, and with a `<tbody>` that lxml does not insert ([HTML and the DOM](html-and-the-dom.md)).
- **Default namespaces in XML.** In feeds and sitemaps `//loc` matches nothing because XPath 1.0 has no default namespace; bind a prefix ([XML, RSS and Atom Feeds](xml-rss-atom-feeds.md)).
- **Quotes inside literals.** XPath 1.0 cannot escape a quote inside a string literal; use variables (`$label`) or `concat()`.
- **Version mismatch.** Snippets from XPath 2.0 tutorials (`lower-case()`, `matches()`, `ends-with()`) fail in lxml and browsers.

## Checklist

- [ ] Nested queries start with `.//` or `./`.
- [ ] Text comparisons go through `normalize-space()` and NBSP is handled.
- [ ] Positions are intentional: `//x[1]` versus `(//x)[1]`.
- [ ] No absolute paths copied from DevTools; anchored on ids, labels or stable attributes.
- [ ] Namespaces are bound when parsing XML.
- [ ] Every expression is covered by a fixture test.

## See Also

- [CSS Selectors for Extraction](css-selectors.md)
- [Writing Robust Selectors](robust-selectors.md)
- [HTML and the DOM](html-and-the-dom.md)
- [XML, RSS and Atom Feeds](xml-rss-atom-feeds.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [Scrapy](../tools/scrapy.md)
