---
tags: [scraping, tools, cli, curl, jq]
aliases: [command line scraping, curl, wget, jq, htmlq, pup, xidel, yq, shell pipelines]
---

# Command-Line Tools

> Sources: curl man page (https://curl.se/docs/manpage.html) and Everything curl (https://everything.curl.dev/); GNU Wget manual (https://www.gnu.org/software/wget/manual/wget.html); jq manual (https://jqlang.org/manual/); htmlq (https://github.com/mgdm/htmlq); pup (https://github.com/ericchiang/pup); Xidel (https://github.com/benibela/xidel); yq by Mike Farah (https://mikefarah.gitbook.io/yq/); gron (https://github.com/tomnomnom/gron)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A shell pipeline is the fastest way to explore a source and often good enough for a small scheduled job: `curl` fetches, `htmlq`, `pup` or `xidel` pull values out of HTML, `jq` reshapes JSON, `yq` handles YAML and XML, and `sort`, `uniq` and friends finish the job. Use the command line for reconnaissance, prototypes, one-off pulls and debugging production requests ("copy as cURL"). Move to code when you need per-item retries, state, validation or tests. The politeness rules do not change: identify yourself, pace requests, and respect robots.txt.

## The toolbox

| Tool | Does | Status (2026-10) | Notes |
|---|---|---|---|
| curl | HTTP client for everything | Very active (8.x) | Retries, rate limiting, conditional requests, parallel transfers |
| wget, wget2 | Download and recursive mirroring | Active | Respects robots.txt in recursive mode; writes WARC |
| jq | JSON query and transform | Active (1.8.x) | The standard JSON tool |
| yq (Mike Farah, Go) | YAML, JSON, XML, CSV, TOML | Active (v4.54) | Not the same as the Python `yq`, a jq wrapper with different flags |
| htmlq | CSS selectors over HTML | Low activity (latest release 0.4.0) | Like jq for HTML; Rust |
| pup | CSS selectors with display functions | Unmaintained (last release 2016) | Still works for simple tasks; Go |
| Xidel | XPath 3, XQuery, CSS, JSONiq, link following | Occasional updates (tagged 0.9.8, newer dev builds) | Most powerful HTML/XML CLI |
| gron | Flattens JSON into greppable lines | Stable | Great for finding where a value lives |
| xmllint | libxml2 parser with XPath | Stable | `xmllint --html --xpath '//title/text()' page.html` |
| xh, HTTPie | Friendlier HTTP clients | Active | Readable output while exploring APIs |
| Miller, csvkit, DuckDB CLI | CSV and JSON analytics | Active | Query results without writing code |

Basic request recipes, including "copy as cURL" from DevTools, are in [curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md). This article focuses on the options that matter for scraping.

## curl for scrapers

```bash
UA="acme-research-bot/1.0 (+https://acme.example/bot)"

# One polite fetch: fail on HTTP errors but keep the body, decompress, follow redirects, cap time
curl -sS --fail-with-body --compressed -L -A "$UA" --max-time 30 "https://books.toscrape.com/"

# Transient-error retries (timeouts, 408, 429, 500, 502, 503, 504, 522, 524), exponential from 1 s,
# honoring Retry-After; give up after 2 minutes in total
curl -sS --retry 3 --retry-max-time 120 -A "$UA" -o page.html "https://books.toscrape.com/"

# Pace a list of URLs: at most 30 transfer starts per minute (not effective with --parallel)
curl -sS --rate 30/m -A "$UA" -O "https://example.com/a.html" -O "https://example.com/b.html"

# Only download if changed: -R keeps the server's Last-Modified on the file, -z sends If-Modified-Since
curl -sS -R -z page.html -o page.html -w '%{http_code}\n' "https://books.toscrape.com/catalogue/page-1.html"

# ETag-based conditional requests
curl -sS --etag-save etag.txt --etag-compare etag.txt -o page.html "https://example.com/page"

# Status, size and timing for monitoring or debugging
curl -sS -o /dev/null -w '%{http_code} %{size_download} %{time_total}\n' "https://books.toscrape.com/"
```

Version notes from the curl option docs: `--etag-save` and `--etag-compare` arrived in 7.68.0, `--retry-all-errors` in 7.71.0, `--fail-with-body` in 7.76.0, `--json` in 7.82.0 and `--rate` in 7.84.0; rate expressions with a multiplier such as `5/15s` need 8.10.0. `--retry-all-errors` retries every failure, including non-idempotent requests, so use it only for safe GETs. Plain `-f` discards the error body; `--fail-with-body` keeps it for debugging.

Cursor pagination in plain bash, tested against a local mock API:

```bash
#!/usr/bin/env bash
set -euo pipefail
UA="acme-research-bot/1.0 (+https://acme.example/bot)"
BASE="https://api.example.com/items?limit=100"
url="$BASE"
: > items.jsonl
while [ -n "$url" ]; do
  page=$(curl -sS --fail-with-body --compressed -A "$UA" --retry 3 --max-time 30 "$url")
  jq -c '.data.items[]' <<<"$page" >> items.jsonl
  cursor=$(jq -r '.next_cursor // empty' <<<"$page")
  url=""
  if [ -n "$cursor" ]; then url="$BASE&cursor=$cursor"; fi
  sleep 1   # politeness between pages
done
```

## wget for mirroring and archiving

```bash
wget --recursive --level=2 --no-parent \
     --wait=1 --random-wait --limit-rate=500k \
     --user-agent="acme-research-bot/1.0 (+https://acme.example/bot)" \
     --warc-file=books-crawl --directory-prefix=mirror \
     "https://books.toscrape.com/catalogue/page-1.html"
```

In recursive mode wget fetches and obeys robots.txt by default (a disallowed link was skipped in our test, and fetched only with `-e robots=off`, which you should not use against sites that ask bots to stay out). `--warc-file` writes a compressed WARC archive alongside the mirror, useful for re-parsing later (see [Object Storage and Raw Archives](../storage/object-storage-and-raw-archives.md)). `--convert-links` and `--adjust-extension` make an offline copy browsable.

## Extracting from HTML

```bash
# htmlq: CSS selectors, text or attributes; --base resolves relative links
curl -sS -A "$UA" https://books.toscrape.com/ | htmlq --attribute href 'article.product_pod h3 a'
curl -sS -A "$UA" https://books.toscrape.com/ | htmlq --text 'p.price_color'
curl -sS https://books.toscrape.com/ | htmlq --base https://books.toscrape.com/ --attribute href 'li.next a'

# pup: CSS plus display functions text{}, attr{name} and json{}
curl -sS -A "$UA" https://books.toscrape.com/ | pup 'article.product_pod h3 a attr{href}'

# Xidel: XPath or CSS, and it can follow links itself
xidel https://books.toscrape.com/ --extract '//article//h3/a/@title'
xidel https://books.toscrape.com/ --follow '//li[@class="next"]/a' --extract '//title'
```

Command-line HTML tools parse the server's HTML, not the rendered DOM; if a selector matches nothing, check whether the content is rendered client-side (see [Static vs Dynamic Sites](../fundamentals/static-vs-dynamic-sites.md)). Resist `grep` and `sed` on HTML beyond quick checks (see [Regular Expressions: When and When Not](../parsing/regex-in-scraping.md)).

## Reshaping JSON with jq

```bash
jq -c '.data.items[] | {id, name, price: .price.amount}' items.json      # one compact object per line
jq -r '.data.items[] | [.id, .name, .price.amount] | @csv' items.json    # CSV rows
jq -r '.next_cursor // empty' items.json                                 # cursor or nothing
jq --arg min 15 '[.data.items[] | select(.price.amount > ($min | tonumber))] | length' items.json
gron items.json | grep -i price                                          # find the path of a value
```

`@csv` and `@tsv` quote correctly, which hand-built `join(",")` does not. For embedded JSON blobs in pages, see [JSON and Embedded Data](../parsing/json-and-embedded-data.md).

## YAML and XML with yq

Mike Farah's yq reads XML, which makes feeds and sitemaps easy to inspect (tested with v4.54):

```bash
yq -p xml -o json '.rss.channel.item[] | {"title": .title, "link": .link}' feed.xml
yq -p xml -o yaml '.urlset.url[].loc' sitemap.xml
```

Pass `-o` explicitly: when the input format is set with `-p` and no output format is given, recent versions print a warning about the default output format. If `yq --version` does not mention mikefarah, you have the Python wrapper, whose syntax is jq's. Feed and sitemap formats are covered in [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md) and [XML Sitemaps](../crawling/sitemaps.md).

## Pitfalls

- `curl` without `--fail` or `--fail-with-body`: an HTML error page is saved as if it were data, with exit code 0.
- Copy-as-cURL commands that carry your session cookies into scripts, logs and shell history.
- `--parallel` silently disabling `--rate` pacing.
- `-e robots=off` in wget, or recursive mirroring without `--wait`.
- Shell quoting of selectors and jq programs; prefer single quotes and `--arg` for variables.
- Two different `yq` programs with incompatible syntax.
- Relying on pup for new work although it is unmaintained.
- Pipelines with no `set -euo pipefail`, so a failed fetch produces an empty file that looks valid.

## Checklist

- [ ] User-Agent with contact info on every request
- [ ] `--fail-with-body`, `--max-time` and transient-only retries
- [ ] Pacing with `--rate`, `sleep` or wget `--wait --random-wait`
- [ ] Conditional requests for repeated fetches
- [ ] robots.txt honored (wget default; check manually for curl loops)
- [ ] `set -euo pipefail` in scripts; outputs validated before use
- [ ] No cookies or tokens committed from copied commands

## See Also

- [curl and HTTPie Cheatsheet](../http/curl-cheatsheet.md)
- [Browser DevTools for Scrapers](devtools-for-scrapers.md)
- [JSON and Embedded Data](../parsing/json-and-embedded-data.md)
- [XML, RSS and Atom Feeds](../parsing/xml-rss-atom-feeds.md)
- [Python Scraping Stack](python-scraping-stack.md)
- [Regular Expressions: When and When Not](../parsing/regex-in-scraping.md)
