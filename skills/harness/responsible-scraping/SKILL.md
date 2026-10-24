---
name: responsible-scraping
description: Pre-flight legal and ethical check before collecting data from any website or API. Use before building a new scraper or bulk-fetching pages, and whenever a task involves personal data, logins, paywalls or bot protection.
---

# Responsible scraping pre-flight

Answer each question; stop and report if any answer is "no" or "unknown".

1. Is there an official API, bulk download or licensed dataset? Use it instead.
2. Does robots.txt allow the paths (for this harness's User-Agent)? Is there a crawl-delay?
3. Do the terms of use allow automated access for this purpose?
4. Is the data public without a login, paywall or other access control?
5. Does the data include personal data? Collect only the fields needed, and only if there is a
   lawful basis (see `knowledge/wiki/legal-ethics/personal-data-gdpr-ccpa.md`).
6. Is the request rate gentle enough that the site would not notice (one request per second or
   slower for HTML, the published limit for APIs)?
7. Will the data be used in a way that respects copyright (facts and analysis, not republishing
   full articles)?

Read `knowledge/wiki/legal-ethics/ethical-scraping-checklist.md` for the full checklist. This is
not legal advice; escalate uncertain cases to a human.
