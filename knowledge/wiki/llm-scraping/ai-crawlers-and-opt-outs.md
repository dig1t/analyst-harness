---
tags: [scraping, llm-scraping, robots-txt, ai-crawlers, tdm-opt-out]
aliases: [GPTBot, ClaudeBot, CCBot, Google-Extended, AI user agents, TDMRep, llms.txt, AI opt-out]
---

# AI Crawlers and Content Opt-Outs

> Sources: RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); OpenAI, Overview of OpenAI crawlers (https://platform.openai.com/docs/bots); Anthropic, Does Anthropic crawl data from the web, and how can site owners block the crawler? (https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler); Google, Overview of Google crawlers and fetchers (https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers); Apple, About Applebot (https://support.apple.com/en-us/119829); Common Crawl, CCBot (https://commoncrawl.org/ccbot); W3C TDM Reservation Protocol, Community Group Final Report 2024-02-02 (https://www.w3.org/community/reports/tdmrep/CG-FINAL-tdmrep-20240202/); IETF AI Preferences Working Group drafts (https://datatracker.ietf.org/group/aipref/documents/); The /llms.txt file proposal (https://llmstxt.org/); ai.robots.txt community registry (https://github.com/ai-robots-txt/ai.robots.txt); Directive (EU) 2019/790, Article 4 (https://eur-lex.europa.eu/eli/dir/2019/790/oj); Regulation (EU) 2024/1689 (AI Act), Article 53 (https://eur-lex.europa.eu/eli/reg/2024/1689/oj)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

AI companies run three kinds of web clients: training crawlers that collect content for model training, search crawlers that index pages for AI-assisted search, and user-triggered fetchers that load a page because a person asked an assistant about it. Each announces a user-agent token, and robots.txt groups for those tokens are the main way site owners opt out. Other signals exist alongside it: the TDM Reservation Protocol for the EU text-and-data-mining opt-out, the IETF's draft `Content-Usage` preferences, and CDN-level controls. `llms.txt` is different: it is a guide for agents, not a permission or an opt-out. For this harness the rules are simple: identify your own crawler honestly, read and record these signals, honor them when your use is AI training or dataset building, and never impersonate another crawler.

## User-agent tokens (as of 2026-10)

| Operator | Token | Role | Notes |
|---|---|---|---|
| OpenAI | `GPTBot` | Training crawler | Honors robots.txt; OpenAI publishes its IP ranges |
| OpenAI | `OAI-SearchBot` | Search indexing for ChatGPT search | Separate from GPTBot, so sites can allow search and block training |
| OpenAI | `ChatGPT-User` | User-triggered fetches | Check OpenAI's page for how robots.txt applies to user-initiated requests |
| Anthropic | `ClaudeBot` | Training crawler | Anthropic states its bots honor robots.txt |
| Anthropic | `Claude-User` | User-triggered fetches | |
| Anthropic | `Claude-SearchBot` | Search quality and indexing | Older tokens such as `anthropic-ai` still appear in many blocklists |
| Google | `Google-Extended` | robots.txt control token, no separate crawler | Controls use of Google-crawled content for Gemini and Vertex AI training and grounding; no effect on Search inclusion or ranking, so it is not a switch for AI features inside Search |
| Google | `Google-CloudVertexBot`, `GoogleOther` | Site-owner requested crawls for Vertex AI agents; one-off research and product crawls | |
| Apple | `Applebot-Extended` | Control token | Governs use of content crawled by `Applebot` for training Apple's foundation models |
| Common Crawl | `CCBot` | Open web corpus | Honors robots.txt; the corpus is widely used for AI training |
| Perplexity | `PerplexityBot`, `Perplexity-User` | Index; user-triggered fetches | Perplexity documents that its user-triggered fetcher generally does not follow robots.txt |
| Meta | `Meta-ExternalAgent`, `Meta-ExternalFetcher` | Training and indexing; user-triggered fetches | The fetcher may bypass robots.txt per Meta's crawler documentation |
| Others | `Amazonbot`, `Bytespider`, `DuckAssistBot`, `MistralAI-User`, `cohere-ai` | Various | The registry reports that Bytespider does not honor robots.txt |

The list changes several times a year. The community-maintained ai.robots.txt registry tracks tokens, operators and whether each respects robots.txt; treat the operators' own pages as authoritative.

## robots.txt for AI tokens

```text
# Allow search indexing, refuse training crawlers
User-agent: GPTBot
User-agent: ClaudeBot
User-agent: CCBot
User-agent: Google-Extended
User-agent: Applebot-Extended
Disallow: /

User-agent: *
Allow: /
```

Under RFC 9309 a crawler obeys the group that matches its product token (or `*` when none matches), the most specific (longest) matching rule wins, crawlers should parse at least 500 KiB, and they may cache robots.txt for up to 24 hours. A 4xx response for robots.txt means no restrictions; a 5xx response means assume full disallow. robots.txt is a voluntary convention, not access control: tokens can be spoofed, so operators that care verify bots with published IP ranges or reverse DNS ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)). Details are in [robots.txt (RFC 9309)](../crawling/robots-txt.md).

## Other machine-readable signals

- **TDM Reservation Protocol (TDMRep).** A W3C Community Group final report (February 2024) built for the opt-out in Article 4 of the EU DSM Directive. A server expresses `tdm-reservation: 1` (rights reserved) and optionally a `tdm-policy` URL describing how to get a license, in three ways: a `/.well-known/tdmrep.json` file with path-pattern rules, HTTP response headers, or HTML `<meta name="tdm-reservation" content="1">` and `<meta name="tdm-policy" ...>` elements. Common among European publishers.
- **IETF AI Preferences (AIPREF), draft.** The working group is defining a vocabulary of usage categories, currently `train-ai`, `ai-use` and `search` (the vocabulary section was still marked as lacking consensus as of 2026-10), and ways to attach preferences through a `Content-Usage` HTTP header and a `Content-Usage` rule in robots.txt, for example `Content-Usage: train-ai=n`. Not final; read it as an advisory signal and track the drafts.
- **CDN and vendor signals.** CDNs offer managed AI-crawler blocking and managed robots.txt files; Cloudflare, for example, introduced default blocking of AI crawlers for new domains in 2025 and a `Content-Signal` robots.txt extension (`search`, `ai-input`, `ai-train`). Licensing proposals such as RSL (Really Simple Licensing) attach machine-readable license terms. Non-standard meta tags such as `noai` also appear in the wild. See [WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md).
- **llms.txt.** A proposal by Jeremy Howard (2024, revised as v2 in 2026) for a Markdown file at `/llms.txt` (or at a subpath) with an H1 title, a blockquote summary and sections of links to LLM-friendly content, plus `.md` versions of pages advertised with `rel="alternate" type="text/markdown"` links or `Link` headers. It helps agents find clean content; it grants no rights and does not override robots.txt or terms.

## Legal context

In the EU, Article 4 of Directive 2019/790 allows text and data mining of lawfully accessible content unless the rightholder has reserved the right "in an appropriate manner, such as machine-readable means"; Article 3 gives research organizations a separate exception that cannot be opted out of. The AI Act (Article 53) requires providers of general-purpose AI models to have a copyright policy that identifies and complies with those reservations, including through state-of-the-art technologies, and the 2025 General-Purpose AI Code of Practice commits signatories to crawlers that follow robots.txt and other appropriate machine-readable protocols. Outside the EU the questions are being litigated under fair use and similar doctrines. These signals do not replace terms of service, copyright or data protection analysis; see [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md).

## What the harness does

1. Fetch and cache robots.txt per host; evaluate it for your own product token and for `*` with an RFC 9309 compliant parser. Python's built-in `urllib.robotparser` long used first-match logic without wildcard support, and recent CPython releases implement longest-match and wildcards, so its behavior depends on the interpreter version; a pinned dedicated parser such as Protego gives consistent results.
2. When the purpose is model training or dataset building, also honor refusals aimed at AI training tokens (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`, `Applebot-Extended`), TDMRep reservations and `Content-Usage: train-ai=n`, because they express the site owner's preference about exactly that use.
3. Record the signals you saw, with timestamps, in provenance metadata ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).
4. Use your own honest User-Agent with contact details. Never claim to be Googlebot, GPTBot or any other crawler.

```python
import urllib.robotparser
from urllib.parse import urlparse
import httpx
from bs4 import BeautifulSoup

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot@example.org)"
TRAINING_TOKENS = ["GPTBot", "ClaudeBot", "CCBot", "Google-Extended", "Applebot-Extended"]

def ai_signals(url: str, my_token: str = "ExampleResearchBot") -> dict:
    origin = "{0.scheme}://{0.netloc}".format(urlparse(url))
    with httpx.Client(headers={"User-Agent": UA}, timeout=20, follow_redirects=True) as client:
        robots = client.get(origin + "/robots.txt")
        lines = robots.text.splitlines() if robots.status_code == 200 else []
        if robots.status_code >= 500:
            lines = ["User-agent: *", "Disallow: /"]          # RFC 9309: unreachable means disallow
        rp = urllib.robotparser.RobotFileParser()
        rp.parse(lines)                                      # matching varies by Python version; see step 1
        tdm_file = client.get(origin + "/.well-known/tdmrep.json")
        page = client.get(url)
    meta = BeautifulSoup(page.text, "lxml").find("meta", attrs={"name": "tdm-reservation"})
    return {
        "allowed_for_me": rp.can_fetch(my_token, url),
        "training_tokens_refused": [t for t in TRAINING_TOKENS if not rp.can_fetch(t, url)],
        "content_usage_rules": [l.strip() for l in lines if l.lower().startswith(("content-usage:", "content-signal:"))],
        "tdmrep_rules": tdm_file.json() if tdm_file.status_code == 200 else None,
        "tdm_reservation_header": page.headers.get("tdm-reservation"),
        "tdm_reservation_meta": meta.get("content") if meta else None,
        "content_usage_header": page.headers.get("content-usage"),
    }
```

## Pitfalls

- Treating `llms.txt` as permission to collect.
- Assuming that allowing `*` means a site welcomes AI training when it refuses the AI-specific tokens.
- Trusting whatever robots.txt parser ships with the runtime without testing it on wildcard and longest-match cases (Python's `urllib.robotparser` changed its matching between versions).
- Caching robots.txt for days; re-fetch at least daily.
- Spoofing a well-known crawler to get past an AI block; that is deception and invites legal and technical consequences.
- Forgetting that a CDN block is a clear "no", not a technical puzzle ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)).

## Checklist

- [ ] Own crawler token documented; honest User-Agent with contact details.
- [ ] robots.txt evaluated with an RFC 9309 compliant parser and cached for at most 24 hours.
- [ ] For training or dataset use: AI-token refusals, TDMRep and Content-Usage signals honored.
- [ ] Signals stored in provenance with timestamps.
- [ ] No impersonation of other crawlers; blocks respected.

## See Also

- [robots.txt (RFC 9309)](../crawling/robots-txt.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [WAFs and CDN Bot Management](../anti-bot/waf-and-cdn-bot-management.md)
- [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)
- [Agentic Browsing](agentic-browsing.md)
