---
tags: [scraping, apis, mobile-apps, legal-risk, terms-of-service]
aliases: [mobile API, app API, private API, app backend, certificate pinning, app attestation]
---

# Mobile App APIs

> Sources: Android Developers, Network security configuration (https://developer.android.com/privacy-and-security/security-config); Android Developers, Play Integrity API (https://developer.android.com/google/play/integrity); Apple Developer Documentation, DeviceCheck and App Attest (https://developer.apple.com/documentation/devicecheck); 17 U.S.C. § 1201, Circumvention of copyright protection systems (https://www.law.cornell.edu/uscode/text/17/1201); US Copyright Office, Section 1201 rulemaking (https://www.copyright.gov/1201/); Directive 2009/24/EC on the legal protection of computer programs, Article 6 (https://eur-lex.europa.eu/eli/dir/2009/24/oj); GTFS, General Transit Feed Specification (https://gtfs.org/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Mobile apps are thin clients over backend APIs, and those APIs sometimes expose data the website does not. That makes them tempting, and it is why this article is mostly about *not* going there by default. App APIs are private interfaces built for one client: they sit behind app-specific authentication, device registration, signed requests, **certificate pinning** and **app attestation** (Google Play Integrity, Apple App Attest), and the app's license usually forbids reverse engineering and automated access. Defeating those controls can breach contract, and in the US can run into the anti-circumvention rules of 17 U.S.C. § 1201 and computer-misuse law; the EU allows decompilation only for narrow interoperability purposes. This vault does not cover bypassing pinning, attestation, obfuscation or authentication. The productive path is almost always elsewhere: the same data on the website, an official or partner API, an open-data feed, a licensed dataset, or simply asking the company.

## Why app APIs are different from websites

| | Public website | Mobile app backend |
|---|---|---|
| Intended audience | anyone with a browser | the vendor's own app |
| Terms | often browsewrap | EULA or clickwrap accepted at install or login |
| Authentication | often none for public pages | device tokens, first-party OAuth clients, embedded keys |
| Integrity checks | sometimes bot management | request signing, pinning, attestation, root or jailbreak detection |
| Data | what the page shows | frequently per-user, location-aware, with extra fields |
| Stability | changes with redesigns | versioned per app release; old versions forced to upgrade |
| Legal exposure | lower | higher: contract, anti-circumvention, misuse, privacy |

Pinning and attestation exist precisely to make the API usable only by the genuine app. Treat them the way you treat a login wall: as the operator's explicit "no" to third-party clients.

## A better order of operations

1. **Is the data on the web?** Many apps share a backend with the website or mobile web; the browser route is easier to inspect, usually covered by clearer terms, and documented in [Finding Hidden APIs with DevTools](finding-hidden-apis.md).
2. **Is there an official API or developer program?** Check the vendor's developer portal, partner programs, research access programs and data licensing offers ([Social Media](../sources/social-media.md), [Catalog of Useful Open APIs](official-apis-catalog.md)).
3. **Is there open data behind the app?** Whole app categories are front ends to public feeds: transit apps read GTFS and GTFS Realtime feeds that agencies publish, weather apps read national meteorological services, and many civic apps read government open-data portals ([Government and Open Data Portals](../sources/government-open-data.md)).
4. **Can you license it?** Aggregators and data vendors often sell exactly the dataset an app displays, with rights you can rely on.
5. **Can you ask?** A short email explaining who you are, what you need and how gently you will collect it gets more access than people expect ([Ethical Scraping Checklist](../legal-ethics/ethical-scraping-checklist.md)).

## What observation can and cannot mean

Developers routinely inspect the traffic of apps they build or test, using debug builds and proxies they control. For third-party apps the platform itself limits this: since Android 7.0, apps that target API level 24 or higher no longer trust user-installed certificate authorities unless they opt in through their network security configuration, so a debugging proxy on your own phone simply sees encrypted traffic it cannot read. That default, and any pinning on top of it, is a design decision by the app's developer. Modifying the app, its configuration or the device to get around it is circumvention and is out of scope here. If an app's traffic is not readable with ordinary tools, take that as the answer and go back to the list above.

## Legal and terms cautions (not legal advice)

- **License terms.** App EULAs and service terms commonly prohibit reverse engineering, decompiling, scraping and use of non-official clients; you accept them when you install, register or log in ([Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)).
- **Anti-circumvention.** In the US, § 1201 prohibits circumventing technological measures that control access to copyrighted works, including software; the Copyright Office grants narrow, time-limited exemptions (for example for good-faith security research) through a triennial rulemaking, and these do not cover routine data collection.
- **EU interoperability exception.** Article 6 of Directive 2009/24/EC permits decompilation only when indispensable to achieve interoperability of an independently created program, under strict conditions; it is not a data-collection exception.
- **Computer misuse.** Using credentials, keys or tokens that were not issued to you for that purpose is the clearest route to "unauthorized access" claims ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)).
- **Personal data.** App APIs carry device identifiers, precise locations and account data; data-protection law applies whatever the access route ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- **Account risk.** Automating an app with your personal account can get the account banned and expose your own data.

## Code: use the open feed instead

Transit data is the canonical case: agencies publish their schedules as static GTFS feeds (a zip of CSV files) and real-time positions as GTFS Realtime, which is what the apps themselves consume. Tested with Python 3.11 and `httpx` against a generated feed:

```python
import csv
import io
import zipfile

import httpx


async def gtfs_table(client: httpx.AsyncClient, feed_url: str, table: str = "stops.txt") -> list[dict]:
    """Download a static GTFS feed (a zip of CSV files) and return one table as dicts."""
    r = await client.get(feed_url, follow_redirects=True)
    r.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        with z.open(table) as f:
            return list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig")))
```

Find feeds through the agency's open-data page or a feed directory listed on gtfs.org; GTFS Realtime feeds are Protocol Buffers and are read with the official bindings.

## Pitfalls

- Assuming an API is fair game because the app is free or the data looks public.
- Extracting API keys or client secrets from an app and using them in your own client.
- Building a pipeline on an app API that breaks at the next forced app update.
- Running automation under your personal account.
- Collecting device identifiers, locations or other personal fields you do not need.
- Skipping the web, official API, open data and licensing routes because the app seemed faster.

## Checklist

- [ ] Website, official API, partner program, open data and licensing options checked first.
- [ ] App license and service terms read; no clause prohibits the intended use.
- [ ] No circumvention of pinning, attestation, obfuscation, signing or authentication.
- [ ] No use of credentials or keys not issued to you for this purpose.
- [ ] Personal data minimized; legal review for anything beyond public, non-personal data.
- [ ] Contact with the vendor considered and documented.

## See Also

- [Finding Hidden APIs with DevTools](finding-hidden-apis.md)
- [Catalog of Useful Open APIs](official-apis-catalog.md)
- [Choosing an Acquisition Strategy](../fundamentals/scraping-decision-framework.md)
- [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md)
- [Terms of Service and Contracts](../legal-ethics/terms-of-service-and-contracts.md)
- [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)
