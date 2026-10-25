# Dashboards

The harness turns datasets, SQL results and workspace files into interactive dashboards that a
researcher or analyst can navigate without help. Each dashboard is one self-contained HTML file:
no server calls, no CDN, no tracking. It opens from a Discord attachment, the harness web port
or any static host, and keeps working offline.

## What readers get

- **KPI tiles** with automatic compact numbers, a change against the previous period (with an
  icon and words, never color alone) and a sparkline.
- **Charts** that read as one system: line and area (crosshair tooltip listing every series,
  arrow keys, drag across to zoom into a time range), bars (click to filter, top 20 by default,
  horizontal for long labels), scatter plots (log axes, least squares trend with r), histograms
  (log bins for skewed data, a labeled tail bar for outliers, the median marked), heatmaps and
  pivot tables with totals.
- **Cross-filtering.** One filter row (date range presets and a custom range, select lists with
  counts, numeric ranges, search with `/` to focus) plus chips for every click on a bar, cell or
  facet. Every component bound to the same data agrees, and "Clear all filters" resets.
- **Faceted navigation** like a library catalog: counts per value that update with every other
  filter but never with their own selection, so the alternatives stay visible.
- **A data table** with sorting (largest or newest first), search, a column chooser, pagination,
  in-cell bars, safe links and link templates, and a drawer with every field of a row.
- **Column profiles** like a data-profiling report: type, fill rate, distinct values, range,
  shape (on a log scale when it spans orders of magnitude) and top values.
- **The link is the state.** Filters are kept in the URL fragment, so a shared link opens the
  same view.
- **Every chart has a table view** (its accessible twin) and exports to CSV, SVG and PNG; the
  table also copies rows as CSV or JSON. A Jupyter notebook next to each dashboard reloads the
  same data with pandas and DuckDB.
- **Light and dark** themes (following the system, or switched by the reader) and a layout that
  works at phone width.

## How dashboards get built

| Route              | How                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Ask an agent       | `/ask task:"Dashboard of PyPI releases by package"` or `harness run "..."`                 |
| A specialist agent | `agents/dashboard-builder.md` (the analyst delegates larger ones to it)                    |
| A spec file        | `harness dashboard build specs/sales.yaml`                                                 |
| Explorers          | `harness explore <dataset>` or `/dashboard explore dataset:<name>`                         |
| Automatically      | With `dashboards.autoExplore`, the first scrape that writes a dataset creates its explorer |

Agents use two tools: `profile_data` (types, fill rates, ranges, top values and component
suggestions for a dataset, query or file) and `build_dashboard` (publishes a spec). The
`build-dashboard` skill teaches the workflow and design rules; its `reference.md` documents every
component and option, and `examples/release-tracker.yaml` is a complete example.

Dashboards whose spec says `refresh: on-new-data` (the default) are rebuilt after every scrape
that adds records to a dataset they read, so a scheduled scraper keeps its dashboards current.

## The spec

```yaml
title: Sales by region
data:
  sales: { file: reports/sales.csv, columns: { amount: { label: Amount, format: 'currency:EUR' } } }
filters:
  - { type: daterange, field: closed_at }
  - { type: select, field: region }
items:
  - { type: kpi, title: Revenue, value: sum(amount), delta: { field: closed_at, period: 30d } }
  - {
      type: line,
      x: { field: closed_at, interval: week },
      y: sum(amount),
      series: { field: region },
      width: 8,
    }
  - { type: facets, fields: [region, product], width: 4 }
  - { type: table, columns: [closed_at, region, product, { field: amount, bar: true }] }
```

Specs are validated twice: against the schema (unknown keys, formats and component types are
errors with the allowed values listed) and against the data (unknown fields list the real
columns with their types; a mean over text is refused). Agents get the full list of fixes in one
tool result.

## Serving and access

The web port (`PORT`, default 8080) serves `/healthz`, the catalog at `/dashboards/` (every
dashboard and dataset, with explorer links) and each dashboard at `/dashboards/<slug>/`. Only the
four files the service writes per dashboard can be fetched (`index.html`, `meta.json`,
`spec.json`, `notebook.ipynb`).

The compose file binds the port to the host's loopback. Pick one way to reach it:

- **SSH tunnel** (nothing to configure): `ssh -L 8080:127.0.0.1:8080 you@server`, then open
  `http://localhost:8080/dashboards/`.
- **Tailscale** or another private network: bind the port to the tailnet address instead of
  `127.0.0.1`.
- **A TLS proxy** for a public URL: set `DASHBOARD_PASSWORD` (basic auth for everything except
  the bare health check; compared in constant time) and put Caddy or another proxy with HTTPS
  in front. Basic auth without TLS sends the password in the clear.

Set `DASHBOARD_PUBLIC_URL` (for example `https://harness.example.com`) so tool results and
Discord replies carry full links. `/dashboard get` and `/dashboard explore` attach the HTML file
itself when it is under 8 MB, which works without exposing any port.

## Security model

- Pages carry a strict Content Security Policy (`default-src 'none'`, inline script and style
  only, `connect-src 'none'`): a dashboard cannot load or send anything.
- The data sits in a JSON script block with `<`, `>`, `&`, U+2028 and U+2029 escaped, so a value
  such as `</script>` cannot end the block. Every label and value is inserted as text, never as
  HTML; markdown notes are rendered on the server to a small safe subset with `https` links only.
- The web server adds `nosniff`, `no-referrer`, a same-origin opener policy and the CSP as
  headers, answers only GET and HEAD, and validates slugs and file names against a whitelist.
- `build_dashboard` is a write: read-only runs cannot publish, and approvals apply like any
  other write. Agents see published dashboards read-only under `dashboards/`.
- The data is embedded in the page. Share a dashboard like you would share its data.

## Reusable components

Everything is built from a small set of parts that new components reuse:

| Layer                         | Where                                                        | What                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure cores (Node and browser) | `src/dashboards/core/`                                       | Time buckets, type inference, aggregates, filters, formats, scales, bins, pivots, series colors, palette and theme tokens                             |
| Spec and validation           | `src/dashboards/spec.ts`, `validate.ts`                      | zod schema and data checks with readable messages                                                                                                     |
| Rendering                     | `src/dashboards/render.ts`                                   | One HTML file, or a fragment for hosts that wrap pages                                                                                                |
| Browser runtime               | `ui/main.ts`, `ui/store.ts`                                  | The app, the filter store (one per page) and URL state                                                                                                |
| Building blocks               | `ui/card.ts`, `ui/chart.ts`, `ui/overlay.ts`, `ui/export.ts` | Cards with table views, the `ChartComponent` base class (resizing, empty and error states, legends, axes, exports), tooltips, popovers, menus, toasts |
| Components                    | `ui/components/`                                             | One file per component type                                                                                                                           |

To add a component type: add its schema to `spec.ts` and its field checks to `validate.ts`,
then write `ui/components/<type>.ts` (extend `ChartComponent` for charts and implement `draw` and
`tableData`), register it in `ui/main.ts`, document it in the skill's `reference.md`, and cover it
in `tests/dashboards` and `e2e/`.

## Design rules built in

- One categorical palette, validated for color vision deficiency in light and dark mode, assigned
  in a fixed order and never cycled. A value keeps its color in every chart of the page, because
  slots follow each value's rank over the whole dataset, not the chart's own ranking.
- At most 8 series; the rest fold into a gray "Other". Scatter plots take 3.
- One axis per chart, thin marks (bars at most 24 px with 4 px rounded data ends, 2 px lines,
  2 px gaps), recessive hairline grids, and text in ink colors, never in series colors.
- Sequential cells use one hue, light to dark, with readable text on both ends.
- Sizes use SI units (1 kB = 1000 B) so log-axis ticks land on round numbers.

## Limits

`dashboards.maxMb` (default 25) caps the file size. Data sources embed at most `limit` rows
(default 50,000). For more, aggregate in SQL to the grain the charts need; the build warns when a
source was truncated.

## Tests

`tests/dashboards/` covers the cores, specs, validation, loading, rendering (including script
injection), the notebook and the service; `tests/app/http.test.ts` the web server and auth;
`tests/tools/dashboard-tools.test.ts` the tools. `npm run test:e2e` drives a real Chromium
through filters, facets, brushing, tooltips, sorting, the row drawer, the table view, URL state,
dark mode and phone width.
