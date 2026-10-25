---
tags: [scraping, legal-ethics, terms-of-service, contracts]
aliases: [ToS, Terms of use, Browsewrap, Clickwrap, User agreement]
---

# Terms of Service and Contracts

> Sources: Specht v. Netscape Communications, 306 F.3d 17 (2d Cir. 2002); Nguyen v. Barnes & Noble, 763 F.3d 1171 (9th Cir. 2014) (https://caselaw.findlaw.com/us-9th-circuit/1675706.html); Perkins Coie on Berman v. Freedom Financial Network, 30 F.4th 849 (9th Cir. 2022) (https://perkinscoie.com/insights/update/ninth-circuit-addresses-website-design-enforceable-terms-service); Register.com v. Verio, 356 F.3d 393 (2d Cir. 2004) (https://m.openjurist.org/356/f3d/393); Eric Goldman on Southwest Airlines v. Kiwi.com (https://blog.ericgoldman.org/archives/2021/10/tos-supports-injunction-against-web-scraping-southwest-airlines-v-kiwi.htm); Farella Braun + Martel, Meta v. Bright Data (https://www.fbm.com/technology/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/); Morrison Foerster, X Corp. v. Bright Data (https://www.mofo.com/resources/insights/240604-california-federal-court-holds-x-s-claims); Crowell & Moring, Reddit v. Anthropic remand (https://www.crowell.com/en/insights/client-alerts/northern-district-of-california-court-holds-state-tort-and-contract-claims-not-preempted-by-federal-copyright-act-remands-reddit-v-anthropic-to-state-court); CJEU C-30/14 Ryanair v. PR Aviation (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62014CJ0030)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** Contract law varies by state and country, and enforceability depends on the exact screens a user saw. Use this to spot issues, then ask a lawyer.

Terms of service (ToS) have become the main legal tool platforms use against scrapers, because US courts have narrowed computer-crime theories for public pages. Two questions decide most disputes: **did a contract form** (did you assent, or have actual notice of the terms), and **does the contract reach what you did** (logged-in versus logged-off conduct, scraping versus later use). A third question is now contested: whether copyright law preempts contract claims that try to control the copying of public content. If you log in, you are almost certainly bound. If you never log in and never click "I agree", you may not be, but cease-and-desist letters can supply the notice that was missing.

## How online contracts form

| Pattern | What the user sees | Usually enforceable? | Key cases or notes |
|---|---|---|---|
| Clickwrap | Must tick a box or click "I agree" next to the terms | Yes | Routinely enforced by US courts |
| Sign-in or sign-up wrap | "By creating an account you agree to the Terms" near the button | Often, if notice is conspicuous | Berman (9th Cir. 2022) |
| Browsewrap | A "Terms" link in the footer, no action required | Usually not, unless actual notice | Specht (2d Cir. 2002), Nguyen (9th Cir. 2014) |
| Notice by letter | A cease-and-desist that quotes or attaches the terms | Can create actual knowledge | Southwest v. Kiwi.com (N.D. Tex. 2021) |

- **Specht v. Netscape (2d Cir. 2002):** license terms sitting below the download button, with no requirement to view them, did not bind users; the court required reasonable notice and unambiguous manifestation of assent.
- **Nguyen v. Barnes & Noble (9th Cir. 2014):** a conspicuous "Terms of Use" link on every page, without more, did not give constructive notice; browsewraps are enforced where the user had actual notice.
- **Berman v. Freedom Financial Network (9th Cir. 2022):** sign-in wraps bind only if the site gives reasonably conspicuous notice of the terms and the user takes an action that unambiguously manifests assent. Gray, small, unexplained links failed.

## Actual notice and repeated access

Bots are treated differently from casual visitors when the operator clearly knows the terms:

- **Register.com v. Verio (2d Cir. 2004):** Verio's daily automated WHOIS queries, made with full knowledge of the restrictive legend returned with each response, amounted to acceptance of those terms, even though a single query might not have.
- **Southwest Airlines v. Kiwi.com (N.D. Tex. 2021):** the court enjoined Kiwi from scraping fares, finding that Kiwi had actual knowledge of Southwest's terms, which were displayed next to the purchase button and repeated in several cease-and-desist letters. The court relied on Southwest v. BoardFirst (N.D. Tex. 2007), where use of the site after a cease-and-desist letter counted as acceptance.

Practical reading: once you receive a letter that sets out the terms, assume they bind your continued automated use of that site.

## Logged-in versus logged-off

- **hiQ v. LinkedIn (N.D. Cal. November 2022):** hiQ breached LinkedIn's User Agreement both by scraping and by using fake profiles created by contractors to access the site; the case ended in a $500,000 consent judgment and permanent injunction. Accounts mean assent.
- **Meta v. Bright Data (N.D. Cal. January 2024):** Meta's terms could not be read to bar **logged-off** scraping of public data, and Meta had not shown Bright Data scraped while logged in. Meta dropped the case and waived appeal.
- **Sandvig v. Barr (D.D.C. 2020):** creating fictitious accounts in violation of terms was not a federal crime, but the court noted that civil contract liability may remain.

The design rule follows directly: if a scraper needs an account, it is operating under that account's contract. Do not create accounts to scrape, and do not automate an account whose terms forbid automation.

## Copyright preemption: an open split

The Copyright Act preempts state claims that merely duplicate copyright's exclusive rights, and can also displace state law that conflicts with federal copyright policy. Courts disagree on how that applies to scraping:

- **X Corp. v. Bright Data (N.D. Cal. May 2024):** Judge Alsup held that X could not use its terms to stop the copying and sale of public posts it did not own, because those state-law claims conflicted with the Copyright Act. He also held that a breach of contract without damage is not actionable under California law. Claims about server impairment were later allowed to proceed.
- **Reddit v. Anthropic (2025 to 2026):** Reddit sued in San Francisco Superior Court in June 2025 alleging breach of its user agreement. In March 2026 a federal judge remanded the case to state court, finding the claims not preempted. In September 2026 the state court overruled the demurrer on breach of contract, interference with contract and unfair competition, finding each claim had an extra element beyond copying; unjust enrichment and trespass to chattels were dismissed with leave to amend.

Until appellate courts resolve this, assume a well-drafted ToS can support claims against scrapers who are bound by it.

## What a breach can cost

- **Damages** have to be proved; under California law a breach without damage is not actionable (X Corp. v. Bright Data).
- **Injunctions** are the usual remedy: Kiwi.com was barred from scraping Southwest; hiQ accepted a permanent injunction.
- **Stipulated money judgments** in settlements, like hiQ's $500,000.
- Terms often add **choice of law, venue, arbitration and fee-shifting** clauses that change where and how you are sued.

## The EU angle

- **Ryanair v. PR Aviation (CJEU C-30/14, 15 January 2015):** the Database Directive's mandatory user rights (Articles 6(1), 8 and 15) do not apply to a database protected neither by copyright nor by the sui generis right, so the owner may restrict its use by contract. For a protected database, contract cannot override the lawful user's rights to extract insubstantial parts.
- **DSM Directive, Article 7(1):** contract terms contrary to the research text and data mining exception of Article 3 are unenforceable. The general TDM exception in Article 4 is different: rights holders may reserve it, and for content online the reservation should be machine-readable. A clause in the ToS is one way sites try to do that; the Hamburg courts' handling of a natural-language reservation in Kneschke v. LAION shows the format matters (see [Copyright and Database Rights](copyright-and-database-rights.md)).
- Consumer-protection rules on unfair terms may limit enforceability against individuals, but they rarely help a commercial scraper.

## Reading terms like an engineer

Check and record, per source:

- Any clause on automated access, robots, spiders, scraping or "data mining".
- Rate limits, API-only requirements and API terms (often stricter on storage and display).
- Restrictions on commercial use, resale, caching duration and AI or machine-learning training.
- Account rules: one account per person, no automation, no sharing.
- Governing law, venue, arbitration and survival clauses.

Snapshot the terms with a hash and timestamp each time you run, so you can show which version applied ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

## Pitfalls

- **Assuming browsewrap never binds.** Actual notice (a letter, repeated exposure, a sign-up) changes the answer.
- **Creating "research" accounts.** The account's clickwrap now governs everything you do.
- **Using a vendor's logged-in scraping.** You may inherit the vendor's contract problems; ask how data is collected.
- **Treating X v. Bright Data as the rule.** Reddit v. Anthropic went the other way in 2026.
- **Ignoring API terms.** Scraping a site to avoid its API limits invites both contract and access claims.

## Checklist

- [ ] No account is created or used for scraping unless its terms allow automation.
- [ ] Terms reviewed for automation, commercial use, AI training and resale clauses.
- [ ] Terms snapshot (URL, hash, fetch time) stored with each run.
- [ ] A cease-and-desist or terms notice triggers an immediate stop and legal review.
- [ ] Vendor data sources confirmed as logged-off or licensed.
- [ ] For EU databases, check whether the database is protected and whether a TDM reservation exists.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [CFAA and Key US Cases](cfaa-and-key-us-cases.md)
- [Copyright and Database Rights](copyright-and-database-rights.md)
- [Ethical Scraping Checklist](ethical-scraping-checklist.md)
- [Authentication Patterns](../http/authentication-patterns.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
