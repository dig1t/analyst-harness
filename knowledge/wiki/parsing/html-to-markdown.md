---
tags: [scraping, parsing, markdown, content-extraction, boilerplate]
aliases: [HTML to Markdown, main content extraction, article extraction, Readability, trafilatura, turndown, markdownify]
---

# Converting HTML to Markdown and Text

> Sources: trafilatura documentation (https://trafilatura.readthedocs.io/); Mozilla Readability (https://github.com/mozilla/readability); readability-lxml (https://github.com/buriy/python-readability); turndown (https://github.com/mixmark-io/turndown); markdownify (https://github.com/matthewwithanm/python-markdownify); html2text (https://github.com/Alir3z4/html2text); html-text (https://github.com/zytedata/html-text); CommonMark specification (https://spec.commonmark.org/); GitHub Flavored Markdown specification (https://github.github.com/gfm/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Turning a web page into readable text is two jobs. **Main-content extraction** finds the article body and drops navigation, ads, footers, cookie banners and related links (trafilatura, Readability). **Conversion** turns the chosen HTML into Markdown or plain text while keeping headings, lists, links, code and tables (markdownify, turndown, html2text, html-text). Together they give compact, clean text for LLM prompts, search indexes, archives and change detection. Use main-content extraction only on article-like pages (product and listing pages need selectors or structured data), pass the page URL so links become absolute, extract data tables separately, check output length and language to catch silent failures, keep the original HTML, and mind licenses: html2text is GPL-3.0.

## Tools

| Tool | Language | Job | Output | License |
|---|---|---|---|---|
| trafilatura | Python | Main content, metadata and conversion in one call | `txt`, `markdown`, `json`, `xml`, `xmltei`, `csv`, `html` | Apache-2.0 |
| readability-lxml | Python | Main content (port of the Readability algorithm) | Cleaned HTML | Apache-2.0 |
| @mozilla/readability | JavaScript, needs a DOM (jsdom) | Main content, as in Firefox Reader View | HTML, text, title, byline, excerpt | Apache-2.0 |
| markdownify | Python | HTML to Markdown | Markdown | MIT |
| turndown (+ turndown-plugin-gfm) | JavaScript | HTML to Markdown, GFM tables via plugin | Markdown | MIT |
| html2text | Python | HTML to Markdown-style text | Markdown | GPL-3.0-or-later |
| html-text | Python | HTML to plain text with sensible line breaks | Text | MIT |

On a test news page, trafilatura kept the headline, body, subheading, table, list and link and dropped the navigation, sidebar, byline paragraph and footer; Readability kept the byline paragraph; markdownify on the full page kept everything, navigation included.

## Python

```python
import trafilatura
from readability import Document
from markdownify import markdownify

def html_to_markdown(html: str, url: str, min_chars: int = 200) -> str | None:
    """Main content as Markdown: trafilatura first, Readability plus markdownify as fallback."""
    md = trafilatura.extract(
        html, url=url, output_format="markdown",
        include_tables=True, include_links=True, include_comments=False,
    )
    if md and len(md) >= min_chars:
        return md
    article_html = Document(html).summary(html_partial=True)
    md = markdownify(article_html, heading_style="ATX", strip=["img"])   # markdownify defaults to setext headings
    return md.strip() if len(md.strip()) >= min_chars else None

html = open("page.html", encoding="utf-8").read()    # the response you saved
print(html_to_markdown(html, "https://news.example/2025/02/rates"))
meta = trafilatura.extract_metadata(html)            # title, author, date, sitename, ...
print(meta.title, meta.author, meta.date)
```

`trafilatura.extract(..., with_metadata=True)` prepends a YAML-style header (title, author, URL, date). `bare_extraction()` returns a document object with text and metadata as attributes, or a dictionary with `as_dict=True`. `favor_precision=True` and `favor_recall=True` trade boilerplate against completeness. For plain text without Markdown syntax, `html_text.extract_text(html)` gives clean paragraphs with blank lines between blocks.

## TypeScript

```ts
import { JSDOM } from 'jsdom';
import { Readability, isProbablyReaderable } from '@mozilla/readability';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';   // ships no types: add `declare module 'turndown-plugin-gfm';` in a .d.ts

export function htmlToMarkdown(html: string, url: string): string | null {
  const dom = new JSDOM(html, { url });       // the URL lets Readability absolutize links
  const doc = dom.window.document;
  if (!isProbablyReaderable(doc)) return null;
  const article = new Readability(doc).parse();
  if (!article?.content) return null;
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.use(gfm);                                // GFM tables and strikethrough
  td.remove(['script', 'style']);
  return `# ${article.title}\n\n${td.turndown(article.content)}`;
}
```

Readability's `parse()` also returns `textContent`, `byline`, `excerpt`, `siteName`, `lang` and `publishedTime`. Note that `article.title` often includes the site name (`Rates rise again | Example News`).

## Post-processing

- **Links.** trafilatura (with `url`) and Readability (with a JSDOM `url`) produce absolute links; markdownify and turndown keep `href` as written, so resolve relative URLs in the HTML first. Strip tracking parameters ([URL Normalization and Canonicalization](../crawling/url-normalization.md)).
- **Whitespace.** Collapse three or more blank lines and trailing spaces; apply the cleaning rules in [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md).
- **Tables.** GFM tables cannot express `rowspan`, `colspan` or block content in cells. Keep complex tables as HTML, or extract them as data ([Extracting HTML Tables](html-tables.md)).
- **Escaping.** markdownify escapes `_` and `*` by default (`snake\_case`), which is correct Markdown but noisy for prompts; tune `escape_underscores` and `escape_asterisks` per use.
- **Images.** Keep alt text if it carries meaning, otherwise strip images.

## Quality gates

```python
def looks_extracted(md: str | None, html: str, min_chars: int = 200) -> bool:
    if not md or len(md) < min_chars:
        return False
    if len(md) / max(len(html), 1) < 0.01:          # almost nothing survived
        return False
    lowered = md.lower()
    boilerplate_hits = sum(p in lowered for p in ("accept cookies", "subscribe to", "sign in", "all rights reserved"))
    return boilerplate_hits < 2
```

Also check the language, the presence of the expected title, and duplicates across pages (the same "article" on many URLs usually means a consent wall or an error page). Track the failure rate per site and alert on jumps ([Data Quality Monitoring](../data-quality/data-quality-monitoring.md)).

## Pitfalls

- **Not every page is an article.** Readability-style extractors are tuned for prose. On product, search or listing pages they drop the data you want or return a fragment.
- **Lost content.** Extractors can drop tables, captions, pull quotes, comments or the second page of a multi-page article. Compare a sample against the rendered page.
- **Consent and error pages.** A cookie wall or "access denied" page converts into perfectly fluent Markdown. Gate on length, title and known phrases.
- **Client-rendered content.** If the article body is injected by JavaScript, extract from the rendered DOM or the underlying JSON ([Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)).
- **Paywalls.** Respect them; extracting hidden paywalled text from the markup is not a neutral parsing choice ([News Sites and RSS](../sources/news-and-rss.md)).
- **Rights.** Converting an article to Markdown does not change its copyright status ([Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)). html2text's GPL license matters if you distribute software that bundles it.

## Checklist

- [ ] Main-content extraction used only on article-like pages; selectors elsewhere.
- [ ] Page URL passed so links are absolute; tracking parameters stripped.
- [ ] Data tables extracted separately or kept as HTML.
- [ ] Output gated on length, title, language and boilerplate phrases.
- [ ] Original HTML stored next to the Markdown, with the tool and version recorded.

## See Also

- [Preparing HTML for LLMs](../llm-scraping/preparing-html-for-llms.md)
- [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)
- [Extracting HTML Tables](html-tables.md)
- [News Sites and RSS](../sources/news-and-rss.md)
- [Scraping Services and Platforms](../tools/scraping-services-and-platforms.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
