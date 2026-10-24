---
tags: [scraping, parsing, structured-data, schema-org, json-ld]
aliases: [JSON-LD, Microdata, OpenGraph, Open Graph, schema.org, RDFa, extruct, rich snippets]
---

# Structured Data (JSON-LD, Microdata, OpenGraph)

> Sources: schema.org (https://schema.org/); schema.org, Product (https://schema.org/Product) and price (https://schema.org/price); W3C, JSON-LD 1.1 (https://www.w3.org/TR/json-ld11/); WHATWG HTML Living Standard, Microdata (https://html.spec.whatwg.org/multipage/microdata.html); W3C, RDFa Lite 1.1 (https://www.w3.org/TR/rdfa-lite/); The Open Graph protocol (https://ogp.me/); Google Search Central, Introduction to structured data markup (https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data); extruct (https://github.com/scrapinghub/extruct); Schema Markup Validator (https://validator.schema.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Sites annotate pages with machine-readable metadata so search engines can show rich results and social networks can build link previews. For a scraper this is often the cleanest and most stable data on the page: schema.org types (Product, Offer, Article, JobPosting, Event, LocalBusiness) expressed as JSON-LD in `<script type="application/ld+json">`, as Microdata attributes (`itemscope`, `itemprop`) or as RDFa, plus OpenGraph and Twitter Card `<meta>` tags for titles and images. Extract every syntax at once with extruct, flatten JSON-LD (`@graph`, top-level arrays, `@type` lists, `@id` references), map properties into your own schema, and cross-check against the visible page, because markup can be stale, partial or duplicated.

## Syntaxes compared

| Syntax | Where it lives | Example | Extract with |
|---|---|---|---|
| JSON-LD | `<script type="application/ld+json">` | `{"@context": "https://schema.org", "@type": "Product"}` | `json.loads`, extruct |
| Microdata | `itemscope`, `itemtype`, `itemprop` attributes | `<span itemprop="price" content="19.99">19,99 €</span>` | extruct, selectors |
| RDFa | `vocab`, `typeof`, `property` attributes | `<div vocab="https://schema.org/" typeof="Product">` | extruct |
| OpenGraph | `<meta property="og:...">` | `og:title`, `og:type`, `og:image`, `og:url` | extruct, selectors |
| Twitter Cards | `<meta name="twitter:...">` | `twitter:card`, `twitter:title` | selectors |
| Microformats | Class names | `h-card`, `h-entry` | extruct (`microformat`) |
| Dublin Core | `<meta name="DC.title">` | Library and repository pages | extruct (`dublincore`) |

OpenGraph describes the page, not the items on it: on a category page `og:title` is the category name.

## schema.org types worth knowing

| Type | Properties scrapers use |
|---|---|
| `Product` | `name`, `sku`, `gtin13`, `mpn`, `brand`, `offers`, `aggregateRating`, `image` |
| `Offer`, `AggregateOffer` | `price`, `priceCurrency`, `availability`, `priceValidUntil`, `itemCondition`, `lowPrice`, `highPrice`, `offerCount` |
| `Article`, `NewsArticle`, `BlogPosting` | `headline`, `datePublished`, `dateModified`, `author`, `publisher` |
| `JobPosting` | `title`, `datePosted`, `validThrough`, `hiringOrganization`, `jobLocation`, `baseSalary`, `employmentType` |
| `Event` | `name`, `startDate`, `endDate`, `location`, `eventStatus`, `offers` |
| `LocalBusiness`, `Organization` | `name`, `address` (`PostalAddress`), `telephone`, `geo`, `openingHoursSpecification` |
| `BreadcrumbList` | `itemListElement` of `ListItem` (`position`, `name`, `item`) |
| `AggregateRating`, `Review` | `ratingValue`, `reviewCount`, `bestRating`, `author` |

schema.org asks publishers to write `price` with a `.` decimal point and plain digits, and to put the currency in `priceCurrency` as an ISO 4217 code; real sites do not always comply, so validate.

## Extraction with extruct

```python
import extruct
from w3lib.html import get_base_url

html = """<html><head>
<meta property="og:title" content="Acme Kettle 1.7L"><meta property="og:type" content="product">
<script type="application/ld+json">
{"@context": "https://schema.org", "@graph": [
  {"@type": "Organization", "@id": "#org", "name": "Acme"},
  {"@type": "Product", "name": "Acme Kettle", "sku": "K-17", "brand": {"@id": "#org"},
   "offers": {"@type": "Offer", "price": "19.99", "priceCurrency": "EUR",
              "availability": "https://schema.org/InStock"}}]}
</script></head><body>
<div itemscope itemtype="https://schema.org/Product"><span itemprop="name">Acme Kettle</span>
  <div itemprop="offers" itemscope itemtype="https://schema.org/Offer">
    <meta itemprop="priceCurrency" content="EUR"><span itemprop="price" content="19.99">19,99 €</span>
  </div></div></body></html>"""
url = "https://shop.example/p/k17"

data = extruct.extract(
    html,
    base_url=get_base_url(html, url),
    syntaxes=["json-ld", "microdata", "opengraph"],
    uniform=True,       # microdata, microformat, OpenGraph and Dublin Core in JSON-LD-like shape
    errors="log",       # default "strict" raises on the first broken syntax
)
```

extruct parses JSON-LD with `json.loads(strict=False)` and, on failure, retries with a lenient parser after stripping leading comment lines, so blocks with comments or trailing commas usually survive. For Microdata it prefers the `content` attribute over visible text, which is why `price` comes out as `19.99` and not `19,99 €`.

## Normalizing and mapping

```python
from decimal import Decimal, InvalidOperation

def iter_nodes(value):
    """Yield every dict with an @type at any depth (flattens @graph and lists)."""
    stack = [value]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(node))
        elif isinstance(node, dict):
            if "@type" in node:
                yield node
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))

def types_of(node) -> set[str]:
    t = node.get("@type", [])
    return {x.rsplit("/", 1)[-1] for x in ([t] if isinstance(t, str) else t)}  # "http://schema.org/Product" -> "Product"

def as_list(v):
    return v if isinstance(v, list) else ([] if v is None else [v])

def to_decimal(v):
    try:
        return Decimal(str(v).strip()) if v not in (None, "") else None
    except InvalidOperation:
        return None     # "19,99" or "$19.99": log and hand to a locale-aware parser

def products(data: dict, url: str):
    nodes = list(iter_nodes(data.get("json-ld", []))) + list(iter_nodes(data.get("microdata", [])))
    by_id = {n["@id"]: n for n in nodes if "@id" in n}
    for node in nodes:
        if "Product" not in types_of(node):
            continue
        brand = node.get("brand")
        if isinstance(brand, dict) and "name" not in brand:
            brand = by_id.get(brand.get("@id"), brand)           # resolve {"@id": "#org"}
        for offer in as_list(node.get("offers")) or [{}]:
            yield {
                "url": url,
                "name": node.get("name"),
                "sku": node.get("sku"),
                "brand": brand.get("name") if isinstance(brand, dict) else brand,
                "price": to_decimal(offer.get("price", offer.get("lowPrice"))),
                "currency": offer.get("priceCurrency"),
                "availability": str(offer.get("availability") or "").rsplit("/", 1)[-1] or None,
            }

for p in products(data, url):
    print(p)    # once from JSON-LD (with sku and brand), once from Microdata: merge, prefer JSON-LD
```

OpenGraph without extruct, and JSON-LD in TypeScript:

```python
from parsel import Selector
og = {m.attrib["property"]: m.attrib.get("content") for m in Selector(text=html).css('meta[property^="og:"]')}
```

```ts
import * as cheerio from 'cheerio';

type JsonLd = Record<string, unknown>;

export function jsonLdBlocks(html: string): JsonLd[] {
  const $ = cheerio.load(html);
  const out: JsonLd[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed: unknown = JSON.parse($(el).text());
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === 'object') out.push(item as JsonLd);
      }
    } catch {
      // malformed block: count it, and use a lenient parser if the data matters
    }
  });
  return out;
}
```

## Cross-checking

Google's guidelines say markup should describe content visible on the page, but scrapers regularly meet stale cached prices, markup for only the default variant, `AggregateOffer` ranges instead of per-variant offers, and SEO-only fields. Compare at least the price and availability with the rendered values on a sample of pages, record which source supplied each field ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)), and inspect odd pages with the Schema Markup Validator.

## Pitfalls

- **Several blocks per page.** Product, BreadcrumbList, Organization and WebSite blocks often coexist; filter by type, never take "the first block".
- **Type spelling varies.** `@type` may be a list (`["Product", "Vehicle"]`), a full IRI, `http` or `https`; availability may be `https://schema.org/InStock`, `http://schema.org/InStock` or `InStock`.
- **Duplicates across syntaxes.** The same product in JSON-LD and Microdata becomes two records unless you merge them.
- **Prices in disguise.** Strings with symbols or comma decimals, numbers as floats, or a `priceSpecification` object instead of `price`.
- **Missing time zones.** `datePublished` like `2025-02-03T09:00` has no offset; apply the site's zone explicitly ([Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)).
- **Strict mode surprises.** extruct's default `errors="strict"` raises on one broken syntax and loses the others; use `"log"` in production.

## Checklist

- [ ] Extracted all syntaxes, with `base_url` set so relative URLs resolve.
- [ ] Flattened `@graph` and arrays, normalized `@type`, resolved `@id` references.
- [ ] Mapped properties into your own schema with `Decimal` prices and ISO currency codes.
- [ ] Merged duplicates across syntaxes and recorded field provenance.
- [ ] Cross-checked price and availability against the visible page on a sample.

## See Also

- [JSON and Embedded Data](json-and-embedded-data.md)
- [E-commerce and Price Monitoring](../sources/ecommerce-and-prices.md)
- [Job Postings](../sources/job-postings.md)
- [Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Schema Validation](../data-quality/schema-validation.md)
