---
tags: [scraping, llm-scraping, cost, prompt-caching, batching]
aliases: [LLM token costs, prompt caching, batch API costs, LLM extraction cost]
---

# Costs and Caching for LLM Scraping

> Sources: Anthropic, Pricing (https://platform.claude.com/docs/en/about-claude/pricing); Anthropic, Prompt caching (https://platform.claude.com/docs/en/build-with-claude/prompt-caching); Anthropic, Batch processing (https://platform.claude.com/docs/en/build-with-claude/batch-processing); Anthropic, Token counting (https://platform.claude.com/docs/en/build-with-claude/token-counting); OpenAI, Batch API guide (https://platform.openai.com/docs/guides/batch); OpenAI, Prompt caching guide (https://platform.openai.com/docs/guides/prompt-caching); Arora et al. 2023, EVAPORATE (https://arxiv.org/abs/2304.09433)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

LLM extraction cost is simple arithmetic: tokens in times the input price, plus tokens out times the output price, plus caching and retry effects, times the number of pages. What makes it expensive is volume multiplied by careless inputs. The levers, roughly in order of impact: do not call the model at all (deterministic extraction, skip unchanged pages, cache responses), shrink the input (clean HTML, main content only), pick the cheapest model that passes your evaluation, cache the static prompt prefix, use batch processing for anything not urgent, and compile repeated work into selectors. Measure cost per accepted record, including retries and review, not cost per call.

## The formula

```text
cost_per_page = (uncached_input * p_in + cached_input * p_in * read_mult
                 + cache_write_tokens * p_in * write_mult + output * p_out) / 1,000,000
total = pages * cost_per_page * (1 + retry_rate) + review_cost
```

Prices are per million tokens. Count tokens with the provider's tokenizer or counting endpoint (the Claude API has `POST /v1/messages/count_tokens`); character-based estimates are fine for planning only.

## Reference prices (as of 2026-10)

Anthropic's published list prices per million tokens: Claude Haiku 5.5 at $0.10 input and $0.50 output (for prompts up to 100K tokens; $0.50 and $2.50 beyond), Claude Sonnet 5.5 at $2 and $10, Claude Opus 5.5 at $4 and $20. Prompt caching bills cache reads at about 0.1 times the base input price on most models (Claude Opus 5.5 reads are $0.20 per million, 0.05 times), cache writes at 1.25 times for the default 5-minute lifetime or 2 times for the 1-hour option, and the cache prefix must reach a model-dependent minimum length (512 tokens on the newest models, up to 4,096 on some older ones) or it silently does not cache. The Message Batches API charges 50% of standard prices, accepts up to 100,000 requests or 256 MB per batch, usually finishes within an hour and always within 24 hours. Other providers have comparable tiers, batch discounts and caching (some cache automatically); always check the live pricing page.

## Worked example

100,000 product pages; raw HTML around 30,000 tokens per page, cleaned Markdown around 3,000; a static prefix (instructions, schema, two examples) of 2,000 tokens; 300 output tokens per page. Mid-tier prices of $2 input and $10 output per million tokens, cache reads at 0.1 times:

| Setup | Input cost | Output cost | Total |
|---|---|---|---|
| Raw HTML, no caching | 3,200M tokens x $2 = $6,400 | 30M x $10 = $300 | about $6,700 |
| Cleaned Markdown | 500M x $2 = $1,000 | $300 | about $1,300 |
| Cleaned, prefix cached | 300M x $2 + 200M x $0.20 = $640 | $300 | about $940 |
| Cleaned, cached, batch (50%) | | | about $470, if your provider combines the discounts |
| Same, on a $0.10 / $0.50 small model | | | under $50 |
| Selectors generated once by the LLM | a few dollars of generation and repairs | | near zero per page |

Cleaning alone saved about 80% here, which is why [Preparing HTML for LLMs](preparing-html-for-llms.md) comes before any pricing decision. The last row is the EVAPORATE result in practice: synthesizing extraction code instead of reading every document cut the tokens processed by about 110 times in that paper ([Using LLMs to Write and Repair Scrapers](llm-generated-scrapers.md)).

## Caching at three levels

1. **Fetch level.** Conditional requests and content hashes mean an unchanged page never reaches the model ([HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md), [Incremental Crawling](../crawling/incremental-crawling.md)). On recrawls this is usually the biggest saving of all.
2. **Response level.** Key a response cache on model id, prompt version, schema version and a hash of the cleaned content. Reruns and backfills read the cache, and results stay reproducible.
3. **Prompt prefix level.** Put the stable part (instructions, schema, examples) first and the page last, mark the prefix as cacheable where the provider needs it, and verify hits in the usage fields of the response (on the Claude API, `cache_read_input_tokens`). Anything that changes the prefix (a timestamp, a reordered schema) silently invalidates it. Caches are scoped per model, so a cascade across models does not share them.

```python
import hashlib
import json
import sqlite3

class CachedExtractor:
    """Response cache around a provider-neutral llm.extract()."""
    def __init__(self, llm, model: str, prompt_version: str, schema_version: str, path: str = "llm_cache.sqlite"):
        self.llm, self.key_parts = llm, (model, prompt_version, schema_version)
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT)")

    def extract(self, schema: dict, instructions: str, content: str) -> dict:
        key = hashlib.sha256(json.dumps([*self.key_parts, schema, instructions, content],
                                        sort_keys=True).encode()).hexdigest()
        row = self.db.execute("SELECT v FROM cache WHERE k = ?", (key,)).fetchone()
        if row:
            return json.loads(row[0])
        result = self.llm.extract(schema=schema, instructions=instructions, content=content)
        self.db.execute("INSERT OR REPLACE INTO cache VALUES (?, ?)", (key, json.dumps(result)))
        self.db.commit()
        return result

def page_cost(in_tokens: int, out_tokens: int, p_in: float, p_out: float,
              cached_tokens: int = 0, read_mult: float = 0.1) -> float:
    """USD per page, ignoring cache writes (amortized when traffic keeps the cache warm)."""
    return ((in_tokens - cached_tokens) * p_in + cached_tokens * p_in * read_mult
            + out_tokens * p_out) / 1_000_000

print(round(page_cost(5_000, 300, 2.0, 10.0, cached_tokens=2_000) * 100_000, 2))   # 940.0
```

## Choosing the model

Start with the cheapest model and a labeled evaluation set; move up only where accuracy falls short. A cascade (small model first, escalate when validation fails) can be cheaper than one large model, but measure it: escalations cost two calls, and a capable model at a lower reasoning or effort setting is sometimes cheaper per accepted record than a cascade. Output tokens cost several times more than input tokens, so keep outputs lean: only the fields you need, short evidence quotes, no prose.

## Throughput and budgets

Rate limits are usually expressed in requests and tokens per minute; schedule large backfills as batches and keep interactive capacity for repairs. Set a token budget per run and per source, log the usage fields of every response, and alert when cost per accepted record drifts ([Cost Control](../operations/cost-control.md), [Logging and Observability](../operations/logging-and-observability.md)). Include the other costs in the comparison: headless browsers, bandwidth, storage of raw pages, and human review time.

## Pitfalls

- Sending raw HTML; most tokens are markup.
- A timestamp or request id at the start of the prompt, which defeats prefix caching.
- Prefixes below the minimum cacheable length, which cache nothing without any error.
- Paying for urgent processing of backfills that could run as a batch.
- Ignoring retries and validation failures in cost estimates.
- Re-extracting pages that did not change.

## Checklist

- [ ] Deterministic extraction and unchanged-page skipping before any model call.
- [ ] Inputs cleaned and token-counted; outputs limited to needed fields.
- [ ] Response cache keyed by model, prompt, schema and content hash.
- [ ] Static prefix first, cacheable, and verified through usage fields.
- [ ] Batch processing for non-urgent work.
- [ ] Model choice backed by an evaluation; cost per accepted record tracked.
- [ ] Per-run budgets and alerts configured.

## See Also

- [Cost Control](../operations/cost-control.md)
- [Preparing HTML for LLMs](preparing-html-for-llms.md)
- [LLM-Assisted Extraction](llm-assisted-extraction.md)
- [Incremental Crawling](../crawling/incremental-crawling.md)
- [HTTP Caching and Conditional Requests](../http/caching-and-conditional-requests.md)
- [Using LLMs to Write and Repair Scrapers](llm-generated-scrapers.md)
