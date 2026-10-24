---
tags: [scraping, legal-ethics, international, jurisdiction]
aliases: [Scraping law by country, Jurisdiction, EU scraping law, UK scraping law]
---

# International Considerations

> Sources: Regulation (EU) 2016/679, GDPR (https://eur-lex.europa.eu/eli/reg/2016/679/oj); Directive (EU) 2019/790, DSM Directive (https://eur-lex.europa.eu/eli/dir/2019/790/oj); ICO, Upper Tribunal judgment on Clearview AI (https://ico.org.uk/about-the-ico/media-centre/news-and-blogs/2025/10/uk-upper-tribunal-hands-down-judgment-on-clearview-ai-inc); Skadden on ICO generative AI consultation outcomes (https://www.skadden.com/insights/publications/2025/01/ico-publishes-outcomes-of-genai-consultation); Stephenson Harwood on the UK copyright and AI report (https://www.stephensonharwood.com/post/102mpke/uk-government-publishes-report-and-impact-assessment-on-copyright-and-artificial-intelligence-the-debate-continues/); OPC Canada, PIPEDA Findings 2021-001 on Clearview AI (https://priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2021/pipeda-2021-001); Norton Rose Fulbright on the Alberta Clearview ruling (https://www.nortonrosefulbright.com/en/knowledge/publications/05b7c24f/alberta-court-finds-sections-of-privacy-law-unconstitutional); OAIC, Clearview AI breached Australians' privacy (https://www.oaic.gov.au/newsroom/clearview-ai-breached-australians-privacy); Spam Act 2003 (Cth) (https://www.legislation.gov.au/C2004A01214/latest/text); ACS on Australia ruling out a TDM exception (https://ia.acs.org.au/article/2025/govt-rules-out-ai-copyright-exemption-for-tech-giants.html); AZB & Partners on India's DPDP rollout (https://www.azbpartners.com/bank/indias-digital-personal-data-protection-act-phased-rollout-and-key-compliance-milestones/); Cyril Amarchand Mangaldas on ANI v. OpenAI (https://corporate.cyrilamarchandblogs.com/2026/07/ani-v-open-ai-delhi-high-court-refuses-interim-injunction-in-landmark-ai-copyright-dispute/); Herbert Smith Freehills Kramer on China's 2025 Anti-Unfair Competition Law (https://www.hsfkramer.com/notes/crt/2025-07/china-releases-the-2025-anti-unfair-competition-law); CEPA on Asian TDM exceptions (https://cepa.org/article/ai-boom-or-copyright-doom-lessons-from-asia/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** This is a high-level comparison. Local counsel is essential before operating in or targeting any of these jurisdictions.

Scraping is rarely governed by one country's law. At least four places can matter: where **you** operate, where the **servers** are, where the **people in the data** live, and the law chosen in the site's **terms**. Laws stack rather than replace each other, so a US company scraping European profiles from a server in Ireland can face the CFAA, Irish and EU data protection law, EU database rights and a California choice-of-law clause at once. The common pattern worldwide: public availability does not remove privacy duties, circumventing technical measures is treated harshly, and copyright exceptions for text and data mining range from broad (Japan, Singapore) to opt-out based (EU) to absent (Australia, Canada).

## How jurisdiction attaches

- **Data protection follows the people.** The GDPR reaches non-EU organisations that monitor people in the EU (Article 3(2)); Clearview AI was fined by several EU authorities without having an EU office.
- **Computer misuse laws follow the systems and the actor.** Unauthorized access is usually an offence where the computer is and where the actor is.
- **Copyright is territorial.** In Getty Images v. Stability AI (UK, 2025) Getty dropped its primary training claims partly because training took place outside the UK.
- **Contracts pick a forum.** Terms often choose a governing law and courts, frequently California or Ireland for large platforms.

## European Union

- **Data protection:** the GDPR, enforced by national authorities and coordinated by the EDPB. Expect a legitimate interests assessment, Article 14 transparency and minimization (see [Personal Data: GDPR, CCPA and More](personal-data-gdpr-ccpa.md)). Draft EDPB Guidelines 03/2026 on web scraping for generative AI were open for consultation until 30 October 2026.
- **Database right and copyright:** the Database Directive's sui generis right and the DSM Directive's TDM exceptions (Article 3 for research, Article 4 with machine-readable opt-outs).
- **AI Act:** copyright-policy and training-summary obligations for general-purpose model providers since 2 August 2025.
- **Computer crime:** member states criminalise illegal access to information systems under Directive 2013/40/EU, which allows the offence to be limited to cases where a security measure is infringed; national rules differ.
- **Unfair competition and contract:** national laws; the CJEU's Ryanair v. PR Aviation (2015) lets owners of unprotected databases restrict use by contract.

## United Kingdom

- **Data protection:** UK GDPR and the Data Protection Act 2018, amended by the Data (Use and Access) Act 2025. The ICO's December 2024 generative AI outcomes treat legitimate interests as the only realistic basis for training-data scraping and stress the necessity and balancing tests.
- **Clearview AI:** the ICO fined Clearview about GBP 7.5 million in 2022; the First-tier Tribunal overturned it in October 2023 on jurisdiction; on 8 October 2025 the Upper Tribunal found the processing within the UK GDPR's scope and sent the case back; Clearview was then given permission to appeal to the Court of Appeal.
- **Computer misuse:** the Computer Misuse Act 1990 criminalises unauthorised access to computer material.
- **Copyright:** CDPA s. 29A permits TDM only for non-commercial research with lawful access, and contract terms cannot override it. There is no commercial TDM exception; the government published its copyright and AI report and impact assessment in March 2026 under the 2025 Act. The UK also keeps its own database right.

## Canada

- **Privacy:** PIPEDA federally, plus Alberta, British Columbia and Quebec private-sector laws. The "publicly available" exception to consent is defined narrowly by regulation.
- **Clearview AI:** a joint federal and provincial investigation (report February 2021) found that scraping images from websites and social media for an unrelated purpose is not covered by the publicly available exception. The BC Supreme Court upheld the BC commissioner's order in December 2024 (2024 BCSC 2311). In May 2025 Alberta's Court of King's Bench upheld Alberta's order but held the province's narrow definition of publicly available information infringed freedom of expression, reading it to include information people intentionally make public, such as unrestricted social media posts. Watch for appeals and federal reform.
- **Copyright:** no dedicated TDM exception; fair dealing is the main flexibility.

## Australia

- **Privacy:** the Privacy Act 1988 and Australian Privacy Principles. In 2021 the OAIC found Clearview AI breached them, including by collecting personal information by unfair means and sensitive information without consent, and ordered it to stop and destroy Australian data; the Administrative Appeals Tribunal upheld key findings in 2023.
- **Anti-spam:** Part 3 of the Spam Act 2003 prohibits supplying, acquiring or using address-harvesting software and harvested address lists in connection with unlawful commercial email. Scraping email addresses for marketing is directly targeted.
- **Copyright:** no TDM exception, and in October 2025 the government ruled one out for AI training, turning instead to licensing and transparency options.

## India

- **Privacy:** the Digital Personal Data Protection Act 2023. Section 3(c)(ii) excludes personal data made publicly available by the person it relates to, or by someone legally obliged to publish it; the boundary of that exclusion is debated. The DPDP Rules were notified in November 2025 with most obligations phased in over 18 months.
- **Computer access:** the Information Technology Act 2000 provides compensation for downloading, copying or extracting data from a computer system without the owner's permission (section 43) and criminal penalties when done dishonestly or fraudulently (section 66). The government told Parliament in 2025 that scraping of publicly available user data is regulated under this Act.
- **Copyright:** in ANI v. OpenAI the Delhi High Court refused an interim injunction in July 2026, finding prima facie that storing ANI's works for training fell within fair dealing; an appeal is pending and the trial questions remain open.

## Other jurisdictions in brief

- **Japan:** Copyright Act Article 30-4 permits uses not aimed at enjoying a work, such as information analysis, unless they unreasonably prejudice the owner. Personal data falls under the APPI.
- **Singapore:** Copyright Act 2021 section 244 allows computational data analysis with lawful access under conditions; personal data falls under the PDPA.
- **China:** the revised Anti-Unfair Competition Law (effective 15 October 2025) adds Article 13, prohibiting obtaining or using data lawfully held by other businesses through fraud, coercion, or circumventing or sabotaging technical management measures. The PIPL limits processing of publicly disclosed personal information to a reasonable scope.
- **South Korea:** in May 2022 the Supreme Court (2021Do1533) acquitted a rival accommodation app's staff of criminal charges for crawling Yanolja's API, which was openly reachable, and set out how to judge a "substantial part" of a database. Civil liability is a separate question.
- **Brazil:** the LGPD covers publicly accessible personal data too.

## Comparison

| Jurisdiction | Public personal data | Computer access law | Commercial TDM |
|---|---|---|---|
| EU | Covered by GDPR | Directive 2013/40/EU, national laws | Allowed unless reserved (DSM Art. 4) |
| UK | Covered by UK GDPR | Computer Misuse Act 1990 | No exception (research only, s. 29A) |
| US | Partly excluded (CCPA "publicly available" carve-out); biometric laws still apply | CFAA, state laws | Fair use, case by case |
| Canada | Narrow exception, contested in Alberta | Criminal law and privacy statutes | No exception |
| Australia | Covered by Privacy Act | Criminal and spam laws | No exception |
| India | Excluded if made public by the person | IT Act 2000 ss. 43, 66 | Fair dealing, litigated |
| Japan | Covered by APPI | Unauthorized access law | Broad (Art. 30-4) |

## Practical approach for multi-country scraping

1. Map the four connecting factors (operator, servers, data subjects, terms' chosen law) per source.
2. Design to the strictest applicable rule for personal data, usually the GDPR.
3. Geo-scope datasets: exclude regions you cannot support legally.
4. Appoint an EU or UK representative if you monitor people there without an establishment.
5. Track TDM opt-outs and AI restrictions per source, not per project.
6. Keep provenance so you can answer regulators in any jurisdiction.

## Pitfalls

- **Assuming home-country law is the only law.**
- **Treating "publicly available" exemptions as uniform.** India's, California's and Canada's mean very different things.
- **Copying an EU database because US law treats facts as free.**
- **Relying on a TDM exception without lawful access** or despite an opt-out.

## Checklist

- [ ] Connecting factors mapped for each source.
- [ ] Strictest personal data regime identified and applied.
- [ ] TDM and copyright position checked for the countries where copying happens.
- [ ] Computer-access law checked for anything beyond public, logged-off pages.
- [ ] Representative or local counsel arranged where needed.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [Personal Data: GDPR, CCPA and More](personal-data-gdpr-ccpa.md)
- [Copyright and Database Rights](copyright-and-database-rights.md)
- [CFAA and Key US Cases](cfaa-and-key-us-cases.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
