---
tags: [scraping, parsing, tables, pandas]
aliases: [HTML tables, read_html, pandas.read_html, rowspan, colspan, table extraction]
---

# Extracting HTML Tables

> Sources: WHATWG HTML Living Standard, Tabular data (https://html.spec.whatwg.org/multipage/tables.html); MDN Web Docs, The table element (https://developer.mozilla.org/en-US/docs/Web/HTML/Element/table); W3C WAI, Tables tutorial (https://www.w3.org/WAI/tutorials/tables/); pandas documentation, pandas.read_html (https://pandas.pydata.org/docs/reference/api/pandas.read_html.html); lxml.html documentation (https://lxml.de/lxmlhtml.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

HTML tables look like ready-made datasets, but merged cells (`rowspan`, `colspan`), multi-row headers, row headers in the first column, totals rows, footnote markers and units in headers turn naive row loops into misaligned data. `pandas.read_html` expands spans, builds multi-level headers and converts numbers, and is the fastest route for clean tables: pass it the HTML you fetched wrapped in `io.StringIO` and select the table by text or attributes, never by position. When you need links, attributes, per-cell cleaning or tables that pandas mangles, expand the table into a rectangular grid yourself (code below), then map header rows to column names. Always validate: row counts, expected headers, totals that add up.

## The table model in brief

- A `<table>` holds an optional `<caption>`, `<colgroup>`s, a `<thead>`, one or more `<tbody>`s and a `<tfoot>`; rows are `<tr>`, cells are `<th>` (header) or `<td>` (data).
- `colspan` and `rowspan` make a cell cover several slots. The HTML processing model clamps `colspan` to 1000 and `rowspan` to 65534, and `rowspan="0"` means "to the end of the row group".
- `scope="col"`, `scope="row"` and `headers="id1 id2"` link data cells to their headers. They are accessibility hints that also tell you which cells are labels.
- Browser-compatible parsers insert `<tbody>` when the source omits it; lxml does not ([HTML and the DOM](html-and-the-dom.md)).

## Fast path: pandas.read_html

```python
import io
import pandas as pd

html = """<table id="results"><caption>Results 2025</caption>
<thead><tr><th rowspan="2">Region</th><th colspan="2">Sales</th></tr>
<tr><th>Q1</th><th>Q2</th></tr></thead>
<tbody>
<tr><td rowspan="2"><a href="/north">North</a></td><td>1.234,5</td><td>2.000</td></tr>
<tr><td>10</td><td>20</td></tr>
<tr><td>South</td><td>5</td><td>6</td></tr>
</tbody></table>"""

tables = pd.read_html(io.StringIO(html), match="Results", thousands=".", decimal=",")
df = tables[0]
df.columns = [" ".join(dict.fromkeys(c for c in col if c)) for col in df.columns]  # ('Sales', 'Q1') -> 'Sales Q1'
print(df)
#   Region  Sales Q1  Sales Q2
# 0  North    1234.5      2000
# 1  North      10.0        20
# 2  South       5.0         6

links = pd.read_html(io.StringIO(html), match="Results", extract_links="body")[0]
print(links.iloc[0, 0])          # ('North', '/north')
```

What to know about `read_html`:

| Parameter or behavior | Detail |
|---|---|
| Input | A path, URL or file-like object. pandas 2.1 deprecated literal HTML strings and pandas 3 treats a string as a path, so wrap HTML in `io.StringIO` |
| `match` | Regex or string the table's text must contain (default `.+`, every table) |
| `attrs` | Filter by attributes, for example `{"id": "results"}` |
| `header` | Row index or list of rows for a MultiIndex; without `<th>` cells the columns are numbered `0, 1, 2` unless you pass `header=0` |
| `thousands`, `decimal` | Defaults `","` and `"."`; set them per source locale |
| `extract_links` | `"body"`, `"header"`, `"footer"` or `"all"` return `(text, href)` tuples |
| `displayed_only` | Default `True` drops cells styled `display: none` |
| `flavor` | Default tries lxml, then BeautifulSoup with html5lib |
| Spans | `rowspan` and `colspan` values are copied into every covered slot |
| `na_values` | Defaults treat strings like `n/a` and `NA` as missing |

Fetch with your own HTTP client (headers, rate limits, caching) and pass the text; do not hand URLs to `read_html` in production.

## Full control: expand to a grid

```python
import lxml.html

def span(cell, attr, limit):
    try:
        return max(1, min(int(cell.get(attr, "1")), limit))
    except ValueError:
        return 1

def table_to_grid(table):
    """Expand rowspan/colspan into a rectangular list of rows of cell texts."""
    grid, pending = [], {}                       # pending[(row, col)] = text carried down by a rowspan
    rows = table.xpath("./thead/tr | ./tbody/tr | ./tfoot/tr | ./tr")
    for r, tr in enumerate(rows):
        out, c = [], 0
        for cell in tr.xpath("./th | ./td"):
            while (r, c) in pending:
                out.append(pending.pop((r, c))); c += 1
            text = " ".join(cell.text_content().split())
            rs, cs = span(cell, "rowspan", 65534), span(cell, "colspan", 1000)
            for dc in range(cs):
                out.append(text)
                for dr in range(1, rs):
                    pending[(r + dr, c + dc)] = text
            c += cs
        while (r, c) in pending:
            out.append(pending.pop((r, c))); c += 1
        grid.append(out)
    width = max((len(row) for row in grid), default=0)
    return [row + [""] * (width - len(row)) for row in grid]

doc = lxml.html.fromstring(html)
grid = table_to_grid(doc.xpath("//table[caption[contains(., 'Results')]]")[0])
header_rows = 2
headers = [" ".join(dict.fromkeys(h for h in col if h)) for col in zip(*grid[:header_rows])]
records = [dict(zip(headers, row)) for row in grid[header_rows:]]
print(records[0])   # {'Region': 'North', 'Sales Q1': '1.234,5', 'Sales Q2': '2.000'}
```

The helper treats `rowspan="0"` as 1 and reads `text_content()`, which includes nested tables; extend it if your source uses either. The same algorithm in TypeScript with cheerio:

```ts
import * as cheerio from 'cheerio';

export function tableToGrid($: cheerio.CheerioAPI, table: string): string[][] {
  const grid: string[][] = [];
  const carried = new Map<string, string>();               // "row,col" -> text from a rowspan above
  $(table).find('tr').each((r, tr) => {
    const row: string[] = [];
    let c = 0;
    const fill = () => { while (carried.has(`${r},${c}`)) { row.push(carried.get(`${r},${c}`)!); carried.delete(`${r},${c}`); c++; } };
    $(tr).children('th, td').each((_, cell) => {
      fill();
      const text = $(cell).text().replace(/\s+/g, ' ').trim();
      const rs = Math.max(1, Number($(cell).attr('rowspan') ?? 1) || 1);
      const cs = Math.max(1, Number($(cell).attr('colspan') ?? 1) || 1);
      for (let dc = 0; dc < cs; dc++) {
        row.push(text);
        for (let dr = 1; dr < rs; dr++) carried.set(`${r + dr},${c + dc}`, text);
      }
      c += cs;
    });
    fill();
    grid.push(row);
  });
  const width = Math.max(0, ...grid.map((row) => row.length));
  return grid.map((row) => [...row, ...Array(width - row.length).fill('')]);
}
```

## Finding the right table

| Strategy | Example |
|---|---|
| Caption text | `//table[caption[contains(., 'Results')]]` |
| A known header | `//table[.//th[normalize-space()='Population']]` |
| Id or stable class | `table#results`, `table.wikitable` |
| Nearby heading | `//h2[contains(., 'Results')]/following::table[1]` |
| pandas | `match="Population"`, `attrs={"id": "results"}` |

Index-based picks (`tables[3]`) break as soon as a banner or layout table is added.

## Key-value tables

Spec sheets put labels in the first column. Turn them into a dictionary instead of a DataFrame:

```python
from parsel import Selector

sel = Selector(text="<table class='specs'><tr><th>Weight</th><td>2 kg</td></tr><tr><th>Color</th><td>Red</td></tr></table>")
specs = {
    row.xpath("normalize-space(th)").get(): row.xpath("normalize-space(td)").get()
    for row in sel.xpath("//table[@class='specs']//tr[th and td]")
}
print(specs)    # {'Weight': '2 kg', 'Color': 'Red'}
```

## Cleaning cell values

- Strip footnote markers (`12.5[a]`, `*`, superscript numbers) before numeric conversion: `df[col].str.replace(r"\[.*?\]", "", regex=True)`.
- Move units out of headers into a unit column or a column name convention (`gdp_usd_bn`).
- Treat accounting negatives `(300)`, Unicode minus U+2212 and dash placeholders (U+2013, U+2014) explicitly; one such cell keeps the whole column as text.
- Normalize NBSP and thin spaces used as thousands separators ([Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)) and parse numbers with the source locale ([Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)).

## Tables that are not tables

- **Div grids.** `role="table"`, `role="row"` and `role="cell"` (or CSS grid classes): iterate rows with selectors and use the card pattern ([CSS Selectors for Extraction](css-selectors.md)).
- **Client-rendered tables.** If the table is empty in the server HTML, it is filled from JSON: use that JSON ([JSON and Embedded Data](json-and-embedded-data.md)).
- **Paginated or virtualized tables.** Only visible rows exist in the DOM; find the data endpoint ([Pagination Patterns](../crawling/pagination-patterns.md)).
- **Tables in PDFs or images.** See [PDF Data Extraction](pdf-extraction.md) and [OCR and Image-Based Data](ocr-and-images.md).

## Pitfalls

- **Totals mixed into data.** `<tfoot>` rows and in-body subtotal rows come back as ordinary rows. Flag or drop them, and use them to validate sums.
- **Repeated header rows.** Long tables repeat the header every N rows; drop rows equal to the header.
- **Silent string columns.** `n/a` becomes NaN, but `(300)` or `12*` keeps the column as text. Check dtypes after loading.
- **Hidden cells.** `displayed_only=True` drops inline `display: none` cells, but not cells hidden by a stylesheet class.
- **Nested tables.** Layout tables wrap data tables; select the innermost data table, and avoid `find('tr')` on the outer one.
- **Header guessing.** Without `<th>` there is no header; decide per source which rows are headers and assert them.

## Checklist

- [ ] Selected the table by caption, header text or id, not by index.
- [ ] Expanded spans and combined multi-row headers into unique column names.
- [ ] Removed totals, repeated headers and footnote markers; parsed numbers with the source locale.
- [ ] Asserted expected headers and a plausible row count on every run.
- [ ] Kept links (`extract_links`) or ids when rows need to join with other data.

## See Also

- [PDF Data Extraction](pdf-extraction.md)
- [Parsing Dates, Numbers and Currencies](dates-numbers-currencies.md)
- [XPath for Extraction](xpath.md)
- [Data Cleaning Pipeline](../data-quality/data-cleaning-pipeline.md)
- [Government and Open Data Portals](../sources/government-open-data.md)
