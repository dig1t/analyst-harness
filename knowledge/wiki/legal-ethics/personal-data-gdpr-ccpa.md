---
tags: [scraping, legal-ethics, gdpr, privacy, personal-data]
aliases: [GDPR, CCPA, Personal data, Data protection, Privacy law for scrapers]
---

# Personal Data: GDPR, CCPA and More

> Sources: Regulation (EU) 2016/679, GDPR (https://eur-lex.europa.eu/eli/reg/2016/679/oj); Matheson on EDPB Opinion 28/2024 (https://www.matheson.com/insights/edpb-publishes-eagerly-anticipated-opinion-on-ai-models/); Reed Smith on EDPB Guidelines 03/2026 on web scraping (https://www.reedsmith.com/our-insights/blogs/technology-law-dispatch/102nbqu/edpb-web-scraping-guidelines-for-ai-making-the-impossible-possible/); Covington on CNIL legitimate interest recommendations (https://www.insideprivacy.com/artificial-intelligence/cnil-publishes-recommendations-on-legitimate-interest-as-a-legal-basis-for-ai-training/); Skadden on ICO generative AI consultation outcomes (https://www.skadden.com/insights/publications/2025/01/ico-publishes-outcomes-of-genai-consultation); Hunton on CJEU C-621/22 KNLTB (https://www.hunton.com/privacy-and-information-security-law/cjeu-rules-on-scope-of-legitimate-interest-basis-under-the-gdpr); CJEU C-252/21 Meta v. Bundeskartellamt (https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:62021CJ0252); Irish DPC, Facebook data scraping decision (https://www.dataprotection.ie/en/news-media/press-releases/data-protection-commission-announces-decision-in-facebook-data-scraping-inquiry); UODO, Bisnode judgment (https://uodo.gov.pl/en/553/1572); OPC Canada, concluding joint statement on data scraping (https://www.priv.gc.ca/en/opc-news/news-and-announcements/2024/nr-c_241028/); California Civil Code 1798.140 (https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=CIV&sectionNum=1798.140); CPPA, Delete Request and Opt-Out Platform (https://cppa.ca.gov/data_brokers)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

**Not legal advice.** Data protection law is detailed and enforcement priorities differ by regulator. Use this to design safer pipelines, and get a privacy professional involved before collecting personal data at scale.

The single most important rule: **public data is still personal data.** Under the GDPR and most laws modelled on it, scraping a name, username, photo, profile URL, email address or review that is visible to everyone is processing personal data and needs a lawful basis, transparency, minimization and security. US law is more permissive (the CCPA excludes much "publicly available" information) but has its own traps: biometrics, data broker registration and deletion duties, and state laws with private rights of action. Regulators have fined scrapers that operate from outside Europe, and they also expect platforms to defend against scraping, which is why blocks and legal letters keep increasing.

## What counts as personal data

Any information relating to an identified or identifiable person (GDPR Article 4(1)): names, handles, photos, voice, profile and post URLs, email addresses, phone numbers, IP addresses, device identifiers, and free text that mentions people. Pseudonymous handles are still personal data when they can be linked back. Combining harmless fields (employer, city, job title) can identify someone. Assume a scrape of user-generated content contains personal data.

The GDPR applies to organisations established in the EU and, under Article 3(2), to organisations elsewhere that monitor the behaviour of people in the EU. Clearview AI, a US company, was fined by authorities in France (EUR 20 million in 2022, plus a EUR 5.2 million overdue penalty in 2023), Italy and Greece (EUR 20 million each in 2022) and the Netherlands (EUR 30.5 million, announced September 2024), the last noting it had not even appointed an EU representative (Article 27).

## Lawful basis: legitimate interests is the realistic route

Consent is rarely feasible for scraping, so most scrapers rely on **legitimate interests (Article 6(1)(f))**, which requires three tests:

1. **Purpose:** a real, lawful interest. In **KNLTB (C-621/22, 4 October 2024)** the CJEU held that a commercial interest can qualify, rejecting the Dutch authority's view that only interests set out in law count.
2. **Necessity:** the processing is needed and no less intrusive route exists. The UK ICO's December 2024 generative AI outcomes treat legitimate interests as the only realistic basis for web scraping to train models, and ask developers to show that scraping, rather than licensing or direct collection, is necessary.
3. **Balancing:** individuals' rights and reasonable expectations do not override the interest. The ICO said scraping will often fail this test because people do not know it is happening.

Regulator guidance on the measures that help:

- **EDPB Opinion 28/2024 (December 2024)** on AI models: legitimate interests can work case by case; mitigating measures for web scraping include excluding certain data categories and sources and making objection easy.
- **CNIL recommendations (June 2025):** web scraping is not banned, but some measures are treated as mandatory, such as defined collection criteria, excluding certain categories of data and promptly deleting irrelevant data.
- **Dutch AP guidance (May 2024):** a strict view that scraping by private parties is almost always unlawful unless very targeted; parts of its reasoning on commercial interests were undercut by KNLTB.
- **EDPB Guidelines 03/2026 on web scraping for generative AI (draft, consultation until 30 October 2026):** public availability is not an exemption; recommended measures include limiting collection and excluding websites that object to scraping.

## Special categories and "manifestly made public"

Health, religion, political opinions, sexual orientation, biometric data for identification and similar data (Article 9) are prohibited unless an exception applies. The exception for data "manifestly made public" by the person is narrow: in **Meta v. Bundeskartellamt (C-252/21, 2023)** the CJEU required that the user had explicitly chosen to make the data public to an unlimited number of people. Clearview's faceprints failed because no Article 9 exception applied. Scraping forums about health or politics is high risk even if the posts are public.

## Transparency, rights and the Bisnode lesson

When you collect data indirectly you must tell people (Article 14), unless that is impossible or would involve disproportionate effort (Article 14(5)(b)). In 2019 Poland's authority fined Bisnode (now Dun & Bradstreet) PLN 943,000, about EUR 220,000, for compiling data on about six million people from public registers without notifying them; cost was not accepted as disproportionate effort. The Supreme Administrative Court dismissed Bisnode's final appeal in 2023, after a lower court had confirmed the duty for active business owners and annulled parts of the decision, including the fine calculation.

People also have rights of access, erasure and objection (Articles 15, 17 and 21). If you cannot find a person's records, you cannot honour them, so index personal data by subject identifiers and keep source provenance ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

## Minimization, retention and security

- Decide fields per purpose and drop the rest at extraction time, not later.
- Pseudonymize identifiers you only need for joins (a keyed hash is still personal data, but lowers risk).
- Set retention periods per dataset and delete raw captures on schedule.
- Run a data protection impact assessment (Article 35) for large-scale or systematic monitoring.
- Fines for breaching the core principles or lawful-basis rules reach EUR 20 million or 4 percent of worldwide annual turnover, whichever is higher (Article 83(5)).

```python
import hashlib, hmac, os, re

ALLOWED = {"review_id", "rating", "text", "posted_at", "author_handle"}  # decided per purpose
EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")
KEY = os.environ.get("PSEUDONYM_KEY", "dev-only-key").encode()  # real key lives in a secret store

def pseudonym(value: str) -> str:
    """Stable for joins, not reversible without the key. Still personal data under the GDPR."""
    return hmac.new(KEY, value.casefold().encode(), hashlib.sha256).hexdigest()[:16]

def minimize(record: dict) -> dict:
    out = {k: v for k, v in record.items() if k in ALLOWED}  # drop avatar, location, etc.
    if out.get("author_handle"):
        out["author_handle"] = pseudonym(out["author_handle"])
    if out.get("text"):
        out["text"] = PHONE.sub("[phone]", EMAIL.sub("[email]", out["text"]))
    return out
```

## Platforms are expected to stop you

The Irish DPC fined Meta EUR 265 million in November 2022 under Article 25 (data protection by design and default) after data on up to 533 million users, scraped through search and contact-importer features, appeared online. In August 2023, twelve data protection authorities (including the UK, Canada, Australia and Hong Kong) issued a joint statement telling platforms to protect users from unlawful scraping, followed by a concluding statement in October 2024. Expect rate limits, blocks and letters from platforms that are under regulatory pressure.

## United States

- **No general federal privacy law**, but sector laws and state laws apply.
- **CCPA/CPRA (California):** "personal information" excludes "publicly available" information: government records (used compatibly with their purpose), information a business reasonably believes was lawfully made available by the consumer or through widely distributed media, and information the consumer made available without restricting the audience. Biometric information collected without the consumer's knowledge is not "publicly available".
- **Data brokers:** under California's Delete Act, brokers register with the California Privacy Protection Agency, and from 1 August 2026 must process deletion requests from the DROP platform at least every 45 days. Selling scraped profiles can make you a data broker.
- **Biometrics:** Illinois' BIPA requires informed written consent before collecting biometric identifiers and allows private lawsuits.

For Canada, the UK, Australia, India and others, see [International Considerations](international-considerations.md).

## Pitfalls

- **"It is public, so the GDPR does not apply."** It does; public availability only affects the balancing.
- **Hashing equals anonymization.** Hashed or pseudonymized identifiers remain personal data.
- **Collecting everything "in case".** Minimization is a legal duty, and extra fields are extra liability.
- **Keeping raw HTML forever.** Raw pages hold all the personal data you chose not to extract.
- **No way to find a person's data** when an access or deletion request arrives.
- **Scraping profiles to resell** without checking data broker rules.

## Checklist

- [ ] Personal data fields identified; allowlist defined per purpose.
- [ ] Lawful basis documented (legitimate interests assessment with purpose, necessity, balancing).
- [ ] Special-category sources excluded or separately justified.
- [ ] Article 14 notice approach decided (privacy notice, or a documented exemption).
- [ ] Retention periods set for raw and processed data, with automated deletion.
- [ ] Access, deletion and objection requests can be fulfilled by subject identifier.
- [ ] DPIA done for large-scale or sensitive processing.
- [ ] US: CCPA "publicly available" analysis, Delete Act and biometric law checks.

## See Also

- [Legal Landscape Overview](legal-landscape-overview.md)
- [International Considerations](international-considerations.md)
- [Ethical Scraping Checklist](ethical-scraping-checklist.md)
- [Provenance and Lineage](../data-quality/provenance-and-lineage.md)
- [Social Media](../sources/social-media.md)
- [Reviews and Forums](../sources/reviews-and-forums.md)
