---
tags: [scraping, llm-scraping, extraction, cost-tradeoffs]
aliases: [LLM extraction, AI extraction, LLM scraping, AI web scraping]
---

# LLM-Assisted Extraction

> Sources: Arora et al. 2023, Language Models Enable Simple Systems for Generating Structured Views of Heterogeneous Data Lakes (EVAPORATE) (https://arxiv.org/abs/2304.09433); Hao et al. 2011, From One Tree to a Forest: a Unified Solution for Structured Web Data Extraction (SWDE benchmark), SIGIR 2011; Li et al. 2022, MarkupLM: Pre-training of Text and Markup Language for Visually Rich Document Understanding (https://arxiv.org/abs/2110.08518); Anthropic, Structured outputs (https://platform.claude.com/docs/en/build-with-claude/structured-outputs); OpenAI, Structured Outputs guide (https://platform.openai.com/docs/guides/structured-outputs); Crawl4AI documentation, LLM-free extraction strategies (https://github.com/unclecode/crawl4ai/blob/main/docs/md_v2/extraction/no-llm-strategies.md)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Large language models can read a messy page and return the fields you asked for, which makes them excellent for long-tail, heterogeneous sources where writing selectors per site does not pay off. They are also slower, more expensive and less predictable than deterministic extraction, and they can produce values that are not on the page. The working rule for this vault: get data deterministically where you can (official API, embedded JSON, JSON-LD, selectors), use an LLM where it adds real value (variety, semantics, normalization), validate every LLM output against the source, and when a site is high-volume and stable, use the LLM once to write the extractor instead of calling it on every page.

## When an LLM beats selectors, and when it does not

| Situation | Better choice | Why |
|---|---|---|
| Thousands of sites, each with a different layout, few pages each | LLM extraction | Writing and maintaining selectors per site costs more than tokens |
| One site, millions of pages, stable template | Selectors or an API | Deterministic, cheap, fast; an LLM adds cost and error without benefit |
| Data available as JSON-LD, `__NEXT_DATA__` or a JSON API | Parse the JSON | Already structured; see [JSON and Embedded Data](../parsing/json-and-embedded-data.md) |
| Free text that needs interpretation ("open weekdays 9 to 5 except holidays", "hybrid, 2 days on site") | LLM normalization | Semantics, not position |
| Classification or tagging of extracted records | LLM, often a small model | Cheap per record, hard to do with rules |
| Exact figures at scale for finance or compliance | Deterministic extraction plus validation | Hallucination risk is unacceptable without grounding |
| Latency-critical or offline environments | Deterministic | Model calls add seconds and an external dependency |
| Layout changes often, volume is moderate | LLM-generated selectors with repair | Amortizes LLM cost, keeps runs deterministic |

## Four patterns

1. **Direct extraction.** Send cleaned page content plus a JSON Schema, get a record back ([Schema-Guided Extraction](schema-guided-extraction.md)). Simple and flexible; you pay per page.
2. **LLM as fallback.** Run deterministic extraction first; call the model only when validation fails (missing required fields, out-of-range values). Most pages stay cheap.
3. **LLM writes the extractor.** Use the model to propose selectors or a small extraction function from a few sample pages, verify it on held-out pages, then run it without the model ([Using LLMs to Write and Repair Scrapers](llm-generated-scrapers.md)). The EVAPORATE paper reported that synthesizing extraction code instead of processing every document directly cut the tokens the model had to read by about 110 times while keeping or improving quality on its benchmarks. Tools such as Crawl4AI follow the same idea: generate a CSS or XPath schema once with an LLM, then extract without one.
4. **LLM post-processing.** Deterministic extraction returns raw strings; a model normalizes, classifies or links them. Inputs are short, so costs stay low.

## A hybrid extractor

The code below is provider-neutral: `llm.extract()` stands for your adapter around a provider's structured-output feature. Anthropic's Claude API supports this directly through structured outputs (a JSON Schema in `output_config.format`) and strict tool use (`strict: true` on a tool definition); other major providers offer equivalent features.

```python
import json
from pydantic import BaseModel, ValidationError
from selectolax.lexbor import LexborHTMLParser

class Product(BaseModel):
    name: str
    price: float | None
    currency: str | None
    in_stock: bool | None

def from_jsonld(html: str) -> dict | None:
    for node in LexborHTMLParser(html).css('script[type="application/ld+json"]'):
        try:
            data = json.loads(node.text())
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") == "Product":
            offer = data.get("offers") or {}
            offer = offer[0] if isinstance(offer, list) and offer else offer
            return {"name": data.get("name"), "price": offer.get("price"),
                    "currency": offer.get("priceCurrency"),
                    "in_stock": "InStock" in str(offer.get("availability", "")) if offer else None}
    return None

def extract_product(html: str, cleaned_text: str, llm) -> tuple[Product, str]:
    """Return (record, method). Deterministic first, LLM only as a fallback."""
    raw = from_jsonld(html)
    if raw:
        try:
            return Product.model_validate(raw), "jsonld"
        except ValidationError:
            pass
    result = llm.extract(
        schema=Product.model_json_schema(),
        instructions="Extract the main product on this page. Use null for anything not stated. "
                     "Never guess prices.",
        content=cleaned_text,
    )
    return Product.model_validate(result), "llm"
```

Log the method per record so you can measure how often the fallback runs and what it costs.

## Quality: what goes wrong

- **Fabrication:** a plausible price or date that is not on the page, especially when the field is required and the page lacks it. Make fields nullable and say "null if absent".
- **Field confusion:** list price versus sale price, publish date versus update date, the main product versus a recommended one.
- **Locale and unit errors:** "1.299,00" read as 1.299; prices per pack versus per unit.
- **Omissions** on long lists, and **truncation** when output hits the token limit.
- **Instructions inside the page** that change the model's behavior (prompt injection); treat page text strictly as data ([Agentic Browsing](agentic-browsing.md) covers the threat model).

Measure against a labeled sample per source type (precision and recall per field), and run the grounding checks in [Validating LLM Extractions](validating-llm-output.md) on every record. Public benchmarks such as SWDE (structured extraction across many sites) are useful for comparing methods, but your own pages are the test that matters.

## Reproducibility

Pin the model version, prompt version and schema version, and store them with each record together with a hash of the input ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)). Do not rely on a sampling temperature of zero for determinism; outputs can still vary between runs, and several current models no longer accept sampling parameters at all. Cache responses by input hash so a rerun reads the cache instead of producing new, possibly different answers ([Costs and Caching for LLM Scraping](llm-scraping-costs.md)).

## Legal and privacy notes

An LLM does not change the legal analysis of the collection: the site's terms, robots.txt, copyright and data protection rules apply exactly as for any scraper. Sending page content to a hosted model discloses it to a processor, so personal data needs a lawful basis, a data processing agreement and appropriate retention settings. If extracted content will train models, read [AI Crawlers and Content Opt-Outs](ai-crawlers-and-opt-outs.md).

## Pitfalls

- Calling the model on pages that already carry structured data.
- Required, non-nullable schema fields that force the model to invent values.
- Feeding raw HTML: most tokens are markup and scripts ([Preparing HTML for LLMs](preparing-html-for-llms.md)).
- No labeled evaluation set, so quality regressions after a model change go unnoticed.
- Treating "valid JSON" as "correct data".

## Checklist

- [ ] Deterministic routes tried first; LLM use justified per source.
- [ ] Schema with nullable fields and clear descriptions.
- [ ] Input cleaned and token-counted; output validated and grounded.
- [ ] Model, prompt and schema versions recorded with each record.
- [ ] Cost per accepted record measured, not just cost per call.
- [ ] Privacy and terms reviewed for sending content to a model provider.

## See Also

- [Schema-Guided Extraction](schema-guided-extraction.md)
- [Preparing HTML for LLMs](preparing-html-for-llms.md)
- [Validating LLM Extractions](validating-llm-output.md)
- [Costs and Caching for LLM Scraping](llm-scraping-costs.md)
- [Using LLMs to Write and Repair Scrapers](llm-generated-scrapers.md)
- [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)
