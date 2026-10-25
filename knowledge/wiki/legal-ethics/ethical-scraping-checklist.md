---
tags: [scraping, legal-ethics, ethics, checklist]
aliases: [Scraping ethics, Pre-flight checklist, Responsible scraping]
---

# Ethical Scraping Checklist

> Sources: RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); Association of Internet Researchers, Internet Research: Ethical Guidelines 3.0 (https://aoir.org/reports/ethics3.pdf); ICO and eleven authorities, joint statement on data scraping (https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2023/08/joint-statement-on-data-scraping-and-data-protection/); OPC Canada, concluding joint statement on data scraping (https://www.priv.gc.ca/en/opc-news/news-and-announcements/2024/nr-c_241028/); Reed Smith on EDPB Guidelines 03/2026 (https://www.reedsmith.com/our-insights/blogs/technology-law-dispatch/102nbqu/edpb-web-scraping-guidelines-for-ai-making-the-impossible-possible/); EFF on Sandvig v. Barr (https://www.eff.org/deeplinks/2020/04/federal-judge-rules-it-not-crime-violate-websites-terms-service)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Legal is the floor, not the goal. A scraper can be lawful and still overload a small site, surprise the people whose posts it collects, or undercut the publisher it depends on. This page is the pre-flight checklist agents and humans run **before writing code, before scheduling a job, and whenever scope changes** (new source, new fields, logged-in access, personal data, publication, AI training, resale). It follows the vault's stance: be polite, be identifiable, ask for access, prefer official channels, and treat any defense or refusal as a signal to stop rather than a puzzle to solve. It is not legal advice; the legal reasoning is in [Legal Landscape Overview](legal-landscape-overview.md).

## Ten principles

1. **Ask whether you should.** State the purpose and who benefits. Research ethics frameworks such as the AoIR guidelines ask researchers to weigh harms to the people in the data, not only the legality of collection.
2. **Use the front door first.** Official API, bulk download, data dump, feed, license or a polite email asking for access ([Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
3. **Be a good guest.** Honour robots.txt (RFC 9309), throttle per host, back off on errors, cache and use conditional requests, avoid peak hours.
4. **Be identifiable.** An honest User-Agent with a contact URL or email, and a way for site owners to reach a human.
5. **Respect "no".** A disallow rule, an opt-out, a block, a CAPTCHA or a cease-and-desist means stop and escalate. Never rotate IPs, fake identities or solve challenges to get around it.
6. **Collect the minimum.** Fields you need for the stated purpose, and nothing about people that you cannot justify.
7. **Respect creators.** Take facts rather than expression, keep attribution and license terms, honour TDM and AI opt-outs.
8. **Protect the people in the data.** No profiling of individuals, no re-identification, no sensitive categories without a strong, documented basis, no publishing personal data.
9. **Be accountable.** Record what you fetched, when, under which terms and robots.txt decision, and why.
10. **Clean up.** Retention limits, deletion on request and on schedule, access control for raw captures.

## Red lines

Do not do these, whatever the business case:

- Defeat access controls: logins you are not entitled to, paywalls, CAPTCHAs, JavaScript challenges or other bot defenses.
- Create fake, purchased or borrowed accounts to collect data.
- Use residential or mobile proxy networks to evade a site that has blocked you.
- Continue after a cease-and-desist letter, an explicit block or a direct request to stop.
- Collect special-category data (health, sexuality, religion, politics, biometrics) or data about children at scale.
- De-anonymize people or link pseudonymous accounts to real identities.
- Run at a load that degrades the site for its users.

## Situations and responses

| Situation | Ethical response |
|---|---|
| robots.txt disallows your path | Do not fetch it; look for an API or ask the owner |
| 429 or 503 responses increase | Back off exponentially, lower concurrency, check Retry-After |
| A CAPTCHA or challenge page appears | Stop the job, alert a human, consider asking for access |
| A cease-and-desist or email asks you to stop | Stop immediately, preserve logs, escalate to counsel |
| The data includes personal information you did not plan for | Pause, drop or quarantine the fields, update the assessment |
| The site offers a paid API or license | Price it before building a scraper |
| You want to publish the dataset | Re-review copyright, personal data and the source's terms |
| You want to train a model on it | Check TDM and AI opt-outs and the data protection basis again |

## Example review record

Store a short review with each scraper spec so agents can check it before running. An illustrative shape:

```yaml
ethics_review:
  purpose: "Weekly price index for 40 public product pages"
  alternatives_checked: [official_api, data_license]   # and why they were not used
  robots_txt: {checked_at: "2026-10-24T08:00:00Z", allowed: true}
  terms_snapshot_sha256: "<hash of terms page>"
  login_required: false
  personal_data: none            # or: list of fields + lawful basis reference
  rate_limit: "1 request / 5 s per host, off-peak"
  user_agent: "AcmePriceBot/1.2 (+https://acme.example/bot; bot@acme.example)"
  stop_conditions: [captcha, block_page, cease_and_desist, robots_disallow]
  retention: {raw_days: 30, processed_days: 365}
  reviewed_by: "human:analyst-lead"
  next_review: "2027-04-24"
```

## When things change

Re-run the checklist when the site changes its terms or robots.txt, when you add a source or fields, when you move from internal use to publication or resale, when an AI or machine-learning use is proposed, and when you receive any complaint. Regulators expect ongoing review: the 2024 concluding joint statement by data protection authorities asked organizations to keep their safeguards under regular review, and the EDPB's 2026 draft guidelines ask AI developers to exclude websites that object to scraping.

## Pitfalls

- **Running the checklist once.** Scope creep is how ethical projects become problems.
- **Treating robots.txt as optional** because it is not a statute in your country.
- **Hiding the bot** with a browser User-Agent to avoid blocks.
- **"Research" as a magic word.** Sandvig v. Barr kept researchers out of criminal trouble, not out of contract or ethics review.
- **Forgetting the downstream user.** A dataset you share can be used for profiling you would never do.

## Checklist

**Purpose and alternatives**
- [ ] Purpose, beneficiaries and possible harms written down.
- [ ] Official API, bulk data, feed, license and permission request considered first.

**Access**
- [ ] Pages reachable logged off; no accounts created for scraping.
- [ ] robots.txt fetched, parsed and honoured for every host.
- [ ] Terms of service read and snapshotted; no clause forbids the planned use, or permission obtained.
- [ ] No circumvention of CAPTCHAs, challenges, paywalls or blocks anywhere in the code.

**Load and identity**
- [ ] Per-host rate limit, concurrency cap and backoff configured.
- [ ] Honest User-Agent with contact details.
- [ ] Caching and conditional requests enabled where possible.

**Data**
- [ ] Field allowlist defined; personal data minimized or excluded.
- [ ] Sensitive categories and children's data excluded.
- [ ] Copyrighted expression not stored or republished beyond need; licenses recorded.
- [ ] Retention and deletion schedule set; raw captures access-controlled.

**Operations and accountability**
- [ ] Automatic stop on block pages, CAPTCHAs, repeated 403 or 429, and robots.txt changes.
- [ ] Provenance recorded per record (URL, time, parser, terms and robots.txt snapshot).
- [ ] Contact route and complaint handling defined; a named human owner.
- [ ] Review date set; re-review triggered by scope changes.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [Personal Data: GDPR, CCPA and More](personal-data-gdpr-ccpa.md)
- [robots.txt (RFC 9309)](../crawling/robots-txt.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Identifying Your Bot](../anti-bot/identifying-your-bot.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
