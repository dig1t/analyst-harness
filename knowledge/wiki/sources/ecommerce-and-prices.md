---
tags: [scraping, sources, ecommerce, pricing, structured-data]
aliases: [price monitoring, price scraping, product data, competitor pricing]
---

# E-commerce and Price Monitoring

> Sources: schema.org Product (https://schema.org/Product), Offer (https://schema.org/Offer) and ProductGroup (https://schema.org/ProductGroup); Google Search Central, Product variant structured data (https://developers.google.com/search/docs/appearance/structured-data/product-variants); Google Search Central, Merchant listing structured data (https://developers.google.com/search/docs/appearance/structured-data/merchant-listing); Shopify Ajax API, Product reference (https://shopify.dev/docs/api/ajax/reference/product); Amazon Associates, Creators API and PA-API 5 deprecation (https://affiliate-program.amazon.com/creatorsapi/docs/en-us/paapiv5-deprecation); eBay Browse API (https://developer.ebay.com/api-docs/buy/browse/overview.html); Directive (EU) 2019/2161 inserting Article 6a into Directive 98/6/EC (https://eur-lex.europa.eu/eli/dir/2019/2161/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Price monitoring turns product pages into a time series: the same product observed again and again, with price, currency, availability and seller recorded each time. The best data usually comes from feeds and APIs (affiliate network product feeds, marketplace APIs, your own merchant data), then from `Product` and `Offer` structured data that shops publish for search engines, then from storefront JSON endpoints, and only last from rendered HTML. Large retailers commonly prohibit automated access in their terms, so check the terms and prefer licensed feeds where they exist. Model observations as append-only rows, never as an overwritten "current price" field.

## Acquisition routes

| Route | When it fits | Notes |
|---|---|---|
| Affiliate and partner product feeds | Broad catalogs with prices | Licensed CSV/XML feeds from affiliate networks; terms define display and caching |
| Marketplace APIs | eBay listings, Amazon catalog | eBay's Browse API searches and reads listings. Amazon retired Product Advertising API 5.0 in 2026 (deprecated 30 April, endpoint retired 15 May 2026) in favor of the Creators API, which requires an eligible Associates account (as of 2026-10) |
| JSON-LD structured data | Most modern shops | `Product`, `Offer`, `AggregateOffer`, `ProductGroup`; cheap, stable, server-rendered |
| Storefront JSON | Platform shops | Shopify's documented Ajax API returns product JSON at `/{locale}/products/{handle}.js`, unauthenticated, prices in the customer's presentment currency; meant for themes, with abuse prevention but no hard published rate limit |
| Hidden JSON APIs | Search and listing pages | See [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md); respect terms and rate limits |
| Rendered HTML or browser | Prices injected by JavaScript | Last resort; see [When You Need a Browser](../browser-automation/when-to-use-a-browser.md) |

Product sitemaps (often split per category) give you the URL inventory and `lastmod` for incremental recrawls, which is far cheaper than paging through search results. See [Incremental Crawling](../crawling/incremental-crawling.md).

## Structured data first

Shops publish `Product` markup so that search engines can show price and availability. Google's merchant listing documentation describes the supported properties, and since 2024 Google also supports variant markup: a `ProductGroup` with `hasVariant` (the individual `Product` variants), `variesBy` (for example size or color) and `productGroupID` (the parent SKU). Each variant carries its own `offers`. Useful fields: `sku`, `gtin13`/`gtin`, `mpn`, `brand`, `offers.price`, `offers.priceCurrency`, `offers.availability` (for example `https://schema.org/InStock`), `offers.priceValidUntil`, `offers.itemCondition` and `offers.seller`.

```python
import json
import httpx
from selectolax.lexbor import LexborHTMLParser   # selectolax 1.0+; the old Modest backend is gone

UA = "ExamplePriceBot/1.0 (+https://example.org/bot; bot@example.org)"

def jsonld_items(html: str):
    for node in LexborHTMLParser(html).css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text())
        except json.JSONDecodeError:
            continue
        stack = [data]
        while stack:
            item = stack.pop()
            if isinstance(item, list):
                stack.extend(item)
            elif isinstance(item, dict):
                stack.extend(item.get("@graph", []))
                yield item

def as_list(x):
    return x if isinstance(x, list) else ([] if x is None else [x])

def observe(url: str) -> list[dict]:
    html = httpx.get(url, headers={"User-Agent": UA}, timeout=30, follow_redirects=True).text
    rows = []
    for item in jsonld_items(html):
        types = as_list(item.get("@type"))
        products = as_list(item.get("hasVariant")) if "ProductGroup" in types else (
            [item] if "Product" in types else [])
        for p in products:
            for o in as_list(p.get("offers")):
                rows.append({"url": url, "sku": p.get("sku"), "gtin": p.get("gtin13") or p.get("gtin"),
                             "group_id": item.get("productGroupID"), "name": p.get("name"),
                             "price": o.get("price", o.get("lowPrice")),
                             "currency": o.get("priceCurrency"),
                             "availability": o.get("availability")})
    return rows
```

Cross-check structured data against the visible price on a sample of pages. Markup can lag behind the rendered page (cached fragments, client-side promotions), and the visible price is what a customer pays.

## Data model

- **Product identity:** GTIN where available, otherwise retailer plus SKU, plus `productGroupID` for variants. Canonical URL is a locator, not an identity; URLs change.
- **Observation rows:** `observed_at` (UTC), product key, seller, price, currency, list or "was" price, availability, condition, shipping cost if shown, region and locale used for the request, tax-inclusive flag, unit price, and a pointer to the raw response. Append only; derive "current price" and history views from it. See [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md).
- **Product attributes** (title, brand, specs) change slowly; store them as slowly changing dimensions.

## Regulatory context worth knowing

In the EU, Article 6a of the Price Indication Directive (inserted by Directive 2019/2161, applicable since May 2022) requires any announced price reduction to show the prior price, defined as the lowest price applied in a period of at least 30 days before the reduction. The Court of Justice confirmed in 2024 (Case C-330/23, Aldi Süd) that percentage discounts must be calculated from that prior price. Price histories with daily observations are exactly what you need to check such claims, and they also explain why EU shops display "lowest price in 30 days" fields you may want to capture. Directive 98/6/EC also requires unit prices (per kilogram or liter) for many goods, which are often worth extracting.

## Legal and ethical notes

- Many large retailers prohibit robots and scraping in their terms. Breach of contract risk depends on how the terms were accepted ([Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)); logged-in scraping raises it sharply.
- Prices are facts, but product descriptions, photos and reviews are copyrighted, and EU catalogs can be protected by the database right.
- Using scraped competitor prices to coordinate with competitors is a competition-law problem regardless of how the data was collected.
- Do not defeat bot protection to keep a monitor running. If a site blocks you, slow down, ask, or buy data ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

## Pitfalls

- Prices vary by country, currency, postcode, logged-in state, membership and A/B test bucket. Record the request context or your series will mix populations.
- "From" prices and `AggregateOffer.lowPrice` are not the price of a specific variant.
- Variant prices often change only after selecting options; collect each variant explicitly.
- Out-of-stock pages may keep showing the last price; store availability with every observation.
- Decimal separators and currency symbols differ by locale ([Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)); "1.299" can mean 1299.
- Multi-buy offers, coupons and loyalty prices are not in the `price` field.
- Search and listing pages are expensive for the site; crawl product URLs from sitemaps instead.

## Checklist

- [ ] Looked for a licensed feed or marketplace API before crawling.
- [ ] Terms of the target sites reviewed; no logged-in scraping without permission.
- [ ] JSON-LD parsed first; visible-price cross-check on a sample.
- [ ] Request context (locale, currency, region) fixed and recorded.
- [ ] Append-only observations with raw response pointers.
- [ ] Variants captured individually; availability stored with each price.
- [ ] Polite schedule driven by sitemaps and `lastmod`, with rate limits.

## See Also

- [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)
- [Parsing Dates, Numbers and Currencies](../parsing/dates-numbers-currencies.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
