---
tags: [scraping, llm-scraping, hallucination, grounding, data-quality]
aliases: [hallucination checks, grounding checks, LLM output validation, extraction audits]
---

# Validating LLM Extractions

> Sources: Manakul et al. 2023, SelfCheckGPT: Zero-Resource Black-Box Hallucination Detection for Generative Large Language Models (https://arxiv.org/abs/2303.08896); Huang et al. 2023, A Survey on Hallucination in Large Language Models (https://arxiv.org/abs/2311.05232); Min et al. 2023, FActScore (https://arxiv.org/abs/2305.14251); OWASP GenAI Security Project, LLM Top 10 2026 (https://genai.owasp.org/resource/owasp-genai-llm-top-10-2026/); Anthropic, Citations (https://platform.claude.com/docs/en/build-with-claude/citations); Anthropic, Structured outputs (https://platform.claude.com/docs/en/build-with-claude/structured-outputs); Pydantic documentation (https://docs.pydantic.dev/); RapidFuzz documentation (https://rapidfuzz.github.io/RapidFuzz/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

An LLM extraction can be perfectly valid JSON and still wrong: a price that is not on the page, the list price instead of the sale price, a date from a "related articles" box, a list with three items silently missing. Structured outputs guarantee shape, not truth. Validate in layers: schema and types, normalization, grounding against the source text, cross-field and business rules, comparison with independent signals, statistical monitoring, and human sampling audits that produce real accuracy numbers. Every check needs a defined outcome (accept, retry, escalate, null out, or send to review), and every record carries the provenance needed to reproduce it.

## What goes wrong

| Error | Example | Best detector |
|---|---|---|
| Fabrication | Price or author invented for a page that has none | Grounding check, nullable fields |
| Wrong field | Crossed-out list price returned as current price | Evidence quotes, rules (sale at most list) |
| Wrong entity | Values from a recommended product or sidebar | Evidence location, DOM node ids |
| Locale or unit error | "1.299,00" parsed as 1.299; per-pack versus per-unit | Number grounding, range checks |
| Omission | 18 of 20 list items returned | Count against DOM containers |
| Stale or merged data | Two records merged into one | Key uniqueness, cross-source checks |
| Truncation | Output cut off at the token limit | Stop-reason check |
| Injected behavior | Page text steering the output | Grounding, anomaly checks ([Agentic Browsing](agentic-browsing.md)) |

## Layer 1: structure

Validate every response against the schema with your own validator (Pydantic, zod or JSON Schema), even when the provider enforced it, because providers support only part of JSON Schema: on the Claude API, for example, numeric bounds and string length limits are not enforced by structured outputs and must be checked client-side. Check the stop reason too; a response that stopped at the output limit or with a refusal should not be stored. See [Schema Validation](../data-quality/schema-validation.md).

## Layer 2: grounding against the source

Ask for an evidence quote per important field ([Schema-Guided Extraction](schema-guided-extraction.md)), then verify mechanically:

1. The quote occurs in the cleaned page text, exactly after normalization or above a fuzzy-match threshold.
2. The value is derivable from the quote: the number parses to the same value under some plausible locale, the date normalizes to the same day, the enum matches the wording.
3. For lists, the number of extracted items matches the number of item containers in the DOM.

Some providers offer citation features that point to source passages (the Claude API has citations for documents), but on the Claude API citations cannot be combined with JSON structured outputs, so a quote field plus your own check is the portable approach.

```python
import re
import unicodedata
from rapidfuzz import fuzz

def norm(text: str) -> str:
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", text)).strip().lower()

def quote_found(quote: str, source: str, threshold: float = 90.0) -> bool:
    q, s = norm(quote), norm(source)
    return q in s or fuzz.partial_ratio(q, s) >= threshold

NUM = re.compile(r"\d[\d.,  ]*")

def readings(token: str) -> set[float]:
    """Interpret '1.299,00' or '1,299.00' both ways; return all plausible values."""
    t = token.replace(" ", "").replace(" ", "").rstrip(".,")
    out = set()
    for dec, thou in ((".", ","), (",", ".")):
        s = t.replace(thou, "")
        if s.count(dec) <= 1:
            try:
                out.add(float(s.replace(dec, ".")))
            except ValueError:
                pass
    return out

def number_grounded(value: float, evidence: str, rel_tol: float = 0.005) -> bool:
    return any(abs(c - value) <= rel_tol * max(1.0, abs(value))
               for tok in NUM.findall(evidence) for c in readings(tok))

def check_record(rec: dict, page_text: str) -> list[str]:
    problems = []
    if rec.get("price") is not None:
        ev = rec.get("price_evidence") or ""
        if not ev.strip() or not quote_found(ev, page_text):
            problems.append("price_evidence not found on page")
        elif not number_grounded(rec["price"], ev):
            problems.append("price does not match its evidence")
    if rec.get("list_price") is not None and rec.get("price") is not None and rec["price"] > rec["list_price"]:
        problems.append("price above list_price")
    return problems
```

Ungrounded values should become `null` with a flag or go to review; they should never be stored as if confirmed.

## Layer 3: rules and consistency

Domain rules catch what grounding cannot: currency consistent with the site's locale, dates not in the future (unless they are deadlines), ratings within the scale, totals equal to the sum of parts, one main entity per page. Keep rules in code next to the schema and version them together.

## Layer 4: independent signals

- **Deterministic overlap.** Where JSON-LD or an API also provides a field, compare; disagreement rates are a cheap accuracy estimate.
- **Self-consistency.** SelfCheckGPT (Manakul et al., 2023) showed that disagreement between multiple sampled answers signals hallucination. For extraction, run a second model or a second prompt on a sample and treat disagreements as review candidates.
- **History.** Compare with the previous observation of the same entity; a tenfold price jump is more likely an error than a sale ([Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).

## Layer 5: monitoring

Track per source and field: null rate, ungrounded rate, rule-failure rate, fallback rate, agreement with deterministic overlap, and value distributions. Alert on shifts, and rerun a fixed golden set before changing model, prompt or schema; model updates change behavior even when the API looks the same ([Data Quality Monitoring](../data-quality/data-quality-monitoring.md)).

## Sampling audits

Automated checks bound the error rate; only human labels measure it. Draw a stratified random sample (by source, page type and extraction method), label the true values, and compute per-field precision (correct among extracted values), recall (correct among values present on the page) and accuracy. Sample size for estimating a rate within plus or minus 5 percentage points at 95% confidence, worst case: n = 1.96^2 x 0.25 / 0.05^2, about 385 records per stratum you want to report separately. Audit high-risk fields more often, keep the audit log, and feed every error case into the regression fixtures ([Testing Scrapers](../data-quality/testing-scrapers.md)).

## Provenance

Store with each record: model id, prompt version, schema version, input content hash, raw response, evidence quotes, check results and the final status ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)). Without them you cannot explain a bad value or reprocess only what a fix affects.

## Pitfalls

- Treating schema-valid output as verified output.
- Fuzzy thresholds so loose that boilerplate text "grounds" anything.
- Grounding against raw HTML instead of the text the model actually saw (or the reverse).
- Silent auto-corrections that hide model errors from metrics.
- Audits that sample only easy pages.
- Changing models without rerunning the golden set.

## Checklist

- [ ] Own validator runs on every response; stop reasons checked.
- [ ] Evidence quotes required and verified for important fields.
- [ ] Domain rules versioned with the schema.
- [ ] Deterministic overlap and history comparisons in place.
- [ ] Field-level monitoring with alerts; golden set rerun on every change.
- [ ] Regular stratified human audits with reported precision and recall.
- [ ] Full provenance stored per record.

## See Also

- [Schema Validation](../data-quality/schema-validation.md)
- [Data Quality Monitoring](../data-quality/data-quality-monitoring.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Testing Scrapers](../data-quality/testing-scrapers.md)
- [Schema-Guided Extraction](schema-guided-extraction.md)
- [LLM-Assisted Extraction](llm-assisted-extraction.md)
