---
tags: [scraping, parsing, json, embedded-data, jsonpath]
aliases: [__NEXT_DATA__, __NUXT_DATA__, embedded JSON, hydration data, window state, JSONPath, JMESPath, jq]
---

# JSON and Embedded Data

> Sources: IETF RFC 8259, The JSON Data Interchange Format (https://www.rfc-editor.org/rfc/rfc8259); IETF RFC 9535, JSONPath: Query Expressions for JSON (https://www.rfc-editor.org/rfc/rfc9535); jq manual (https://jqlang.org/manual/); JMESPath specification (https://jmespath.org/specification.html); Python documentation, json module (https://docs.python.org/3/library/json.html); chompjs (https://github.com/Nykakin/chompjs); jsonpath-ng (https://github.com/jsonpath-ng/jsonpath-ng); devalue (https://github.com/sveltejs/devalue); Node.js documentation, VM module (https://nodejs.org/api/vm.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Modern sites usually ship their data twice: once as rendered HTML and once as a JSON blob that the JavaScript framework uses to "hydrate" the page. That blob is cleaner than the HTML, typed, and far more stable than CSS classes, so look for it before writing selectors. It hides in `<script type="application/json">` tags (Next.js `__NEXT_DATA__`, Nuxt 3 `__NUXT_DATA__`), in JavaScript assignments (`window.__APOLLO_STATE__ = {...}`), in `data-*` attributes and in JSON-LD. Locate it with a parser or a narrow regex, decode it with the right tool (`json.loads`, chompjs for JavaScript literals, devalue for Nuxt 3 payloads), query it with JMESPath, JSONPath or jq, and validate its shape, because these blobs are internal and change without notice.

## Where embedded data hides

| Pattern | How to recognize it | How to decode |
|---|---|---|
| Next.js (pages router) | `<script id="__NEXT_DATA__" type="application/json">` with `props.pageProps` and `buildId` | `json.loads` |
| Next.js (app router) | Many `self.__next_f.push([1,"..."])` calls carrying React Server Component payloads | Hard to parse; prefer HTML, JSON-LD or the API |
| Nuxt 3 | `<script type="application/json" id="__NUXT_DATA__">` holding a flat array | devalue format (below) |
| Nuxt 2 | `window.__NUXT__=(function(a,b){...}(...))` | Needs a JavaScript engine; prefer the API |
| Apollo GraphQL cache | `window.__APOLLO_STATE__` with `"__ref": "Type:id"` pointers | chompjs or JSON, then resolve references |
| Redux and similar stores | `window.__PRELOADED_STATE__`, `window.__INITIAL_STATE__` | chompjs (often not strict JSON) |
| Generic JSON islands | `<script type="application/json" id="...">`, `data-props='{...}'` | Parser, then `json.loads` |
| Double-encoded | `JSON.parse("{\"a\":1}")` | Decode the string literal, then the JSON |
| Structured data | `<script type="application/ld+json">` | See [Structured Data (JSON-LD, Microdata, OpenGraph)](structured-data-schema-org.md) |

To find the blob, copy a distinctive visible value (a price, a SKU) and search the raw response for it. Whichever `<script>` contains it is your source. Pages-router Next.js sites also serve the same props from `/_next/data/<buildId>/<path>.json`, which is effectively an undocumented API: treat it with the same care as any hidden endpoint ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)).

## Decoding recipes (Python)

```python
import json, re
import chompjs
from parsel import Selector

html = '''<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"product":{"id":42,"name":"Kettle","offers":[{"price":19.99,"inStock":true},{"price":24.5,"inStock":false}]}}},"buildId":"abc123"}</script>
<script>window.__INITIAL_STATE__ = {user: null, items: [{id: 1, title: 'It\\'s "quoted"', tags: ['a','b',],}]};</script>
<script>var config = JSON.parse("{\\"apiBase\\":\\"https:\\/\\/api.example.com\\",\\"v\\":2}");</script>'''
sel = Selector(text=html)

# 1. A dedicated JSON script tag: plain json.loads
next_data = json.loads(sel.css("script#__NEXT_DATA__::text").get())
product = next_data["props"]["pageProps"]["product"]

# 2. A JavaScript object literal (unquoted keys, single quotes, trailing commas): chompjs
script = sel.xpath("//script[contains(., '__INITIAL_STATE__')]/text()").get()
state = chompjs.parse_js_object(script)          # parses the first object or array it finds

# 3. Strict JSON that follows a marker: raw_decode stops at the end of the value
def json_after(text: str, marker: str):
    start = text.index("{", text.index(marker) + len(marker))
    value, _end = json.JSONDecoder().raw_decode(text, start)
    return value

# 4. Double-encoded JSON: decode the string literal, then the JSON inside it
s = sel.xpath("//script[contains(., 'JSON.parse')]/text()").get()
literal = re.search(r'JSON\.parse\(("(?:[^"\\]|\\.)*")\)', s).group(1)
config = json.loads(json.loads(literal))         # {'apiBase': 'https://api.example.com', 'v': 2}
```

`raw_decode` fails on JavaScript literals (`Expecting property name enclosed in double quotes`), which is the signal to switch to chompjs. JSON in attributes needs no unescaping: the HTML parser already turned `&quot;` into `"`, so `json.loads(sel.css("div::attr(data-props)").get())` works.

Never evaluate page JavaScript with `eval` or Node's `vm` module to get at a blob: the Node documentation states that `vm` is not a security mechanism. If only a JavaScript engine can produce the value (as with Nuxt 2 function payloads), use the site's API or a real browser instead.

## Nuxt 3 payloads (devalue)

`__NUXT_DATA__` is serialized with devalue: a JSON array in which entry 0 is the root and every object value or array item is an index into the same array. Typed values are arrays that start with a type name (`["Date", "..."]`, `["Set", ...]`, `["Map", ...]`), Nuxt adds wrappers such as `["ShallowReactive", 1]`, and small negative integers encode `undefined`, `NaN` and infinities. In Node, use the library with pass-through revivers:

```ts
import * as cheerio from 'cheerio';
import { parse as devalueParse } from 'devalue';

const html = `<script id="__NEXT_DATA__" type="application/json">{"buildId":"abc123","props":{"pageProps":{}}}</script>
<script type="application/json" id="__NUXT_DATA__">[ ["ShallowReactive",1],{"data":2},{"product":3},{"name":4},"Kettle"]</script>`;
const $ = cheerio.load(html);
const next = JSON.parse($('script#__NEXT_DATA__').text()) as { buildId: string; props: { pageProps: Record<string, unknown> } };

const passThrough = (v: unknown) => v;
const nuxt = devalueParse($('script#__NUXT_DATA__').text(), {
  ShallowReactive: passThrough, Reactive: passThrough, Ref: passThrough, ShallowRef: passThrough,
});
```

devalue throws `Unknown type X` for a wrapper you did not list; add it as another pass-through. A Python decoder for the same format, checked against devalue's own `stringify` output:

```python
import json, math

SPECIAL = {-1: None, -2: None, -3: math.nan, -4: math.inf, -5: -math.inf, -6: -0.0}

def devalue_parse(text: str):
    values, cache = json.loads(text), {}
    if isinstance(values, int):
        return SPECIAL.get(values)

    def hydrate(i):
        if i in SPECIAL:
            return SPECIAL[i]
        if i in cache:
            return cache[i]
        v = values[i]
        if isinstance(v, list) and v and isinstance(v[0], str):     # ["Type", ...args]
            kind, args = v[0], v[1:]
            if kind == "Date":
                out = args[0]
            elif kind == "Set":
                out = [hydrate(x) for x in args]
            elif kind == "Map":
                out = {hydrate(k): hydrate(x) for k, x in zip(args[::2], args[1::2])}
            elif len(args) == 1 and isinstance(args[0], int):
                out = hydrate(args[0])                              # ShallowReactive, Reactive, Ref...
            else:
                out = {"__type__": kind, "args": args}
        elif isinstance(v, list):
            out = cache[i] = []
            out.extend(hydrate(x) for x in v)
        elif isinstance(v, dict):
            out = cache[i] = {}
            out.update({k: hydrate(x) for k, x in v.items()})
        else:
            out = v
        cache[i] = out
        return out

    return hydrate(0)

print(devalue_parse('[ ["ShallowReactive",1],{"data":2},{"product":3},{"name":4},"Kettle"]'))
# {'data': {'product': {'name': 'Kettle'}}}
```

## Normalized caches

GraphQL clients store entities once and point to them. Inline the pointers before mapping fields:

```python
def resolve_refs(node, cache, seen=frozenset()):
    if isinstance(node, dict):
        ref = node.get("__ref")
        if ref is not None:
            return {"__ref": ref} if ref in seen else resolve_refs(cache.get(ref, {}), cache, seen | {ref})
        return {k: resolve_refs(v, cache, seen) for k, v in node.items()}
    if isinstance(node, list):
        return [resolve_refs(v, cache, seen) for v in node]
    return node

state = {"ROOT_QUERY": {'product({"id":1})': {"__ref": "Product:1"}},
         "Product:1": {"name": "Kettle", "brand": {"__ref": "Brand:3"}},
         "Brand:3": {"name": "Acme"}}
print(resolve_refs(state["ROOT_QUERY"], state))
```

## Querying nested JSON

| Tool | Standard | Strength | Example: in-stock prices |
|---|---|---|---|
| JMESPath (`jmespath`) | JMESPath spec | Projections and filters, also in parsel (`Selector.jmespath`) | `props.pageProps.product.offers[?inStock].price` |
| JSONPath (`jsonpath-ng`) | RFC 9535 (2024); libraries predate it and differ in filter syntax | Recursive descent `$..price` | `$.props.pageProps.product.offers[?inStock == true].price` (jsonpath-ng `ext` parser) |
| jq | jq manual | Command line, transformations, streaming | `.props.pageProps.product.offers[] \| select(.inStock) \| .price` |

```python
import jmespath
from jsonpath_ng.ext import parse as jsonpath

print(jmespath.search("props.pageProps.product.offers[?inStock].price", next_data))      # [19.99]
print([m.value for m in jsonpath("$..price").find(next_data)])                          # [19.99, 24.5]
```

`jq -r 'paths(type == "number") | map(tostring) | join(".")' blob.json` lists every numeric path in a blob, which is a quick way to discover where a price lives.

## Pitfalls

- **Internal contracts change.** Keys get renamed, `buildId` changes on every deploy, and pages move between rendering modes. Validate the shape at the boundary ([Schema Validation](../data-quality/schema-validation.md)) and alert on failures.
- **Blob and page disagree.** The blob can hold all variants, other locales, stale cache values or experiment arms. Cross-check one or two values against the rendered page.
- **Partial data.** Hydration payloads often carry only the first page of results; pagination continues through an API.
- **Floats for money.** `json.loads` turns `19.99` into a float. Use `json.loads(s, parse_float=Decimal)` when values are prices.
- **Huge blobs.** Some payloads are megabytes. Parse once per page and extract what you need; do not run regexes over them repeatedly.
- **Personal data.** State blobs may include user, session or other customers' data that the page never displays. Drop what you do not need ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Checklist

- [ ] Searched the raw response for a visible value to find the data source.
- [ ] Used the narrowest decoder: `json.loads`, then chompjs, then devalue; never `eval`.
- [ ] Resolved references and wrappers before mapping fields.
- [ ] Parsed prices as `Decimal`, validated the schema and logged the build or version id.
- [ ] Spot-checked blob values against the rendered page.

## See Also

- [Structured Data (JSON-LD, Microdata, OpenGraph)](structured-data-schema-org.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)
- [Network Interception and Response Capture](../browser-automation/network-interception.md)
- [Schema Validation](../data-quality/schema-validation.md)
- [Regular Expressions: When and When Not](regex-in-scraping.md)
