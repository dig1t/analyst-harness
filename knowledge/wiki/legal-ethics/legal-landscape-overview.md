---
tags: [scraping, legal-ethics, law, risk-assessment]
aliases: [Is web scraping legal, Scraping law, Legal risk of scraping]
---

# Legal Landscape Overview

> Sources: Van Buren v. United States, 593 U.S. 374 (2021) (https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf); Proskauer, hiQ and LinkedIn reach proposed settlement (https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case); Farella Braun + Martel, Meta Platforms v. Bright Data (https://www.fbm.com/technology/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/); Loeb & Loeb, Reddit v. SerpApi (https://www.loeb.com/en/insights/publications/2026/08/reddit-v-serpapi-llc); Regulation (EU) 2016/679, GDPR (https://eur-lex.europa.eu/eli/reg/2016/679/oj); Directive 96/9/EC, Database Directive (https://eur-lex.europa.eu/eli/dir/1996/9/oj); Directive (EU) 2019/790, DSM Directive (https://eur-lex.europa.eu/eli/dir/2019/790/oj); Reed Smith, EDPB web scraping guidelines for AI (https://www.reedsmith.com/our-insights/blogs/technology-law-dispatch/102nbqu/edpb-web-scraping-guidelines-for-ai-making-the-impossible-possible/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** This article is a map for engineers and agents doing first-pass risk triage. It is not a substitute for advice from a lawyer licensed in the relevant jurisdiction, and the law here moves fast: check the current status of any case before relying on it.

There is no single "scraping law". Liability comes from a stack of independent theories, and each one looks at a different part of the same project: how you get in (computer misuse law), what you agreed to (contract), how hard you hit the servers (trespass), what you copy (copyright, database rights), what defenses you bypass (anti-circumvention), whose personal data you collect (data protection) and what you do with the result (unfair competition, publication, AI training). Since 2021, US courts have narrowed computer-crime theories for public pages (Van Buren, hiQ v. LinkedIn). Meanwhile contract claims, anti-circumvention claims over bot defenses, copyright disputes about AI training and European data protection enforcement have become the main sources of risk.

## The main legal theories

| Theory | Typical law | What triggers it | Scraper-relevant examples |
|---|---|---|---|
| Unauthorized access | US CFAA (18 U.S.C. 1030), California Penal Code 502, UK Computer Misuse Act 1990, EU Directive 2013/40/EU | Passing an authentication gate, or continuing after access is revoked | Van Buren (2021), Facebook v. Power Ventures (2016), Craigslist v. 3Taps (2013) |
| Breach of contract | Terms of service, API terms | Accepting terms (sign-up, clickwrap) or using a site with actual notice of them | hiQ v. LinkedIn (2022), Meta v. Bright Data (2024), Southwest v. Kiwi.com (2021) |
| Trespass to chattels | State common law | Use of servers that impairs them | eBay v. Bidder's Edge (2000), Intel v. Hamidi (2003) |
| Copyright | US Copyright Act, EU and UK copyright law | Copying protected expression (text, photos, code), not facts | Feist (1991), Thomson Reuters v. Ross (2025, affirmed 2026) |
| Database right | EU Database Directive, UK database regulations | Extracting a substantial part of a database built with substantial investment | CV-Online Latvia v. Melons (CJEU 2021) |
| Anti-circumvention | DMCA, 17 U.S.C. 1201 | Bypassing a technological measure that controls access to copyrighted works | Google v. SerpApi and Reddit v. SerpApi (2026 rulings) |
| Trade secrets | Federal DTSA, state UTSA statutes | Acquiring a protected compilation by improper means | Compulife v. Newman (11th Cir. 2020, 2024) |
| Data protection | GDPR, UK GDPR, CCPA, PIPEDA, India's DPDP Act and others | Collecting or using personal data, public or not | Clearview AI fines across Europe, Bisnode (Poland) |
| Unfair competition | China's Anti-Unfair Competition Law (Art. 13, 2025), California UCL | Obtaining data held by others through improper means; unlawful or unfair business practices | Reddit v. Anthropic (2026 demurrer ruling) |
| Anti-spam | Australia Spam Act 2003, Part 3 | Harvesting email addresses for commercial messages | Address-harvesting provisions (ss. 20 to 22) |

The details live in the topic articles: [CFAA and Key US Cases](cfaa-and-key-us-cases.md), [Terms of Service and Contracts](terms-of-service-and-contracts.md), [Copyright and Database Rights](copyright-and-database-rights.md), [Personal Data: GDPR, CCPA and More](personal-data-gdpr-ccpa.md) and [International Considerations](international-considerations.md).

## Risk factors that move the needle

1. **Authentication walls.** Logged-off access to pages anyone can view is the lowest-risk access pattern under US computer misuse law after Van Buren's "gates" framing and the Ninth Circuit's 2022 hiQ decision. Logging in changes almost everything: you have usually accepted terms, you are behind a gate, and the account itself becomes evidence. hiQ's use of fake profiles was part of its contract loss, and Power Ventures kept using account access after Facebook revoked permission.
2. **Explicit revocation.** A cease-and-desist letter plus IP blocking made continued access "without authorization" in Power Ventures and Craigslist v. 3Taps. The Ninth Circuit later held that for public pages there is no gate to revoke (hiQ, 2022), but contract and tort claims survive, other courts may differ, and the pending Ryanair v. Booking.com appeal may address revocation for pages behind a free login. Treat any "stop" message as a stop.
3. **Terms-of-service assent.** Clickwrap and sign-up flows usually bind; a footer link usually does not unless you had actual notice (Register.com v. Verio, Southwest v. Kiwi.com). Courts disagree on whether contract claims about copying public content are preempted by copyright law (X Corp. v. Bright Data in 2024 versus Reddit v. Anthropic in 2026).
4. **Circumventing technical measures.** Solving or bypassing CAPTCHAs and JavaScript challenges, rotating IPs around a block or disguising a bot after it was refused turns a contract dispute into statutory exposure: CFAA revocation cases, and DMCA 1201 claims over Google's SearchGuard with statutory damages of $200 to $2,500 per act.
5. **Personal data.** Public availability does not take personal data outside the GDPR or most comparable laws. Regulators in France, Italy, Greece, the Netherlands and the UK pursued Clearview AI for scraping public photos. The CCPA's "publicly available" carve-out is narrower than it sounds.
6. **Copyrighted expression.** Facts (prices, dates, specifications) are free; articles, reviews, photos and code are not. Analyzing is safer than republishing, and training AI models on expression is actively litigated with mixed results.
7. **Server burden.** Heavy crawling supports trespass claims (eBay v. Bidder's Edge) and server-impairment theories (the amended claims allowed in X Corp. v. Bright Data). [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md) is legal risk reduction, not only courtesy.
8. **Competitive substitution.** Taking a database to build a substitute for it weighs against you in database-right (CV-Online), trade-secret (Compulife) and fair-use (Thomson Reuters v. Ross) analysis.
9. **Jurisdiction.** Where you operate, where the servers are and where the people in the data live all matter.

## Lower-risk and higher-risk patterns

| Lower risk | Higher risk |
|---|---|
| Official API or bulk download used within its terms | Scraping a site that offers an API you were refused or rate-limited on |
| Logged-off public pages at a polite rate with an honest User-Agent | Logged-in scraping, fake or purchased accounts, shared credentials |
| Facts and metadata, no personal data | Special-category or biometric data, profiles of individuals |
| Internal analysis and aggregates | Republishing expression, reselling datasets, building a competing substitute |
| Respecting robots.txt, opt-outs and blocks | Continuing after a cease-and-desist, IP block or CAPTCHA |

## Practical risk reduction

- Prefer the front door: official API, bulk download, licensed dataset or written permission ([Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)).
- Stay logged off unless you have a right to the account and its terms allow automated access. Never create fake accounts.
- Respect [robots.txt (RFC 9309)](../crawling/robots-txt.md), rate limits and AI or TDM opt-outs; identify the bot with a contact address ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)).
- On a cease-and-desist, block or challenge page: stop, record what happened and escalate to a human ([Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)). Do not rotate around it.
- Collect facts rather than expression, keep only the fields you need, and keep personal data out unless a documented lawful basis exists.
- Keep provenance (URL, fetch time, terms and robots.txt snapshots) so you can show what you did and honor deletion requests.
- Write down purpose and legal assessment before the first run; review again when scope changes (new source, logged-in access, personal data, AI training, resale).

## Where the law is moving (2024 to 2026)

- **Computer misuse:** public pages are largely settled in the Ninth Circuit; Ryanair v. Booking.com, where the district court read the CFAA to reach pages behind a free login after a cease-and-desist, is on appeal in the Third Circuit.
- **Contract:** terms of service have become platforms' main weapon, and courts split on whether copyright law preempts such claims (X Corp. v. Bright Data, 2024, versus Reddit v. Anthropic, 2026).
- **Anti-circumvention:** in July 2026 one federal court dismissed Google's DMCA claims over SearchGuard (with leave to amend only for copyrighted content) while another let Reddit's similar claims proceed.
- **Copyright and AI:** the Third Circuit rejected fair use for a competing, non-generative tool (Thomson Reuters v. Ross, September 2026); two 2025 district court rulings found training fair use on their records, and one of them (Bartz v. Anthropic) held that building a library from pirated copies was not.
- **EU:** AI Act copyright obligations for general-purpose model providers apply from 2 August 2025, and the EDPB released draft guidelines on web scraping for generative AI for consultation in July 2026.

## Pitfalls

- **"It is public, so it is legal."** Public access answers one question (computer misuse, in some courts) and none of the others.
- **"robots.txt is just etiquette."** It is increasingly a legal signal: a machine-readable TDM reservation under the DSM Directive, a commitment in the EU AI code of practice and a factor in data protection balancing.
- **"I never clicked I agree"** while running logged-in sessions created through a sign-up flow.
- **Treating settlements as law.** hiQ's stipulated liability findings are not precedent, and a district court ruling does not bind other courts.
- **Assuming one jurisdiction.** US-based scrapers have been fined under the GDPR.
- **Assuming fair use.** It is a fact-specific defense decided late and expensively.

## Checklist

- [ ] An API, bulk dataset, license or permission path was checked first.
- [ ] No step requires logging in, creating accounts or bypassing a technical measure (if one does, stop for review).
- [ ] Terms of service and robots.txt were read and snapshotted with a timestamp.
- [ ] Personal data is identified; lawful basis, minimization and retention are documented.
- [ ] The output is facts or analysis, not republished expression.
- [ ] Load is modest and the bot is identifiable.
- [ ] Jurisdictions (operator, servers, data subjects) are listed.
- [ ] A stop procedure exists for cease-and-desist letters, blocks and challenges.
- [ ] Any higher-risk pattern above has been reviewed by counsel.

## See Also

- [CFAA and Key US Cases](cfaa-and-key-us-cases.md)
- [Terms of Service and Contracts](terms-of-service-and-contracts.md)
- [Copyright and Database Rights](copyright-and-database-rights.md)
- [Personal Data: GDPR, CCPA and More](personal-data-gdpr-ccpa.md)
- [Ethical Scraping Checklist](ethical-scraping-checklist.md)
- [International Considerations](international-considerations.md)
