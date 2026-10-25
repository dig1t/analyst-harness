---
tags: [scraping, http, curl, httpie, cli]
aliases: [curl, HTTPie, curl recipes, Copy as cURL, curl cheatsheet]
---

# curl and HTTPie Cheatsheet

> Sources: curl manual (https://curl.se/docs/manpage.html); Everything curl, by Daniel Stenberg (https://everything.curl.dev/); curl command-line option docs, with the version that added each option (https://github.com/curl/curl/tree/master/docs/cmdline-opts); libcurl error codes (https://curl.se/libcurl/c/libcurl-errors.html); HTTPie CLI documentation (https://httpie.io/docs/cli); Chrome DevTools, Network panel reference (https://developer.chrome.com/docs/devtools/network/reference); Firefox DevTools, Network Monitor (https://firefox-source-docs.mozilla.org/devtools-user/network_monitor/); curlconverter (https://curlconverter.com/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

curl is the reference HTTP client for investigating a target: it shows exactly what was sent and received, reproduces a browser request copied from DevTools, and scripts conditional, rate-limited or retried downloads without writing code. HTTPie is friendlier for JSON APIs and exploratory work. Use them during reconnaissance and debugging, then port what works into your scraper (curlconverter translates a curl command into Python, JavaScript and other languages). Option versions below come from curl's own documentation; check yours with `curl -V`. Commands copied from a browser carry your cookies and tokens, so treat them as secrets.

## Look before you scrape

```bash
# Status, protocol, redirects and timing without saving the body
curl -sS -o /dev/null -L \
  -w '%{http_code} %{http_version} redirects=%{num_redirects} %{time_total}s %{url_effective}\n' \
  https://example.com/products

# Response headers only (HEAD); some servers answer HEAD differently from GET
curl -sSI https://example.com/products

# Headers and body together (-i, renamed --show-headers in curl 8.10.0; -i still works)
curl -sS -i https://example.com/robots.txt

# Everything on the wire, including the TLS handshake summary and request headers
curl -v https://example.com/ -o /dev/null

# All write-out variables as JSON (curl 7.70.0 and later)
curl -sS -o /dev/null -w '%{json}' https://example.com/ | jq .
```

`-s` hides the progress meter, `-S` still prints errors, `-o /dev/null` discards the body. Useful `-w` variables: `http_code`, `http_version`, `num_redirects`, `num_connects`, `time_connect`, `time_appconnect` (TLS done), `time_starttransfer` (first byte), `size_download`, `content_type`, `remote_ip`, `url_effective`, `header_json` (7.83.0) and `errormsg` (7.75.0).

## Identify yourself and negotiate content

```bash
curl -sS --compressed \
  -A 'acme-price-monitor/2.0 (+https://acme.example/bot; ops@acme.example)' \
  -H 'From: ops@acme.example' \
  -H 'Accept: application/json' \
  -H 'Accept-Language: en-GB,en;q=0.8' \
  -e 'https://example.com/products' \
  https://example.com/api/products?page=1
```

`--compressed` asks for every coding your curl build supports and decodes the response; without it curl requests nothing compressed. `-A` sets `User-Agent`, `-e` sets `Referer`. See [Request Headers That Matter](http-headers-for-scrapers.md).

## Query strings, forms and JSON

```bash
# Encode query parameters safely: -G turns --data-urlencode into the query string
curl -sS -G --data-urlencode 'q=red shoes' --data-urlencode 'page=2' https://example.com/search

# Form POST (application/x-www-form-urlencoded)
curl -sS --data-urlencode 'q=red shoes' --data-urlencode 'sort=price' https://example.com/search

# JSON POST: sets Content-Type and Accept to application/json (curl 7.82.0 and later)
curl -sS --json '{"query": "{ products(first: 10) { name } }"}' https://example.com/graphql

# Or the classic form, reading the body from a file
curl -sS -H 'Content-Type: application/json' --data-binary @query.json https://example.com/graphql
```

## Cookies and sessions

```bash
# Start a session, read the CSRF token from the form, log in, keep the jar
curl -sS -c jar.txt -b jar.txt https://example.com/login -o login.html
TOKEN=$(sed -n 's/.*name="csrf_token" value="\([^"]*\)".*/\1/p' login.html)
curl -sS -c jar.txt -b jar.txt -L \
  --data-urlencode "csrf_token=$TOKEN" \
  --data-urlencode "username=$SITE_USER" --data-urlencode "password=$SITE_PASSWORD" \
  https://example.com/login
curl -sS -b jar.txt https://example.com/account
```

`-c` writes cookies to a Netscape-format jar (readable by Python's `MozillaCookieJar`), `-b` sends them. `-j` (`--junk-session-cookies`) starts a new session by ignoring stored session cookies. Details in [Cookies, Sessions and State](cookies-and-sessions.md).

## Secrets without leaking them

```bash
# Read a token from the environment instead of typing it (curl 8.3.0 and later)
curl -sS --variable %API_TOKEN --expand-header 'Authorization: Bearer {{API_TOKEN}}' \
  https://api.example.com/v1/items

# Keep headers in a config file with restricted permissions
cat > api.curlrc <<'EOF'
header = "X-API-Key: replace-me"
user-agent = "acme-bot/1.0 (+https://acme.example/bot)"
silent
show-error
EOF
chmod 600 api.curlrc
curl -K api.curlrc https://api.example.com/v1/items

# Basic auth from ~/.netrc rather than -u user:password on the command line
curl -sS --netrc https://internal.example.com/export.csv
```

Command-line arguments are visible to other users in process lists and land in shell history; environment variables, config files and `.netrc` avoid that. Never use `--location-trusted`, which resends credentials to whatever host a redirect points to.

## Be polite: retries, rates, conditional requests

```bash
# Retry transient failures (timeouts, 408, 429, 500, 502, 503, 504, 522, 524) with
# exponential backoff from 1 s; curl honors Retry-After. --fail keeps error bodies out of the output.
curl -sS --fail --retry 5 --retry-max-time 300 -o page.html https://example.com/page

# At most 30 requests per minute across a list of URLs (curl 7.84.0 and later)
curl -sS --rate 30/m -o 'page_#1.html' 'https://example.com/list?page=[1-20]'

# Conditional GET with ETag (curl 7.68.0 and later): unchanged pages return 304
curl -sS --etag-save etag.txt --etag-compare etag.txt -o feed.xml https://example.com/feed.xml

# Conditional GET by date: -R stores Last-Modified as the file time, -z sends If-Modified-Since
curl -sS -R -o sitemap.xml https://example.com/sitemap.xml
curl -sS -z sitemap.xml -o sitemap.xml https://example.com/sitemap.xml

# Cap time and size, fail on HTTP errors but keep the error body for diagnosis
curl -sS --connect-timeout 5 --max-time 30 --max-filesize 50M --fail-with-body -O https://example.com/data.zip
```

`--rate` has no effect together with `-Z`/`--parallel`. Parallel transfers (`-Z --parallel-max 4`) are for your own infrastructure or documented bulk endpoints, not for raising the load on someone's website ([Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)). URL globbing (`[1-20]`, `{a,b}`) plus `#1` in the output name saves each page to its own file.

## Protocols, TLS and routing

```bash
curl -sS --http1.1 https://example.com/ -o /dev/null -w '%{http_version}\n'
curl -sS --http2 https://example.com/ -o /dev/null -w '%{http_version}\n'   # default over HTTPS
curl -sS --http3 https://example.com/ -o /dev/null -w '%{http_version}\n'   # needs an HTTP/3 build

curl --cacert corp-root-ca.pem https://example.com/       # trust a private or proxy CA
curl --ca-native https://example.com/                     # use the OS trust store (curl 8.2.0)

# Send the request to one specific IP while keeping Host and SNI (testing an edge or a staging box)
curl -sS --resolve example.com:443:203.0.113.10 https://example.com/
curl -sS -x http://proxy.internal:3128 https://example.com/   # through an authorized proxy
```

Never use `-k`/`--insecure` against a third-party site; fix trust instead ([TLS and HTTPS for Scrapers](tls-and-https.md)).

## Exit codes worth scripting on

| Code | Meaning |
|---|---|
| 6 | Could not resolve host |
| 7 | Could not connect |
| 22 | HTTP error 400 or above, with `--fail` or `--fail-with-body` |
| 28 | Operation timed out |
| 35 | TLS handshake error |
| 47 | Too many redirects |
| 52 | Server returned nothing |
| 56 | Failure receiving data (connection reset) |
| 60 | Peer certificate could not be verified |
| 63 | Maximum file size exceeded |

## Copy as cURL from DevTools

- **Chrome and Edge:** Network panel, right-click a request, Copy, then "Copy as cURL (bash)" or "Copy as cURL (cmd)". The same menu offers "Copy as fetch", "Copy as fetch (Node.js)" and "Copy as PowerShell".
- **Firefox:** Network Monitor, right-click a request, Copy Value, then "Copy as cURL" (POSIX or Windows flavor), or "Copy as Fetch".

Then minimize: delete headers one by one until the response changes, swap the browser's identity for your own `User-Agent`, replace cookies and CSRF tokens with values your code obtains at runtime, and scrub the command before pasting it into tickets or chat. replacing `curl` with `npx curlconverter --language python` in the command (or pasting it into curlconverter.com) prints equivalent code ([Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md), [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)).

## HTTPie equivalents

```bash
http --print=Hh https://example.com/ 'User-Agent:acme-bot/1.0 (+https://acme.example/bot)'  # request and response headers
http https://api.example.com/search q=='red shoes' page==2                  # == query parameters
http POST https://api.example.com/items name=Ann age:=29 tags:='["a","b"]'  # = string, := raw JSON
http --follow --check-status --timeout=15 https://example.com/old-path       # exit 4 or 5 on 4xx/5xx
http -A bearer -a "$API_TOKEN" https://api.example.com/v1/items              # bearer auth
http --session=./site.json https://example.com/login                         # persist cookies and headers
http --offline POST https://api.example.com/items x=1                        # print the request, send nothing
http --download https://example.com/data.zip                                 # save with a progress bar
```

HTTPie sends data fields as JSON by default (`--form` for form encoding), does not follow redirects unless `--follow` is given (then up to 30), and stores session files, including credentials, in plain JSON. In scripts and cron jobs add `--ignore-stdin`: otherwise HTTPie can wait forever for a request body on a non-interactive stdin.

## Pitfalls

- **`-k` "just for now"**, which becomes permanent.
- **Secrets on the command line**, visible in `ps` and saved in shell history.
- **`--retry` without `--fail` or `-o`**, which concatenates error bodies into the output stream.
- **Forgetting `--compressed`** and comparing byte counts with what a browser downloads.
- **Pasting a full "Copy as cURL"** into a scraper, with your personal session inside it.
- **`--location-trusted`**, sending credentials to every redirect target.
- **`-X POST` combined with `-L`**: curl keeps POST on every hop, even where a browser would switch to GET. Use `--data` without `-X` and let curl choose.
- **Parallel downloads against small sites.**

## Checklist

- [ ] Recon command records status, protocol, redirects and timing
- [ ] Honest `-A` and `From` on every exploratory request
- [ ] Secrets from environment variables, config files or `.netrc`
- [ ] `--fail`, `--retry`, `--max-time` and `--max-filesize` in scripted downloads
- [ ] `--rate` or sleeps between requests; no parallelism against small sites
- [ ] Conditional requests (`--etag-compare`, `-z`) for repeated downloads
- [ ] Copied DevTools commands minimized and scrubbed

## See Also

- [Command-Line Tools](../tools/cli-tools.md)
- [Browser DevTools for Scrapers](../tools/devtools-for-scrapers.md)
- [Finding Hidden APIs with DevTools](../apis/finding-hidden-apis.md)
- [HTTP Fundamentals](http-fundamentals.md)
- [HTTP Caching and Conditional Requests](caching-and-conditional-requests.md)
