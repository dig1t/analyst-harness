# Dashboard spec reference

A spec is YAML or JSON. Unknown keys are rejected, so a typo comes back as an error naming the
key. Fields marked (default ...) may be left out.

## Top level

| Key           | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `title`       | Page title (required, at most 120 characters)                                    |
| `description` | One or two sentences under the title: what the page is for                       |
| `slug`        | URL name, `a-z0-9-` (default: from the title). The same slug replaces the page   |
| `data`        | Named sources, 1 to 20 (see below)                                               |
| `filters`     | Up to 8 page filters, shown in one row above everything (default none)           |
| `sections`    | Titled groups of components; or give `items:` for one untitled section           |
| `sources`     | Free-text provenance lines shown in the footer                                   |
| `refresh`     | `on-new-data` (default): rebuilt after scrapes that add records; or `manual`     |
| `theme`       | `auto` (default), `light` or `dark`; readers can switch                          |
| `locale`      | Number and date formatting, such as `en-US` (default) or `de-DE`                 |

A section is `{ title, description, items: [...] }`.

## Data sources

Give exactly one of `dataset`, `sql`, `file` or `values`, plus:

| Key           | Meaning                                                                       |
| ------------- | ----------------------------------------------------------------------------- |
| `limit`       | Most rows embedded (default 50,000; at most 200,000)                          |
| `description` | Shown in the "About this data" footer                                         |
| `columns`     | Per column: `label`, `format`, `description`, `type` (to override inference)  |

Column types are inferred: `number`, `integer`, `boolean`, `date`, `datetime`, `string`, `url`,
`json`. Override with `type` when inference guesses wrong (for example zip codes as `string`).

## Aggregates

Anywhere a value is computed (`value`, `y`): `count`, `sum(f)`, `mean(f)`, `median(f)`,
`min(f)`, `max(f)`, `distinct(f)`, `p10(f)`, `p90(f)`, `first(f)`, `last(f)`. The long form
`{ agg: last, field: rate, orderBy: date, label: Latest rate, format: decimal:4 }` adds an
order for `first`/`last`, a label and a format.

## Formats

`integer`, `number`, `decimal:N`, `percent[:N]` (0.25 shows as 25%), `compact` (12.9K),
`currency:EUR[:N]`, `bytes` (SI: 1 kB = 1000 B), `duration` (seconds), `date`, `datetime`,
`month`, `quarter`, `year`, `url`, `text`.

## Filters

| Type        | Keys                                                     | Reader sees                          |
| ----------- | -------------------------------------------------------- | ------------------------------------ |
| `daterange` | `field`, `label`, `default` (`all`, `today`, `7d`, `30d`, `90d`, `mtd`, `ytd`, `12m`) | Presets and a custom range |
| `select`    | `field`, `label`, `default` (list of values)             | A searchable checklist with counts   |
| `range`     | `field`, `label`                                         | Minimum and maximum inputs           |
| `search`    | `fields` (1 to 10), `placeholder`, `label`               | A text box (`/` focuses it)          |

Every filter takes `data` (a name or a list); by default it applies to every source that has
the field. Clicking a bar, a heatmap cell or a facet, or dragging across a time chart, adds a
filter chip too; all of it is kept in the page link.

## Components

Every component takes `title`, `subtitle`, `width` (1 to 12 grid columns), `data` (required
when there are several sources) and `id`.

### kpi

`value` (aggregate), `format`, `hero: true` (one large figure per page), `delta: { field,
period: 7d|30d|90d|week|month|quarter|year, goodDirection: up|down|neutral }` (compares the
latest period in view with the one before), `sparkline: { field, interval: day|week|month }`.
Default width 3.

### line, area

`x: { field, interval: auto|minute|hour|day|week|month|quarter|year, label, format }` (a date,
datetime or number), `y` (aggregate), `series: { field, top, label }`, `stack: true` (area),
`emphasis: <series value>` (draws the rest in gray), `reference: [{ value, label }]`, `height`.
Readers get a crosshair tooltip listing every series, arrow keys, and drag-to-zoom.

### bar

`x: { field, interval, sort: value-desc|value-asc|label|none, top, label, format }`, `y`
(aggregate), `series`, `stack: true`, `orientation: auto|horizontal|vertical`, `labels:
auto|always|never`, `emphasis`, `height`. Long labels switch to horizontal bars. Clicking a bar
filters the page.

### scatter

`x` and `y`: `{ field, label, format, scale: linear|log }`; `series` (at most 3), `label` (a
field shown as the tooltip title), `trend: true` (least squares, fitted on the log values on
log axes), `limit` (points drawn, default 5,000), `height`.

### histogram

`field`, `bins` (5 to 80), `scale: auto|linear|log` (auto uses log bins for positive data that
spans orders of magnitude; otherwise a few extreme values fold into a labeled last bar),
`label`, `format`, `height`. A median line is drawn.

### heatmap

`x` and `y` as in bar (time fields take an `interval`), `value` (aggregate), `format`,
`height`. Cells use one sequential hue with a legend; clicking a cell filters.

### pivot

`rows` and `columns` as in bar, `value` (aggregate), `format`, `heat: true` (shaded cells),
`totals: true` (row and column totals, re-aggregated from rows).

### table

`columns`: field names or `{ field, label, format, link, bar: true, width:
narrow|normal|wide }`. `link` is a URL field, or a template like
`https://news.ycombinator.com/item?id={id}`. `bar` draws an in-cell bar for numbers.
`pageSize: 10|25|50|100`, `sort: { field, direction }`, `search: true`, `details: true` (a
row drawer with every field). Readers can choose columns and copy or download rows.

### facets

`fields` (1 to 8), `limit` (values shown per field before "Show all", default 8). Counts
update with every other filter, never with their own selection.

### profile

`columns` (default: every column except scraper bookkeeping). One card per column: type, fill
rate, distinct values, range, shape and top values.

### markdown

`text`: a safe subset (headings, bold, italic, code, lists, quotes, tables, `https` links).
