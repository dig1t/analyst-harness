---
tags: [scraping, parsing, pdf, tables]
aliases: [PDF parsing, PDF scraping, pdfplumber, pypdf, Camelot, tabula, PDF tables]
---

# PDF Data Extraction

> Sources: ISO 32000-2:2020, PDF 2.0 (https://www.iso.org/standard/75839.html); pdfplumber (https://github.com/jsvine/pdfplumber); pypdf documentation (https://pypdf.readthedocs.io/en/latest/); pdfminer.six documentation (https://pdfminersix.readthedocs.io/); Camelot documentation (https://camelot-py.readthedocs.io/); tabula-py (https://github.com/chezou/tabula-py); OCRmyPDF documentation (https://ocrmypdf.readthedocs.io/); PyMuPDF documentation (https://pymupdf.readthedocs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A PDF is a page-description format: it records where glyphs are painted, not which words, lines, columns or tables they form. Every extractor rebuilds structure from coordinates and gaps, so results depend on the tool and its settings. Work in three steps. First classify each page (born-digital text, scanned image, or empty), because scanned pages need OCR. Then pick the tool for the job: pypdf for fast text and metadata, pdfplumber for layout-aware words and tables with visual debugging, Camelot or tabula for table-heavy reports, OCRmyPDF to add a text layer to scans. Finally crop to the region you need, set table strategies explicitly, and validate numbers (totals, row counts) because PDF extraction fails quietly.

## Why PDFs are hard

- **Text is positioned glyphs.** Spaces and line breaks are inferred from distances. Multi-column pages can interleave columns, and justified text can merge or split words.
- **Fonts may not map to Unicode.** Without a ToUnicode map, extractors output garbage or placeholders such as `(cid:42)`; OCR is then the only option.
- **Tables are drawings.** A ruled table is text plus line segments; an unruled table is text aligned by whitespace. Neither is marked as a table unless the producer wrote a tagged (accessible) PDF, and most tools ignore tags anyway.
- **Coordinates.** PDF user space starts at the bottom-left. pdfplumber converts to `top` and `bottom` measured from the top of the page and crops with `(x0, top, x1, bottom)`; Camelot's `table_areas` use PDF space, `"x1,y1,x2,y2"` for the top-left and bottom-right corners.

## Tools

| Tool | License | Best at | Limits |
|---|---|---|---|
| pypdf | BSD-3-Clause | Text, metadata, forms, splitting and merging, decrypting with a known password | Basic layout; no table detection |
| pdfminer.six | MIT | Low-level layout analysis (characters, text boxes) | Verbose API |
| pdfplumber | MIT (built on pdfminer.six) | Characters, words, lines and rectangles with coordinates; cropping; tables; debug images | No OCR; slower on very large files |
| PyMuPDF | AGPL-3.0 or commercial | Very fast text, blocks, rendering, table finding | License terms for closed-source use |
| Camelot | MIT | Tables: `lattice` (ruled), `stream` (whitespace), plus `network` and `hybrid` in 2.x | Text-based PDFs only |
| tabula-py | MIT, wraps tabula-java | Tables via `lattice` or `stream` modes | Needs a Java runtime |
| Poppler `pdftotext -layout` | GPL | Fast command-line text keeping column alignment | Text only |
| OCRmyPDF | MPL-2.0 | Adds a searchable text layer to scanned PDFs using Tesseract | OCR errors carry through |

## Step 1: classify pages

```python
import pdfplumber

def classify(path: str):
    """Yield (page_number, kind, chars, images) so scanned pages can be routed to OCR."""
    with pdfplumber.open(path) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            chars, images = len(page.chars), len(page.images)
            if chars > 20:
                text = page.extract_text() or ""
                kind = "text-unmapped-font" if "(cid:" in text else "text"
            else:
                kind = "scanned" if images else "empty"
            yield number, kind, chars, images
            page.close()                 # release cached objects on long documents

for row in classify("report.pdf"):
    print(row)                           # (1, 'text', 249, 0)
```

## Step 2: text

```python
from pypdf import PdfReader

reader = PdfReader("report.pdf")
print(reader.metadata.get("/Producer"))
plain = reader.pages[0].extract_text()                           # reading order, one cell per line in tables
layout = reader.pages[0].extract_text(extraction_mode="layout")  # keeps columns aligned with spaces
```

For layout-sensitive work use pdfplumber: `page.extract_words()` returns each word with `x0`, `x1`, `top` and `bottom`, so you can cluster words into lines by `top`, drop running headers and footers by position, or read a value to the right of a label. `page.extract_text(layout=True)` approximates the visual layout.

## Step 3: tables with pdfplumber

```python
import pdfplumber

with pdfplumber.open("report.pdf") as pdf:
    page = pdf.pages[0]

    # Ruled table: the default "lines" strategy follows drawn borders
    for table in page.extract_tables():
        header, *rows = table
        print(header)                    # ['Country', 'Population', 'GDP (USD bn)']

    # Unruled table: crop to the region first, then align on text
    anchor = next(w for w in page.extract_words() if w["text"] == "Item")
    region = page.crop((0, anchor["top"] - 2, page.width, anchor["top"] + 80))
    table = region.extract_table({"vertical_strategy": "text", "horizontal_strategy": "text"})
    rows = [r for r in table if any(r)]  # the text strategy emits blank spacer rows
    print(rows[0], rows[1])              # ['Item', 'Qty', 'Price'] ['Widget', '3', '9.99']

    # Draw what the table finder saw
    page.to_image(resolution=150).debug_tablefinder().save("debug.png")
```

Running the text strategy on the whole page instead of a crop split the paragraph above the tables into nonsense columns. Strategies are `lines`, `lines_strict`, `text` and `explicit`; with `explicit` you pass `explicit_vertical_lines` and `explicit_horizontal_lines` (x and y positions). Tolerances such as `snap_tolerance`, `join_tolerance` and `intersection_tolerance` control how nearly-touching lines merge.

## Camelot and tabula

```python
import camelot
import tabula

tables = camelot.read_pdf("report.pdf", pages="1", flavor="lattice")    # ruled tables
for t in tables:
    print(t.parsing_report)          # accuracy, whitespace, order, page
    df = t.df                        # strings; convert types yourself

dfs = tabula.read_pdf("report.pdf", pages="all", lattice=True)          # DataFrames, needs Java
```

For `stream` tables, Camelot accepts `table_areas=["x1,y1,x2,y2"]` and `columns=["x1,x2,..."]` to pin the region and column boundaries. Its `parsing_report` accuracy is a useful automatic gate: route low-accuracy tables to review.

## Multi-page tables

1. Extract each page with the same settings (or the same crop box).
2. Detect the repeated header row on continuation pages and drop it.
3. Merge rows split across a page break when the first cell of the new page is empty.
4. Remove running headers, footers and page numbers by cropping fixed bands or filtering words by `top`.
5. Concatenate and validate totals against the report's own summary rows.

## Scanned PDFs

Add a text layer with OCRmyPDF, then extract as usual:

```bash
ocrmypdf --skip-text --deskew -l eng --sidecar report.txt scanned.pdf ocred.pdf
```

`--skip-text` leaves pages that already have text alone, `--force-ocr` rasterizes and re-OCRs everything, and `--sidecar` writes the recognized text to a file. On a test page, OCR turned table rules into `|` characters and merged "long name" into "longname": clean and validate OCR output more strictly than born-digital text ([OCR and Image-Based Data](ocr-and-images.md)).

## Pitfalls

- **Ligatures and hyphenation.** `ﬁ` and `ﬂ` glyphs, soft hyphens and words broken across lines need normalization ([Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)).
- **Fake bold.** Some producers print each character twice with an offset; `page.dedupe_chars()` removes the duplicates.
- **Rotated pages.** Check `page.rotation`; rotated tables need rotation before extraction.
- **Forms.** AcroForm values live in fields, not in page text: `PdfReader(...).get_form_text_fields()`.
- **Encryption.** pypdf can open files with a password you were given (`reader.decrypt(password)`). Do not attempt to bypass passwords or permissions you were not given.
- **Silent number errors.** A column boundary off by a few points moves digits between columns. Check sums, ranges and row counts on every run.
- **Template changes.** Annual reports change layout between editions; store crop boxes and settings per template version.

## Checklist

- [ ] Classified pages (text, unmapped font, scanned, empty) and routed scans to OCR.
- [ ] Cropped to the region of interest and set table strategies explicitly.
- [ ] Saved debug images for new templates and reviewed them once.
- [ ] Removed repeated headers, footers and page numbers; merged continuation rows.
- [ ] Validated totals, row counts and numeric parse rates; kept the original PDF for re-runs.

## See Also

- [OCR and Image-Based Data](ocr-and-images.md)
- [Extracting HTML Tables](html-tables.md)
- [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)
- [Financial Data and SEC EDGAR](../sources/financial-data-sec-edgar.md)
- [Government and Open Data Portals](../sources/government-open-data.md)
- [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)
