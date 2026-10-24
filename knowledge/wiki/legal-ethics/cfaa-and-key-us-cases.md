---
tags: [scraping, legal-ethics, cfaa, case-law, us-law]
aliases: [CFAA, Computer Fraud and Abuse Act, hiQ v. LinkedIn, Van Buren, US scraping cases]
---

# CFAA and Key US Cases

> Sources: Van Buren v. United States, 593 U.S. 374 (2021) (https://www.supremecourt.gov/opinions/20pdf/19-783_k53l.pdf); Congressional Research Service, LSB10616 on Van Buren (https://www.congress.gov/crs-product/LSB10616); Fenwick, hiQ v. LinkedIn on remand (https://www.fenwick.com/insights/publications/hiq-labs-scrapes-by-again-the-ninth-circuit-reaffirms-that-data-scraping-does-not-violate-the-cfaa-1); Proskauer, hiQ consent judgment (https://www.proskauer.com/blog/hiq-and-linkedin-reach-proposed-settlement-in-landmark-scraping-case); Farella Braun + Martel, Meta v. Bright Data (https://www.fbm.com/technology/publications/major-decision-affects-law-of-scraping-and-online-data-collection-meta-platforms-v-bright-data/); EFF, Sandvig v. Barr (https://www.eff.org/deeplinks/2020/04/federal-judge-rules-it-not-crime-violate-websites-terms-service); Morrison Foerster, DOJ CFAA charging policy (https://www.mofo.com/resources/insights/220525-cyber-crime-charging-policy); EFF, Ryanair v. Booking.com (https://www.eff.org/deeplinks/2025/07/ryanairs-cfaa-claim-against-bookingcom-has-nothing-do-actual-hacking); Loeb & Loeb, Reddit v. SerpApi (https://www.loeb.com/en/insights/publications/2026/08/reddit-v-serpapi-llc); FindLaw, Google LLC v. SerpApi LLC (2026) (https://caselaw.findlaw.com/court/us-dis-crt-n-d-cal/350669.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** This is a practitioner's summary of US case law as of the Updated date. Verify the current status of any case, and talk to a lawyer, before relying on it.

The Computer Fraud and Abuse Act (CFAA, 18 U.S.C. 1030) carries criminal and civil liability, which made it the statute scrapers feared most. Two decisions shrank that risk for **public, logged-off pages**: Van Buren (2021) narrowed "exceeds authorized access", and hiQ v. LinkedIn (9th Cir. 2022) held that scraping publicly available profiles is likely not access "without authorization". The risk moved rather than disappeared: logged-in access, fake accounts, ignored revocations and circumvented bot defenses still create exposure, and platforms now also sue on contract, trespass, trade secrets and the DMCA's anti-circumvention provision.

## The statute in brief

- **18 U.S.C. 1030(a)(2)(C)** covers whoever intentionally accesses a computer **without authorization** or **exceeds authorized access** and thereby obtains information from any protected computer (in practice, any computer connected to the internet).
- **1030(g)** gives a civil action to anyone who suffers damage or loss. Civil plaintiffs usually have to prove at least **$5,000 of loss** in a one-year period, which is where Ryanair's jury verdict against Booking.com later failed.
- **State laws** add their own versions. California Penal Code 502 (the Comprehensive Computer Data Access and Fraud Act) appears alongside the CFAA in Power Ventures, Craigslist v. 3Taps and the hiQ consent judgment.

## Van Buren v. United States (2021)

Decided 3 June 2021, 6 to 3, opinion by Justice Barrett. A police officer used a law-enforcement database he was entitled to use, but for an improper purpose. The Court held that a person "exceeds authorized access" when they access a computer with authorization but then obtain information located in particular areas of the computer (files, folders, databases) that are off-limits to them. Purpose-based limits do not count. Commentators call this the "gates-up-or-down" inquiry: either you are allowed into that part of the system or you are not.

Footnote 8 is the open question that matters for scrapers: the Court declined to decide whether the gate must be a technological (code-based) limitation or can also be set by contracts or policies. Lower courts are still working it out.

## hiQ Labs v. LinkedIn (2017 to 2022)

| Stage | What happened |
|---|---|
| 2017 | LinkedIn sent hiQ, which scraped public profiles, a cease-and-desist and blocked it. hiQ won a preliminary injunction. |
| 2019 | The Ninth Circuit affirmed the injunction. |
| 2021 | The Supreme Court vacated and remanded in light of Van Buren. |
| April 2022 | The Ninth Circuit reaffirmed (31 F.4th 1180): hiQ raised serious questions that scraping publicly available profiles after a cease-and-desist is not "without authorization", reading the CFAA as an anti-intrusion statute built around gates. |
| November 2022 | Judge Edward Chen (N.D. Cal.) found that hiQ breached LinkedIn's User Agreement, both by scraping and by using fake profiles created by contractors ("turkers"), leaving other issues such as hiQ's waiver and estoppel defenses for trial. |
| December 2022 | Stipulated consent judgment: $500,000 against hiQ, a permanent injunction against scraping in violation of the User Agreement and against fake accounts, and deletion of scraped data and the code built on it. |

Lesson: winning the CFAA argument did not save hiQ. The contract and fake-account facts did the damage. The stipulated findings are an agreement between parties, not precedent.

## Meta Platforms v. Bright Data (2024)

On 23 January 2024 Judge Chen granted Bright Data summary judgment on Meta's breach-of-contract claim. Meta's Facebook and Instagram terms could not be read to prohibit **logged-off** scraping of publicly available data, and Meta had not shown that Bright Data scraped while logged in to its own accounts. On 23 February 2024 Meta dismissed its remaining claim and waived its right to appeal. Lesson: design around the logged-in versus logged-off line.

## X Corp. v. Bright Data (2024 to 2025)

Judge William Alsup dismissed X's suit on 9 May 2024, holding that state-law claims seeking to stop the copying and sale of public user content were preempted by the Copyright Act (X did not own that content), and that a breach of contract without damage is not actionable under California law. In late 2024 he let X proceed on amended claims that Bright Data's access impaired X's servers, while again rejecting claims based on the scraping of data itself. The parties reported a settlement in principle in June 2025. Lesson: server burden is a live theory even when the data is public.

## Revocation: Power Ventures and 3Taps

- **Facebook v. Power Ventures, 844 F.3d 1058 (9th Cir. 2016).** Power accessed Facebook with users' permission. After Facebook sent a cease-and-desist letter and blocked Power's IP addresses, continued access was "without authorization" under the CFAA and Penal Code 502. A terms-of-use violation alone was not enough; the explicit revocation was.
- **Craigslist v. 3Taps, 964 F. Supp. 2d 1178 (N.D. Cal. 2013).** Judge Charles Breyer held that a cease-and-desist letter plus IP blocking revoked 3Taps' authorization even though the site was public, and that switching IP addresses and using proxies to get around the block was unauthorized access. The case settled in 2015, with 3Taps paying $1 million to be donated to the EFF and accepting a permanent injunction.

After hiQ (2022) the Ninth Circuit sees no gate to revoke on public pages, which limits 3Taps there, but evading a block remains a terrible fact pattern for contract, trespass and DMCA claims everywhere.

## Terms-of-service violations are not crimes (mostly)

- **United States v. Nosal, 676 F.3d 854 (9th Cir. 2012, en banc)** read "exceeds authorized access" as a restriction on access, not on use, warning that the opposite reading would criminalize everyday terms-of-service violations.
- **Sandvig v. Barr (D.D.C. 27 March 2020).** Judge John D. Bates held that the CFAA does not criminalize mere terms-of-service violations on consumer websites, so academic researchers' plan to use fictitious accounts and false information to test hiring sites for discrimination was not a crime. He noted that civil liability under contract law can remain. An earlier ruling in the same case (Sandvig v. Sessions, 315 F. Supp. 3d 1, D.D.C. 2018) let a First Amendment claim proceed.
- **DOJ charging policy (19 May 2022).** Federal prosecutors are told not to charge good-faith security research, and that conduct such as embellishing a dating profile contrary to the terms, creating fictional accounts on hiring, housing or rental sites, or using a prohibited pseudonym is not by itself sufficient for federal charges. The policy binds only federal prosecutors, not civil plaintiffs or states.

## Loss and the free-login gate: Ryanair v. Booking.com

A Delaware jury found Booking.com liable to Ryanair under the CFAA in July 2024 and awarded $5,000. In January 2025 the trial judge granted Booking.com judgment as a matter of law because Ryanair had not proved at least $5,000 of loss. Along the way the district court read the CFAA to reach information behind a free account login once the site owner objects, which drew amicus briefs from the EFF and the Reporters Committee for Freedom of the Press. Ryanair's appeal (Third Circuit, No. 25-1374) was pending at the time of writing.

## Trespass to chattels and trade secrets

- **eBay v. Bidder's Edge, 100 F. Supp. 2d 1058 (N.D. Cal. 2000).** Judge Ronald Whyte enjoined an auction aggregator whose robots queried eBay roughly 100,000 times a day, treating unauthorized robotic use of eBay's servers as a likely trespass to chattels.
- **Intel v. Hamidi, 30 Cal. 4th 1342 (2003).** The California Supreme Court held that trespass to chattels requires damage to the computer system or impairment of its functioning. Polite, low-volume scraping is hard to fit into trespass; load that degrades a site is not.
- **Compulife Software v. Newman (11th Cir. 2020, and again in 2024).** Using a bot to pull a large share of the quotes from a publicly accessible insurance-quote engine could misappropriate the underlying database as a trade secret by "improper means", even though any single quote was public; in 2024 the court affirmed the trade-secret ruling, noting that ordinary manual lookups would not be improper.

## The new front: DMCA anti-circumvention (17 U.S.C. 1201)

Section 1201 prohibits circumventing a technological measure that controls access to a copyrighted work, with statutory damages of $200 to $2,500 per act of circumvention.

- **Google v. SerpApi (N.D. Cal., filed 19 December 2025).** Google alleged that SerpApi bypassed SearchGuard, its JavaScript challenge system, on a massive scale. On 20 July 2026 Judge Yvonne Gonzalez Rogers dismissed the 1201 claims for search results with no copyrighted content without leave to amend, and gave Google leave to amend as to copyrighted components if it can show authorization from the copyright owners.
- **Reddit v. SerpApi, Oxylabs, AWMProxy and Perplexity (S.D.N.Y., filed late 2025).** Reddit alleged that the defendants scraped Reddit content from Google results by circumventing Google's protections. On 31 July 2026 Judge Paul Engelmayer largely denied the motions to dismiss: circumvention and trafficking claims under 1201(a) and a civil conspiracy claim proceed, while the 1201(b), unfair competition and unjust enrichment claims were dismissed. This is a pleading-stage ruling, not a merits decision.

Lesson: bypassing CAPTCHAs, JavaScript challenges and bot detection is now litigated as circumvention, one more reason the vault treats challenges as a signal to stop ([CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)).

## Pitfalls

- Citing hiQ as "scraping is legal". It held that a preliminary injunction was justified on CFAA grounds; hiQ then lost on contract and paid.
- Ignoring state statutes such as Penal Code 502, which courts apply alongside the CFAA.
- Reading the DOJ policy as protection from civil suits.
- Assuming Ninth Circuit law applies everywhere: the Third Circuit (Ryanair) and other circuits may read revocation differently.
- Treating DMCA 1201 rulings as settled; the two July 2026 decisions point in different directions.

## Checklist

- [ ] All target pages are reachable logged off; no fake, purchased or borrowed accounts.
- [ ] No access-control or bot-challenge circumvention anywhere in the pipeline.
- [ ] A cease-and-desist or block triggers an automatic stop and human review, never IP or proxy rotation.
- [ ] Request rates are documented and modest (evidence against "loss" and impairment).
- [ ] Terms and robots.txt are snapshotted per run (see [Terms of Service and Contracts](terms-of-service-and-contracts.md)).
- [ ] Bulk extraction of a competitor's database has been reviewed for trade-secret and contract risk.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [Terms of Service and Contracts](terms-of-service-and-contracts.md)
- [Copyright and Database Rights](copyright-and-database-rights.md)
- [Ethical Scraping Checklist](ethical-scraping-checklist.md)
- [Recognizing Blocks and Responding Responsibly](../anti-bot/blocks-and-responsible-response.md)
- [CAPTCHAs and What They Mean for Your Project](../anti-bot/captchas.md)
