---
tags: [scraping, sources, real-estate, mls, licensing]
aliases: [property listings, MLS data, housing data, RESO Web API]
---

# Real Estate Listings

> Sources: RESO, Web API and Data Dictionary standards (https://www.reso.org/); National Association of REALTORS, Handbook on Multiple Listing Policy (https://www.nar.realtor/about-nar/policies/handbook-on-multiple-listing-policy); Zillow Research data downloads (https://www.zillow.com/research/data/); Redfin Data Center (https://www.redfin.com/news/data-center/); HM Land Registry, Price Paid Data (https://www.gov.uk/government/statistical-data-sets/price-paid-data-downloads); US Copyright Office fair use summary, VHT, Inc. v. Zillow Group, Inc., 918 F.3d 723 (9th Cir. 2019) (https://www.copyright.gov/fair-use/summaries/vhtinc-zillowgroup-9thcir2019.pdf); Craigslist Inc. v. 3Taps Inc. (N.D. Cal. 2013)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Real estate listing data is licensed data. In the US almost every for-sale listing originates in a Multiple Listing Service (MLS), and portals display it under license agreements with MLSs and brokers. Listing photos and descriptions are copyrighted, MLS compilations are protected by contract, and portals forbid scraping in their terms. The lawful routes are: a data license from the MLS (feeds delivered through the RESO Web API), portal partner programs for approved uses, public property records from government offices, and open aggregate statistics. Scraping a portal to rebuild its listing database is the classic way to end up in court.

## Acquisition routes

1. **MLS feeds.** MLSs provide data to members and licensed vendors through IDX (Internet Data Exchange, display of other brokers' listings on a broker's site), VOW (Virtual Office Website, logged-in consumer access) and broker back-office or analytics feeds. Policies come from the MLS and, for REALTOR-owned MLSs, the NAR multiple listing policy handbook. RESO publishes the standards but holds no listing data and grants no access: credentials come from a license with each MLS.
2. **Portal programs.** Zillow's listing and property APIs run through its Bridge platform and are approved per MLS or per use case. Other portals have similar partner programs. Their terms prohibit scraping and automated querying of the consumer sites.
3. **Public records.** County assessor (parcel characteristics, assessed values) and recorder (deeds, mortgages) offices publish data through portals, bulk downloads or paid extracts. Formats and terms vary county by county. In England and Wales, HM Land Registry publishes Price Paid Data of residential sales under the Open Government Licence v3.0, with a caveat: the address fields derive from Royal Mail and Ordnance Survey products and are licensed for personal or non-commercial use and for displaying residential price information; other uses need Royal Mail's permission.
4. **Aggregate market data.** Zillow Research publishes indices such as ZHVI (home values) and ZORI (rents) as free CSV downloads for public use with clear attribution; Zillow notes that download paths change from time to time. Redfin's Data Center publishes market metrics downloads. National statistics offices publish house price indices. If your question is about markets rather than individual listings, start here.

## RESO Web API in practice

The RESO Web API is a profile of OData 4, and the RESO Data Dictionary standardizes resource and field names (`Property`, `Member`, `Office`, `Media`; fields such as `ListingKey`, `ListPrice`, `StandardStatus`, `City`, `PostalCode`, `ModificationTimestamp`). Vendors are moving to Data Dictionary 2.0. With a license, incremental replication looks like this:

```python
import httpx

def replicate(service_root: str, token: str, since_iso: str):
    """Yield Property records modified after since_iso (e.g. '2026-10-01T00:00:00Z')."""
    url = f"{service_root}/Property"
    params = {
        "$filter": f"ModificationTimestamp gt {since_iso}",
        "$select": "ListingKey,StandardStatus,ListPrice,City,PostalCode,ModificationTimestamp",
        "$orderby": "ModificationTimestamp asc",
        "$top": "200",
    }
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    with httpx.Client(headers=headers, timeout=60) as client:
        while url:
            r = client.get(url, params=params)
            r.raise_for_status()
            body = r.json()
            yield from body.get("value", [])
            url, params = body.get("@odata.nextLink"), None  # server-driven paging
```

Persist the highest `ModificationTimestamp` you processed and resume from it; fetch `Media` records separately, only if your license covers photo use. Each MLS sets its own limits on requests and records per page, so read the vendor documentation.

## Data model

- **Separate the property, the listing and the transaction.** One parcel can have many listings over the years, and a listing can be withdrawn and relisted under a new key.
- **Status history:** `StandardStatus` values such as Active, Pending, Closed, Withdrawn and Expired, with timestamps. Days on market depends on whether relists reset the clock; store raw events and compute the metric.
- **Price history:** append-only observations, the same pattern as [E-commerce and Price Monitoring](ecommerce-and-prices.md).
- **Identity:** parcel number (APN) where available, otherwise a normalized address plus geocode. Units differ (square feet versus square meters, lot size in acres or square feet).
- **Compensation fields:** after the 2024 NAR settlement, offers of compensation to buyer brokers may no longer be communicated through the MLS (effective 17 August 2024), so older and newer records differ.

## Legal and ethical notes

- **Access after being told no.** In Craigslist v. 3Taps (N.D. Cal. 2013), the court held that continuing to access the site after a cease-and-desist letter and IP blocks, by switching IP addresses, could be unauthorized access under the CFAA. Treat blocks and demand letters as a stop sign. See [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md).
- **Photos are copyrighted.** In VHT v. Zillow (9th Cir. 2019), Zillow was not liable as a direct infringer for hosting photos that users uploaded, but its own tagging and cataloging of listing photos for a searchable home-design feature was direct infringement and not fair use. Do not copy listing photos or descriptions into your own product.
- **Personal data.** Owner names and mailing addresses in public records, agent contact details and tenant information are personal data. Public availability does not remove privacy obligations ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).
- **Housing law.** Using property data for advertising, lending or tenant screening touches fair housing and consumer reporting law in the US (tenant screening reports are regulated consumer reports). Avoid features that proxy for protected characteristics.

## Pitfalls

- Treating a portal's "estimate" as observed data; it is a model output with its own license.
- Duplicate listings for the same home across brokers and MLSs; deduplicate on parcel or normalized address ([Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)).
- Address normalization and geocoding errors (unit numbers, rural routes); see [Maps and Local Business Data](maps-and-local-business.md).
- Sold prices are not public in every US state or every country; missing values are not zeros.
- Aggregate CSV schemas and download paths change between releases; validate headers on every download.
- County portals are often fragile; download bulk files at off-peak times instead of paging search results.

## Checklist

- [ ] Clear which route applies: MLS license, portal program, public records or aggregates.
- [ ] License terms cover the fields, photos, retention and display you intend.
- [ ] No portal scraping; blocks and cease-and-desist letters honored.
- [ ] Property, listing and transaction modeled separately with status and price history.
- [ ] Attribution and address-data restrictions applied for open datasets.
- [ ] Personal data minimized; housing-law implications reviewed for the use case.

## See Also

- [Legal Landscape Overview](../legal-ethics/legal-landscape-overview.md)
- [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)
- [Copyright and Database Rights](../legal-ethics/copyright-and-database-rights.md)
- [Government and Open Data Portals](government-open-data.md)
- [Maps and Local Business Data](maps-and-local-business.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
