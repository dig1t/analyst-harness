---
tags: [scraping, llm-scraping, html-cleaning, chunking, tokens]
aliases: [HTML to markdown for LLMs, token reduction, chunking pages, cleaning HTML for LLMs]
---

# Preparing HTML for LLMs

> Sources: Barbaresi 2021, Trafilatura, ACL-IJCNLP 2021 System Demonstrations (https://aclanthology.org/2021.acl-demo.15/); Mozilla Readability (https://github.com/mozilla/readability); Liu et al. 2023, Lost in the Middle: How Language Models Use Long Contexts (https://arxiv.org/abs/2307.03172); Jina AI 2025, ReaderLM-v2: Small Language Model for HTML to Markdown and JSON (https://arxiv.org/abs/2503.01151); Jeremy Howard, The /llms.txt file proposal (https://llmstxt.org/); Anthropic, Token counting (https://platform.claude.com/docs/en/build-with-claude/token-counting); OpenAI Help Center, What are tokens and how to count them (https://help.openai.com/en/articles/4936856-what-are-tokens-and-how-to-count-them); WHATWG HTML Living Standard (https://html.spec.whatwg.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Raw HTML is a poor input for a language model: most of its bytes are scripts, styles, tracking markup and attributes, and every one of them costs tokens, latency and attention. Preparing a page means pulling out embedded structured data first, removing what cannot matter, keeping the structure that does (headings, lists, tables, links, the attributes that hold values), converting to a compact representation such as Markdown or simplified HTML, and splitting long pages along natural boundaries. Done well, this often cuts input size by an order of magnitude while improving accuracy. Measure tokens with your provider's counter rather than guessing.

## Step 1: take the structured data first

Before cleaning anything, extract JSON-LD (`<script type="application/ld+json">`), framework state blobs such as `__NEXT_DATA__`, microdata and OpenGraph tags. They often contain exactly the fields you need, in which case no model call is required ([JSON and Embedded Data](../parsing/json-and-embedded-data.md), [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)). If you still call a model, pass the structured data alongside the text as extra context.

## Step 2: remove what cannot matter

- Elements: `script`, `style`, `noscript`, `svg`, `canvas`, `template`, `iframe`, HTML comments.
- Hidden content: `[hidden]`, `aria-hidden="true"`, inline `display:none`. Besides saving tokens, this removes a common hiding place for injected instructions, although injection can also hide in visible text.
- Boilerplate: navigation, footers, cookie banners and "related items" carousels, unless your task needs them (category navigation can be the data you want). Main-content extractors such as Trafilatura and Readability do this well for articles; see [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md).

## Step 3: keep the structure that carries meaning

- **Attributes with values:** `href`, `src` (sometimes), `alt`, `title`, `datetime`, `content` and `itemprop` (microdata), `aria-label`, and `data-*` attributes that hold prices, SKUs or ids. Drop `class`, `style` and event handlers unless you are generating selectors.
- **Links:** resolve to absolute URLs, strip tracking parameters, and consider replacing long URLs with short reference ids that you map back afterwards.
- **Tables:** keep header cells with their columns. Markdown tables work for simple grids; for `rowspan` and `colspan`, simplified HTML is safer ([Extracting HTML Tables](../parsing/html-tables.md)).
- **Node ids:** when you need to map extracted values back to DOM elements (for grounding or for selector generation), add a short id attribute to candidate elements before conversion.

## Step 4: pick a representation

| Representation | Good for | Watch out for |
|---|---|---|
| Raw HTML | Debugging only | Highest token cost, noise |
| Simplified HTML (pruned tags and attributes) | Listing pages, selector generation, tables | Still verbose; keep ids |
| Markdown | Articles, product pages, documentation | Converters can drop tables, attributes and images |
| Plain text | Classification, summarization | Loses structure and links |
| Accessibility tree snapshot | Browser agents choosing actions | Not a full content dump |
| Screenshot with a vision model | Canvas, image-heavy or layout-dependent pages | Expensive; text in images may be misread ([OCR and Image-Based Data](../parsing/ocr-and-images.md)) |

Small specialized models such as Jina's ReaderLM-v2 convert HTML to Markdown or JSON and can replace rule-based converters for messy pages. Some sites also publish clean Markdown for agents, signaled by an `/llms.txt` file or a `rel="alternate" type="text/markdown"` link; use it when present, while still honoring robots.txt and terms.

## Step 5: count tokens and chunk

A rough rule is about four characters per token for English text; markup, code, URLs and many other languages need more tokens per character, so count with the provider's tokenizer or endpoint (for example the Claude API's token counting endpoint) before choosing chunk sizes. Context windows are large today, but long inputs cost more, and Liu et al. (2023) showed that models use information in the middle of long contexts less reliably than information at the beginning or end. Smaller, focused inputs are usually more accurate.

Chunk along structure, not character offsets: split listing pages at item containers, articles at headings, tables by row groups with the header repeated. Repeat page-level context (URL, title, breadcrumb, currency) in every chunk, extract per chunk, then merge and deduplicate on a natural key.

```python
import json
import re
from bs4 import BeautifulSoup, Comment
from markdownify import markdownify

DROP = ["script", "style", "noscript", "svg", "canvas", "template", "iframe"]
KEEP = {"href", "src", "alt", "title", "datetime", "content", "itemprop", "aria-label", "data-price", "data-sku"}

def prepare(html: str) -> tuple[list[dict], str]:
    """Return (json_ld_blocks, markdown) for one page."""
    soup = BeautifulSoup(html, "lxml")
    json_ld = []
    for s in soup.select('script[type="application/ld+json"]'):
        try:
            json_ld.append(json.loads(s.get_text()))
        except json.JSONDecodeError:
            pass
    for tag in soup(DROP):
        tag.decompose()
    for c in soup.find_all(string=lambda t: isinstance(t, Comment)):
        c.extract()
    for el in soup.select('[hidden], [aria-hidden="true"], [style*="display:none"], [style*="display: none"]'):
        el.decompose()
    for el in soup.find_all(True):
        el.attrs = {k: v for k, v in el.attrs.items() if k in KEEP}
    md = markdownify(str(soup.body or soup), heading_style="ATX")
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    return json_ld, md

def chunks(md: str, max_chars: int = 12_000) -> list[str]:
    """Split at headings; very long sections need a second split by paragraph."""
    out, buf = [], ""
    for section in re.split(r"(?m)^(?=#{1,3} )", md):
        if buf and len(buf) + len(section) > max_chars:
            out.append(buf)
            buf = ""
        buf += section
    return out + ([buf] if buf else [])

def rough_tokens(text: str) -> int:
    return len(text) // 4   # estimate only; use the provider's counter for budgets
```

## Pitfalls

- Removing the data: prices in `data-` attributes, `content` attributes of microdata, or values only present in a script blob.
- Hidden-element removal that drops variant prices revealed by JavaScript; check against the rendered page.
- Converters that silently drop tables or merge cells.
- Content loaded later by JavaScript is not in the HTML at all ([Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)).
- Cookie banners and consent text repeated in every chunk.
- Mojibake from wrong encodings, which wastes tokens and confuses extraction ([Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)).
- Chunk boundaries that cut an item in half, producing two partial records.

## Checklist

- [ ] Structured data extracted before cleaning; model call skipped when it suffices.
- [ ] Non-content elements, comments and hidden nodes removed.
- [ ] Value-carrying attributes, links and table headers preserved.
- [ ] Representation chosen per page type; node ids added when mapping back is needed.
- [ ] Tokens measured with the provider's counter; chunks split at item or heading boundaries.
- [ ] Page-level context repeated in each chunk; merged output deduplicated.

## See Also

- [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md)
- [JSON and Embedded Data](../parsing/json-and-embedded-data.md)
- [Text Cleaning and Unicode Normalization](../parsing/text-cleaning-and-unicode.md)
- [Schema-Guided Extraction](schema-guided-extraction.md)
- [Costs and Caching for LLM Scraping](llm-scraping-costs.md)
- [HTML and the DOM](../parsing/html-and-the-dom.md)
