---
name: data-quality-checks
description: Run a standard battery of data-quality checks on a dataset (freshness, volume, duplicates, nulls, ranges, drift) and summarize the problems. Use before trusting a dataset or when numbers look odd.
---

# Data-quality checks

Run each check with `sql_query` and record pass or fail with the number behind it.

| Check | Query idea | Fails when |
|---|---|---|
| Freshness | `max(_scraped_at)` | older than two schedule intervals |
| Volume | rows per day over the last 14 days | today is below half the median |
| Duplicates | `count(*) - count(DISTINCT _key)` among latest versions | above 0 |
| Nulls | `count(*) FILTER (WHERE col IS NULL) / count(*)` per required column | above 5% |
| Ranges | `min`, `max` of numeric columns | values outside plausible bounds |
| Drift | distinct values of a category column this week vs last week | new or vanished categories |

Then:

1. Summarize failures first, each with its figure.
2. For each failure suggest the likely cause (scraper breakage, source change, real-world change).
3. If the scraper looks broken, recommend `/scrape repair name:<scraper>`.

Search the vault for background: `search_knowledge("data quality monitoring")`.
