---
tags: [scraping, data-quality, monitoring, observability, great-expectations]
aliases: [Data observability, DQ checks, Freshness monitoring, Null rate monitoring, Data drift]
---

# Data Quality Monitoring

> Sources: Great Expectations (GX Core) documentation (https://docs.greatexpectations.io); SciPy, scipy.stats.ks_2samp (https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.ks_2samp.html); dbt documentation, source freshness (https://docs.getdbt.com/docs/deploy/source-freshness); Soda documentation (https://docs.soda.io/); Pandera documentation (https://pandera.readthedocs.io/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A scraper that exits with status 0 can still deliver garbage: half the rows, prices in the wrong currency, every title empty because a class name changed, or yesterday's data because the job silently stopped. **Monitor the data, not just the job.** After every run, compute a small set of metrics per dataset (freshness, volume, completeness, validity, uniqueness, distribution and schema drift) and compare them with that dataset's **own recent history**, not with fixed constants. Failed checks should block publishing and route to breakage triage, because for scrapers most data anomalies are site changes or blocks, not real-world events.

## What to measure

| Metric | How to compute | Typical alert | Usual scraper cause |
|---|---|---|---|
| Freshness | now minus newest `fetched_at` | Older than schedule plus grace | Scheduler stopped, job crashing, blocked |
| Volume | rows per run | Below half the recent median, or robust z beyond 5 | Pagination broke, block page, partial outage |
| Completeness | null or empty rate per field | Doubles, or rises 5 points over baseline | Selector broke, lazy-loaded content |
| Validity | schema failure rate | Above 2 to 5 percent | Format change, placeholder values |
| Uniqueness | distinct keys over rows | Drops below 1.0 | Pagination overlap, missing upserts |
| Distribution drift | KS test or PSI vs recent runs | p below 0.001 or PSI above 0.25 | Currency or locale switch, unit change |
| Schema drift | new or missing keys in raw JSON | Any change | Upstream API version change |
| Change rate | share of records that changed | Far above normal | Redesign or parser regression |

## Computing metrics in SQL

The same query runs on PostgreSQL, DuckDB and SQLite, and gives one row of metrics per run:

```sql
SELECT run_id,
       COUNT(*) AS row_count,
       AVG(CASE WHEN price IS NULL THEN 1.0 ELSE 0.0 END) AS price_null_rate,
       AVG(CASE WHEN title IS NULL OR title = '' THEN 1.0 ELSE 0.0 END) AS title_null_rate,
       COUNT(DISTINCT natural_key) * 1.0 / COUNT(*) AS key_uniqueness,
       MAX(fetched_at) AS newest_fetch
FROM observations
GROUP BY run_id
ORDER BY newest_fetch DESC
LIMIT 15;
```

Store these rows in a `run_metrics` table; the history is your baseline, and plotting it makes slow decay visible.

## A dependency-light monitor

Compare the latest run with previous runs using medians and the median absolute deviation (MAD), which a single bad day cannot distort the way a mean and standard deviation can:

```python
from datetime import datetime, timedelta
from statistics import median

from scipy.stats import ks_2samp


def null_rate(rows: list[dict], field: str) -> float:
    if not rows:
        return 1.0
    return sum(1 for r in rows if r.get(field) in (None, "")) / len(rows)


def robust_z(value: float, history: list[float]) -> float:
    med = median(history)
    mad = median(abs(x - med) for x in history)
    if mad == 0:
        return 0.0 if value == med else float("inf")
    return 0.6745 * (value - med) / mad


def check_run(current: list[dict], history: list[list[dict]], *, now: datetime,
              max_age=timedelta(hours=26), fields=("title", "price"), numeric="price") -> list[str]:
    alerts = []
    newest = max((datetime.fromisoformat(r["fetched_at"]) for r in current), default=None)
    if newest is None or now - newest > max_age:
        alerts.append(f"freshness: newest record {newest} older than {max_age}")
    counts = [len(h) for h in history]
    if len(counts) >= 5:
        z = robust_z(len(current), counts)
        if len(current) < 0.5 * median(counts) or abs(z) > 5:
            alerts.append(f"volume: {len(current)} rows vs median {median(counts)} (robust z={z:.1f})")
    for field in fields:
        rate = null_rate(current, field)
        base = median(null_rate(h, field) for h in history) if history else 0.0
        if rate > max(2 * base, base + 0.05):
            alerts.append(f"nulls: {field} null rate {rate:.1%} vs baseline {base:.1%}")
    cur = [float(r[numeric]) for r in current if r.get(numeric) not in (None, "")]
    ref = [float(r[numeric]) for h in history[-3:] for r in h if r.get(numeric) not in (None, "")]
    if len(cur) >= 50 and len(ref) >= 50:
        res = ks_2samp(cur, ref)
        if res.pvalue < 0.001:
            alerts.append(f"drift: {numeric} distribution changed (KS={res.statistic:.2f})")
    return alerts
```

On a simulated week of about 1,000 rows per day, a healthy run returns `[]`, while a broken run with 310 rows, a third of prices missing and prices scaled by 100 returns volume, null-rate and drift alerts. Use timezone-aware timestamps throughout (`datetime.fromisoformat` accepts a trailing `Z` from Python 3.11).

Schema drift in raw API payloads is a set comparison:

```python
def key_drift(rows: list[dict], baseline_keys: set[str]) -> dict:
    seen = set().union(*(r.keys() for r in rows)) if rows else set()
    return {"new": sorted(seen - baseline_keys), "missing": sorted(baseline_keys - seen)}

print(key_drift([{"id": 1, "price": 2, "priceV2": {}}], {"id", "price", "title"}))
# {'new': ['priceV2'], 'missing': ['title']}
```

## With Great Expectations (GX Core 1.x)

GX expresses checks as declarative expectations, keeps them in suites and produces readable validation results:

```python
import great_expectations as gx
import pandas as pd

df = pd.DataFrame({"sku": ["AB-1", "AB-2", "AB-3", "AB-3"], "price": [24.5, None, 19.0, 19.0],
                   "currency": ["EUR", "EUR", "USD", "USD"]})

context = gx.get_context(mode="ephemeral")
batch = (context.data_sources.add_pandas(name="scrapes")
         .add_dataframe_asset(name="listings")
         .add_batch_definition_whole_dataframe(name="latest_run")
         .get_batch(batch_parameters={"dataframe": df}))

suite = context.suites.add(gx.ExpectationSuite(name="listings_quality"))
suite.add_expectation(gx.expectations.ExpectTableRowCountToBeBetween(min_value=3, max_value=10_000))
suite.add_expectation(gx.expectations.ExpectColumnValuesToNotBeNull(column="price", mostly=0.95))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeBetween(column="price", min_value=0.01, max_value=100_000))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeUnique(column="sku"))
suite.add_expectation(gx.expectations.ExpectColumnValuesToBeInSet(column="currency", value_set=["EUR", "USD", "GBP"]))

result = batch.validate(suite)
print(result.success)  # False: one null price (75% < 95%) and a duplicate SKU
for r in result.results:
    print(r.expectation_config.type, r.success)
```

Static bounds like `min_value=3` are where GX needs help: compute them from your `run_metrics` history before each run. Alternatives with similar ideas: Soda (checks written in YAML), dbt tests and `dbt source freshness` when data lands in a warehouse, and Pandera for DataFrame schemas in Python.

## Turning checks into decisions

- **Severity:** freshness and volume failures page someone; drift and small null-rate rises go to a daily digest.
- **Gate publishing:** write to a staging table, run checks, then swap or merge into the published table only if they pass.
- **Attach evidence:** each alert links the run id, sample failing records, raw captures and the previous good run ([Logging and Observability](../operations/logging-and-observability.md)).
- **Classify the cause:** blocked (403, 429, challenge pages), site changed (selectors return nothing), source changed (real-world shift), or pipeline bug. Breakage goes to [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md).
- **Mind seasonality:** compare Mondays with Mondays for weekly patterns, and require minimum sample sizes before drift tests.

## Pitfalls

- **Fixed thresholds forever.** "At least 500 rows" stops meaning anything once the catalog doubles.
- **Mean and standard deviation baselines** that one outage drags down, hiding the next one.
- **Checking only the job exit code.** Block pages return 200 and parse into empty records.
- **Alerting on everything.** Untriaged noise trains people to mute the channel.
- **Drift tests on tiny samples,** which flag randomness, or on huge ones, where every trivial difference is significant; pair p-values with effect size (the KS statistic or PSI).
- **Monitoring after publishing,** when consumers have already used the broken batch.

## Checklist

- [ ] Freshness, volume, null rate, validity and uniqueness computed for every run.
- [ ] Metrics stored per run to form a baseline; thresholds derived from history.
- [ ] Robust statistics (median, MAD) used for volume and rates.
- [ ] Drift checks on key numeric and categorical fields with minimum sample sizes.
- [ ] Schema drift detection on raw upstream JSON.
- [ ] Failed checks block publishing and attach evidence to the alert.
- [ ] Alerts routed by severity, with breakage sent to the repair workflow.

## See Also

- [Monitoring and Alerting](../operations/monitoring-and-alerting.md)
- [Schema Validation](schema-validation.md)
- [Change Detection and Diffing](change-detection-and-diffing.md)
- [Testing Scrapers](testing-scrapers.md)
- [Maintenance and Breakage Response](../operations/scraper-maintenance-and-breakage.md)
- [Logging and Observability](../operations/logging-and-observability.md)
