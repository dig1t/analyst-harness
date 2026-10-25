---
name: build-dashboard
description: Design and publish an interactive dashboard (KPI tiles, charts, filters, facets, a searchable table, column profiles) from scraped datasets, SQL or workspace files with build_dashboard. Use when asked for a dashboard, a report page, charts, or a way to explore or browse data.
---

# Build a dashboard

A dashboard is one self-contained HTML file: every chart has tooltips, a table view and CSV/PNG
exports, filters cross-filter the whole page and persist in the link, and it works offline.
The spec is YAML; `reference.md` documents every component and option, and
`examples/release-tracker.yaml` is a complete example to start from.

## Steps

1. **Write down the questions.** Three to five questions the reader needs answered (what
   changed, how much, compared with what, where, which records). Every component must answer
   one of them; anything that does not is noise.
2. **Profile each source** with `profile_data` (dataset, sql or file). Note the time column,
   the measures, the categories with few values, the null rates and the row count. Above about
   50,000 rows, aggregate in SQL (`sql:`) to the grain the charts need.
3. **Pick the form** for each question with the table below.
4. **Lay it out** on the 12-column grid: a KPI row first (3 or 4 tiles, width 3), then the main
   chart (width 8 to 12, with `facets` at width 4 beside it when people browse), supporting
   charts in pairs (width 6), the record table (width 12), then notes and profiles.
5. **Write the spec** to `dashboards-src/<slug>.yaml` in your workspace (keep it: you edit and
   rebuild from it) and call `build_dashboard(spec_path="dashboards-src/<slug>.yaml")`.
6. **Fix and rebuild.** Errors come back as a list (unknown field, wrong type, ambiguous data);
   fix them all. Read every warning (truncated data, folded series) and decide.
7. **Verify** the headline figures: recompute each KPI with `sql_query` and compare.
8. **Report** the link or file path, what each section shows, the data window and caveats.

## Choosing the form

| Question                             | Component                                                     |
| ------------------------------------ | ------------------------------------------------------------- |
| A headline number and its change     | `kpi` with `delta` (and a `sparkline`)                        |
| Change over time                     | `line`; `area` with `stack: true` for parts of a whole        |
| Compare categories                   | `bar` (horizontal for long labels; the top 20 by default)     |
| Distribution of one measure          | `histogram` (a log axis is chosen for skewed positive data)   |
| Relationship between two measures    | `scatter` (log axes for sizes, money, counts; `trend: true`)  |
| Two categorical dimensions           | `heatmap`, or `pivot` when exact numbers matter               |
| Records to browse                    | `table` with links and data bars, `facets` beside it          |
| Data quality and coverage            | `profile`                                                     |
| Definitions, method, caveats         | `markdown`                                                    |

## Design rules

- **One axis per chart.** Never put two measures with different units on one chart; make two
  charts side by side.
- **Few series.** At most 8, and the rest fold into "Other"; 3 to 5 read best, so set
  `series.top`. Scatter plots take at most 3.
- **Colors are automatic** and follow each value across every chart on the page, so "Parser"
  has the same hue everywhere. There is no color option on purpose.
- **Titles carry the point**, subtitles the unit, filter or source: "Releases per quarter" with
  "Stacked by library category".
- **Formats once.** Set `format` and `label` per column under `data.<name>.columns` (`bytes`,
  `currency:EUR`, `percent:1`, `duration`, `date`); every component then uses them.
- **Robust aggregates.** Prefer `count`, `sum` and `median` over `mean` for skewed data; use
  `p90` for latency-like measures.
- **Filters in one row:** the date range first, then a `select` on the dimension people slice
  by most, then a `search` over text columns.
- **Traceable numbers.** Include a table of the underlying records (or the aggregated rows)
  and list `sources:` with where and when the data was collected.

## Data sources

- `dataset: <name>` reads a scraped dataset (newest rows up to `limit`, default 50,000). With
  `refresh: on-new-data` (the default) the harness rebuilds the dashboard after every scrape
  that adds records.
- `sql: "..."` runs DuckDB over workspace files and `datasets/<name>/*.jsonl`. Aggregate here.
- `file: reports/x.csv` reads a workspace file (.csv, .tsv, .json, .jsonl, .parquet).
- `values: [...]` embeds a small table you computed.

## Verification

- `build_dashboard` returned no errors and you acted on every warning.
- Each KPI matches an independent `sql_query`.
- Every component answers one of the questions from step 1.

## Pitfalls

- With several data sources, every component needs `data: <name>`.
- Yes/no columns: `sum(flag)` counts the yes rows; `mean(flag)` with `format: percent` is the
  share.
- A "truncated" warning means totals cover only the embedded rows: aggregate in SQL instead.
- Dates must be ISO dates or timestamps; text like "Oct 3" is a string. Fix it in SQL.
- Columns starting with `_` are scraper bookkeeping (`_scraped_at`, `_change`); profiles and
  explorers hide them, and they are rarely worth charting.
