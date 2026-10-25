---
tags: [scraping, tools, go, rust, colly]
aliases: [Go scraping, Rust scraping, Colly, goquery, reqwest, scraper crate, jsoup, Nokogiri, rvest]
---

# Go, Rust and Other Ecosystems

> Sources: Colly documentation (https://go-colly.org/docs/) and package reference (https://pkg.go.dev/github.com/gocolly/colly/v2); goquery (https://github.com/PuerkitoBio/goquery); chromedp (https://github.com/chromedp/chromedp); reqwest documentation (https://docs.rs/reqwest); scraper crate documentation (https://docs.rs/scraper); spider crate (https://github.com/spider-rs/spider); jsoup (https://jsoup.org/); Nokogiri (https://nokogiri.org/); rvest (https://rvest.tidyverse.org/); polite for R (https://github.com/dmi3kno/polite); Apache Nutch (https://nutch.apache.org/); Apache StormCrawler (https://stormcrawler.apache.org/); Heritrix (https://github.com/internetarchive/heritrix3)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Python and Node dominate scraping, but other languages are good choices when a team already lives there or when a scraper must be a single fast binary. Go offers **Colly** (a complete, callback-based crawler) and **goquery** (jQuery-style parsing); Rust offers **reqwest** with the **scraper** crate, plus the **spider** crawler. Java has **jsoup** and the large-scale crawlers **Apache Nutch**, **StormCrawler** and **Heritrix**; Ruby has **Nokogiri**; R has **rvest** and **polite**; PHP and .NET have mature DOM libraries. The polite-crawling rules are the same everywhere; what differs are the defaults, and some defaults are not polite (Colly ignores robots.txt unless told otherwise).

## Go

| Library | Role | Version (2026-10) | Notes |
|---|---|---|---|
| net/http | HTTP client | Go standard library | Set `Client.Timeout`; the zero value has none |
| Colly | Crawler framework | v2.3.0 (`github.com/gocolly/colly/v2`) | Callbacks, limits per domain, async mode, caching |
| goquery | HTML parsing with CSS selectors | v1.13.0 | Built on `golang.org/x/net/html` and cascadia |
| chromedp | Browser automation over CDP | v0.21.0 | No external driver needed, Chrome must be installed |
| rod | Browser automation over CDP | v0.116.2 | Alternative to chromedp |

Colly's defaults to change: `IgnoreRobotsTxt` is `true` after `NewCollector()` (set it to `false`), the default User-Agent is `colly - https://github.com/gocolly/colly`, and there is no delay unless you add a `LimitRule`. Tested with Colly v2.3.0 and Go 1.24 against a local copy of the books sandbox (the robots-disallowed link was skipped and robots.txt was fetched with the custom User-Agent):

```go
package main

import (
	"encoding/json"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/gocolly/colly/v2"
)

type Book struct {
	URL   string `json:"url"`
	Title string `json:"title"`
	Price string `json:"price"`
}

func main() {
	c := colly.NewCollector(
		colly.AllowedDomains("books.toscrape.com"),
		colly.UserAgent("acme-research-bot/1.0 (+https://acme.example/bot)"),
		colly.MaxDepth(3),
		colly.Async(true),
	)
	c.IgnoreRobotsTxt = false // Colly ignores robots.txt unless you turn this off
	c.SetRequestTimeout(20 * time.Second)

	// Politeness: at most 2 parallel requests per domain, 1 s plus up to 500 ms between them.
	if err := c.Limit(&colly.LimitRule{
		DomainGlob:  "*",
		Parallelism: 2,
		Delay:       1 * time.Second,
		RandomDelay: 500 * time.Millisecond,
	}); err != nil {
		log.Fatal(err)
	}

	detail := c.Clone() // same settings, separate callbacks
	var (
		mu    sync.Mutex // async callbacks run concurrently
		books []Book
	)

	c.OnHTML("article.product_pod h3 a[href]", func(e *colly.HTMLElement) {
		detail.Visit(e.Request.AbsoluteURL(e.Attr("href")))
	})
	c.OnHTML("li.next a[href]", func(e *colly.HTMLElement) {
		e.Request.Visit(e.Attr("href"))
	})
	detail.OnHTML("div.product_main", func(e *colly.HTMLElement) {
		b := Book{
			URL:   e.Request.URL.String(),
			Title: strings.TrimSpace(e.ChildText("h1")),
			Price: e.ChildText("p.price_color"),
		}
		mu.Lock()
		books = append(books, b)
		mu.Unlock()
	})
	for _, col := range []*colly.Collector{c, detail} {
		col.OnError(func(r *colly.Response, err error) {
			log.Printf("error %s: %v (status %d)", r.Request.URL, err, r.StatusCode)
		})
	}

	if err := c.Visit("https://books.toscrape.com/catalogue/page-1.html"); err != nil {
		log.Fatal(err)
	}
	c.Wait()
	detail.Wait()
	json.NewEncoder(os.Stdout).Encode(books)
}
```

With `Async(true)`, callbacks run concurrently, hence the mutex around the shared slice (a channel works too). For parsing without Colly, `goquery.NewDocumentFromReader(resp.Body)` then `doc.Find(".item").Each(...)` gives the same selector API.

## Rust

| Crate | Role | Version (2026-10) | Notes |
|---|---|---|---|
| reqwest | HTTP client (async and blocking) | 0.13 | Builder for timeouts, User-Agent, redirects, cookies |
| tokio | Async runtime | 1.x | Needed by async reqwest |
| scraper | HTML parsing with CSS selectors | 0.29 | html5ever parser, Servo's `selectors` crate |
| spider | Crawler framework | 2.x | High-throughput crawling, optional headless Chrome |
| chromiumoxide | Browser automation over CDP | 0.9 | Async Chrome control |

Tested with reqwest 0.13, scraper 0.29 and tokio 1 (edition 2024):

```rust
use std::time::Duration;

use scraper::{Html, Selector};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = reqwest::Client::builder()
        .user_agent("acme-research-bot/1.0 (+https://acme.example/bot)")
        .timeout(Duration::from_secs(20))
        .build()?;

    let mut url = Some("https://books.toscrape.com/catalogue/page-1.html".to_string());
    let card = Selector::parse("article.product_pod")?;
    let link = Selector::parse("h3 a")?;
    let price = Selector::parse("p.price_color")?;
    let next = Selector::parse("li.next a")?;

    while let Some(current) = url.take() {
        let base = reqwest::Url::parse(&current)?;
        let body = client.get(base.clone()).send().await?.error_for_status()?.text().await?;
        let doc = Html::parse_document(&body);
        for item in doc.select(&card) {
            let title = item.select(&link).next().and_then(|a| a.value().attr("title")).unwrap_or_default();
            let cost: String = item.select(&price).flat_map(|p| p.text()).collect();
            println!("{title}\t{}", cost.trim());
        }
        url = doc
            .select(&next)
            .next()
            .and_then(|a| a.value().attr("href"))
            .and_then(|href| base.join(href).ok())
            .map(|u| u.to_string());
        tokio::time::sleep(Duration::from_secs(1)).await; // politeness delay
    }
    Ok(())
}
```

```toml
[dependencies]
reqwest = "0.13"
scraper = "0.29"
tokio = { version = "1", features = ["macros", "rt-multi-thread", "time"] }
```

By default `scraper::Html` is not `Send` (verified with 0.29), so in spawned tasks parse inside a synchronous block and drop the document before the next `.await`, or enable the crate's `atomic` feature, which makes it `Send`. Rust has no robots.txt parser in the standard toolkit; use a maintained crate or the crawler's built-in support, and check it implements RFC 9309 matching (see [robots.txt (RFC 9309)](../crawling/robots-txt.md)).

## Other ecosystems

| Language | Libraries | Good to know |
|---|---|---|
| Java, Kotlin | jsoup (HTML parsing with CSS selectors, 1.23), Playwright for Java (1.64), Apache Nutch, Apache StormCrawler, Heritrix | Nutch and StormCrawler are large-scale crawlers (Hadoop and Apache Storm based); Heritrix is the Internet Archive's archival crawler that writes WARC files |
| Ruby | Nokogiri (1.19), Mechanize | Nokogiri wraps libxml2 with CSS and XPath support |
| R | rvest (1.0), polite | polite's `bow()` reads robots.txt, sets a delay and caches; `scrape()` then fetches politely |
| PHP | Symfony DomCrawler and HttpClient, Roach PHP | Roach is a Scrapy-inspired framework |
| C#, .NET | AngleSharp (1.8), HtmlAgilityPack (1.13), Playwright for .NET | AngleSharp follows the WHATWG DOM; HtmlAgilityPack is XPath-oriented |
| Elixir | Crawly, Floki | Crawly is a Scrapy-like framework on the BEAM |

For archival crawling into WARC files and large web corpora, see [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md) and [Distributed Crawling](../crawling/distributed-crawling.md).

## Choosing

- **Single static binary, low memory, many concurrent fetches:** Go with Colly, or Rust with reqwest and scraper.
- **Analysts working in R:** rvest plus polite.
- **JVM shop or web-scale crawl:** jsoup for parsing; Nutch or StormCrawler for fleets; Heritrix for archiving.
- **Heavy JavaScript sites:** the language matters less than the browser; Playwright has official Java, .NET and Python ports, and Go and Rust have CDP libraries.

## Pitfalls

- Colly's `IgnoreRobotsTxt` default of `true`.
- Go's `http.Client{}` with no `Timeout`.
- No delay or parallelism limit in Colly unless you add a `LimitRule`; a `LimitRule` that matches no domain does nothing.
- Data races when appending results from async Colly callbacks.
- Holding a `scraper::Html` across `.await` in spawned Rust tasks without the `atomic` feature.
- Assuming a library's robots.txt handling follows RFC 9309; test longest-match and wildcard cases.

## Checklist

- [ ] robots.txt respected explicitly (Colly: `IgnoreRobotsTxt = false`)
- [ ] Honest User-Agent and request timeouts set
- [ ] Per-domain parallelism and delay configured
- [ ] Results collected without data races
- [ ] Selectors and parsing covered by fixture tests

## See Also

- [Python Scraping Stack](python-scraping-stack.md)
- [Node.js Scraping Stack](node-scraping-stack.md)
- [Command-Line Tools](cli-tools.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [robots.txt (RFC 9309)](../crawling/robots-txt.md)
- [Common Crawl and Web Archives](../crawling/common-crawl-and-archives.md)
