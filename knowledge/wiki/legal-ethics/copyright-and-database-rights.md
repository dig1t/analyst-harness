---
tags: [scraping, legal-ethics, copyright, database-right, text-and-data-mining]
aliases: [Copyright, Sui generis database right, Text and data mining, TDM exception, Fair use]
---

# Copyright and Database Rights

> Sources: Feist Publications v. Rural Telephone Service, 499 U.S. 340 (1991) (https://supreme.justia.com/cases/federal/us/499/340/); Directive 96/9/EC, Database Directive (https://eur-lex.europa.eu/eli/dir/1996/9/oj); Directive (EU) 2019/790, DSM Directive (https://eur-lex.europa.eu/eli/dir/2019/790/oj); Regulation (EU) 2024/1689, AI Act (https://eur-lex.europa.eu/eli/reg/2024/1689/oj); Bird & Bird on CV-Online Latvia v. Melons, C-762/19 (https://www.twobirds.com/en/insights/2021/uk/cv-online-latvia-cjeu-complicates-the-enforcement-of-database-rights); DLA Piper on Kneschke v. LAION (https://www.dlapiper.com/en/insights/blogs/mse-today/2025/robert-kneschke-v-laion); Taylor Wessing on GEMA v. OpenAI (https://www.taylorwessing.com/de/insights-and-events/insights/2025/11/gema-v-openai); Haynes Boone on Thomson Reuters v. Ross (3d Cir. 2026) (https://www.haynesboone.com/news/alerts/third-circuit-rejects-fair-use-for-rosss-copying-of-westlaw-headnotes); Polsinelli on Bartz v. Anthropic and Kadrey v. Meta (https://www.polsinelli.com/publications/ai-vs-authors-update-court-approves-historic-anthropic-settlement-while-meta-litigation-continues); US Copyright Office, Copyright and Artificial Intelligence (https://www.copyright.gov/ai/); UK CDPA 1988 s. 29A (https://www.legislation.gov.uk/ukpga/1988/48/section/29A)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** Copyright outcomes are fact-specific and jurisdiction-specific. Treat this as an issue-spotting guide.

Copyright protects **expression**, not **facts**. A price, a date, a flight time or a company address is free to take; the article, review, photo, product description or source code around it usually is not. Europe adds a second layer, the **sui generis database right**, which protects the investment in building a database even when its contents are unprotected facts. Text and data mining (TDM) exceptions in the EU, UK, Japan and Singapore permit some analytical copying, and the EU's general exception can be switched off by machine-readable opt-outs. AI training is the most litigated use in 2025 and 2026, and the courts have not converged.

## Facts versus expression (US)

**Feist v. Rural Telephone (US Supreme Court, 1991)** rejected "sweat of the brow": effort in collecting facts earns no copyright. A compilation is protected only for an original selection, coordination or arrangement, and an alphabetical white-pages listing had none. For scrapers this means:

| Usually free to extract | Usually protected expression |
|---|---|
| Prices, stock status, dimensions, dates, scores | Articles, reviews, comments, forum posts |
| Names, addresses, phone numbers (privacy law aside) | Product descriptions and marketing copy |
| Numeric series, rankings as facts | Photos, illustrations, video, music |
| URLs and metadata | Source code, original editorial selections |

Copying expression for analysis and then storing only derived facts is a very different risk from republishing it.

## Fair use and AI training (US)

Fair use (17 U.S.C. 107) weighs four factors: purpose and character (including transformativeness and commerciality), the nature of the work, the amount used and the effect on the market. Recent rulings that matter for data acquisition:

- **Thomson Reuters v. Ross Intelligence.** In February 2025 the District of Delaware held that copying 2,243 Westlaw headnotes to build a competing legal research tool was not fair use. On 29 September 2026 the Third Circuit affirmed in a precedential opinion: the headnotes were original, the use was not transformative, and it harmed a market that includes licensing content as AI training data. The court stressed the tool did not generate new expression, so the ruling does not answer the generative AI question.
- **Bartz v. Anthropic (N.D. Cal. June 2025).** Training a large language model on lawfully acquired books was fair use, as was digitizing purchased print copies, but building a central library from pirated copies was not. The case then settled as a class action for $1.5 billion.
- **Kadrey v. Meta (N.D. Cal. June 2025).** Meta won summary judgment on fair use because the plaintiffs had not produced enough evidence of market harm; the judge signaled that stronger evidence of harm to the market for the works could change the outcome in future cases. A separate claim about distributing works while torrenting them continued.
- **US Copyright Office, Part 3 report (pre-publication, 9 May 2025).** The Office rejected the view that training is inherently fair use and called for case-by-case analysis, noting that some uses likely are not fair.

Takeaways for scrapers: **how you acquire** content matters (pirated or paywall-bypassed sources are the worst facts), substitutive uses that compete with the source weigh against you, and outputs that reproduce expression create separate exposure.

Bypassing a paywall or bot challenge can also trigger DMCA 1201 anti-circumvention claims independent of infringement (see [CFAA and Key US Cases](cfaa-and-key-us-cases.md)).

## EU and UK database protection

The **Database Directive (96/9/EC)** gives two independent rights:

1. **Copyright in the database** for an original selection or arrangement of contents. In **Football Dataco v. Yahoo (C-604/10, 2012)** the CJEU held that skill and labour spent creating the data (football fixture lists) does not make the database original.
2. **Sui generis right (Article 7)** for makers who made a substantial investment in **obtaining, verifying or presenting** the contents. It lets them prevent extraction or re-utilisation of a substantial part, or repeated and systematic extraction of insubstantial parts that conflicts with normal exploitation (Article 7(5)). Protection lasts 15 years and restarts with substantial new investment (Article 10).

Key CJEU cases:

- **British Horseracing Board v. William Hill (C-203/02, 2004):** investment in **creating** data does not count, only investment in obtaining, verifying or presenting it. Data generated as a by-product of a business may not be protected.
- **CV-Online Latvia v. Melons (C-762/19, 3 June 2021):** a specialised job-ad search engine that copied and indexed a job site's database did extract and re-utilise it, but that infringes only if it puts the maker's investment at risk, meaning the national court must weigh harm to the investment against the benefits of the use.
- **Ryanair v. PR Aviation (C-30/14, 2015):** for a database protected by neither right, the owner can restrict use by contract (see [Terms of Service and Contracts](terms-of-service-and-contracts.md)).

Lawful users of a protected database may extract insubstantial parts (Article 8), and contract terms overriding that are null (Article 15). The UK kept its own database right after leaving the EU.

## Text and data mining exceptions

| Regime | Who and what | Can rights holders opt out? |
|---|---|---|
| EU DSM Art. 3 | Research organisations and cultural heritage institutions, scientific research, lawful access | No; contrary contract terms are unenforceable (Art. 7(1)) |
| EU DSM Art. 4 | Anyone with lawful access, any purpose; copies kept only as long as needed | Yes, "in an appropriate manner, such as machine-readable means" for online content |
| UK CDPA s. 29A | Lawful access, computational analysis for non-commercial research | No; contract override is unenforceable (s. 29A(5)) |
| Japan Art. 30-4 | Uses not for "enjoyment" of the work, such as information analysis | No opt-out mechanism, but the exception does not apply where it would unreasonably prejudice the owner |
| Singapore s. 244 | Computational data analysis with lawful access, subject to conditions | No opt-out mechanism; the statutory conditions apply |

Court decisions applying the EU exceptions:

- **Kneschke v. LAION.** The Hamburg Regional Court (27 September 2024) held that a non-profit's creation of an image-text training dataset was covered by the scientific research exception (German Copyright Act s. 60d). On appeal, the Hamburg Higher Regional Court (10 December 2025) dismissed the photographer's appeal, held that the general exception (s. 44b, Article 4) also applied, and took a narrow view of whether a natural-language reservation in website terms is machine-readable. A further appeal to the Federal Court of Justice was allowed.
- **GEMA v. OpenAI (Munich Regional Court I, 11 November 2025):** lyrics memorised in model weights and reproducible in outputs were reproductions, and the TDM exceptions did not cover that memorisation. The judgment was not final.

**The EU AI Act (Article 53(1)(c))** requires providers of general-purpose AI models to have a policy to comply with EU copyright law, including identifying and honouring Article 4(3) reservations, and to publish a summary of training content. These obligations have applied since 2 August 2025. The voluntary code of practice commits signatories to crawlers that read and follow robots.txt. See [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md) for the signals themselves.

## UK: Getty Images v. Stability AI

On 4 November 2025 the High Court rejected Getty's secondary infringement claim: a model can in principle be an "article", but Stable Diffusion did not store or contain infringing copies. Getty had dropped its primary training claims during trial, partly because training happened outside the UK, which illustrates how territorial copyright is. The UK government published its copyright and AI report and economic impact assessment in March 2026 under the Data (Use and Access) Act 2025.

## Practical risk reduction

- Extract facts and structured fields; avoid storing or republishing full expression you do not need.
- Prefer licensed sources and open licenses (respect attribution and share-alike terms).
- Never bypass paywalls, logins or bot challenges to get content ("lawful access" is a condition of the EU, UK and Singapore TDM exceptions).
- Honour robots.txt, TDM reservations and AI opt-outs, and record what you saw at fetch time.
- Do not copy a substantial part of an EU database to build a competing service without a license.
- Keep raw copies only as long as needed, access-controlled, and document the purpose ([Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)).

## Pitfalls

- **"Facts are free, so the whole page is free."** The page is mostly expression.
- **Ignoring the database right** because the data is factual; the EU protects the investment.
- **Treating Article 4 as unconditional.** It requires lawful access and yields to machine-readable reservations.
- **Assuming one AI ruling settles training.** Results differ by court, facts and country.
- **Forgetting outputs.** Memorised or regurgitated text is a separate problem from training.

## Checklist

- [ ] Fields extracted are facts or short metadata, not full expression.
- [ ] Licenses for any reused content are recorded with attribution requirements.
- [ ] Source accessed lawfully (no paywall, login or challenge bypass).
- [ ] robots.txt and TDM or AI opt-outs checked and logged per fetch.
- [ ] EU or UK databases: substantial-part extraction assessed.
- [ ] Downstream use (publication, resale, AI training) reviewed separately.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [Terms of Service and Contracts](terms-of-service-and-contracts.md)
- [International Considerations](international-considerations.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
- [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)
- [News Sites and RSS](../sources/news-and-rss.md)
