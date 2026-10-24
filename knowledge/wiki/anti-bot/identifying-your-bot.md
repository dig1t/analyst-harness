---
tags: [scraping, anti-bot, user-agent, bot-verification, etiquette]
aliases: [bot User-Agent, honest user agent, bot verification, reverse DNS verification, Web Bot Auth, From header]
---

# Identifying Your Bot

> Sources: RFC 9110, From (section 10.1.2) and User-Agent (section 10.1.5) (https://www.rfc-editor.org/rfc/rfc9110#section-10.1.5); RFC 9309, Robots Exclusion Protocol (https://www.rfc-editor.org/rfc/rfc9309); RFC 9421, HTTP Message Signatures (https://www.rfc-editor.org/rfc/rfc9421); Google Search Central, Verifying Googlebot and other Google crawlers (https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot); Cloudflare docs, Verified bots (https://developers.cloudflare.com/bots/concepts/bot/verified-bots/); Cloudflare docs, IP validation (https://developers.cloudflare.com/bots/reference/bot-verification/ip-validation/); Cloudflare docs, Web Bot Auth (https://developers.cloudflare.com/bots/reference/bot-verification/web-bot-auth/); IETF draft, Web Bot Auth architecture (https://datatracker.ietf.org/doc/html/draft-meunier-web-bot-auth-architecture-02); Wikimedia User-Agent policy (https://meta.wikimedia.org/wiki/User-Agent_policy); SEC, Accessing EDGAR data (https://www.sec.gov/os/accessing-edgar-data)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Being identifiable is the foundation of polite scraping. Send a descriptive User-Agent that names your bot and gives a URL and contact address, add a `From` header, publish a bot information page, crawl from stable IP addresses, use a stable robots.txt token, and where possible offer a verification method that cannot be faked: forward-confirmed reverse DNS, a published IP list, or cryptographic request signatures (Web Bot Auth). Site owners can then contact you, rate limit you, allowlist you or exclude you precisely, instead of blocking every unknown client. Some sources require it outright: Wikimedia asks for an informative User-Agent with contact information or risks blocking, and the SEC asks EDGAR users to declare a User-Agent with a company name and email. Never impersonate a browser or another crawler.

## The User-Agent header

RFC 9110 defines `User-Agent = product *( RWS ( product / comment ) )`, where a product is `name/version` and a comment is text in parentheses. The established convention for bots is a product token plus a comment with a URL and contact:

```text
AnalystHarnessBot/1.4 (+https://example.org/bot; bot-ops@example.org) httpx/0.28.1
```

- **Name**: unique, stable across versions, no spaces (it doubles as your robots.txt token).
- **Version**: helps site owners correlate behavior with releases.
- **Comment**: a `+URL` to the bot page (a convention used by major crawlers, for example Googlebot's `+http://www.google.com/bot.html`) and a monitored role address.
- **Library token** (optional): Wikimedia's recommended format ends with the library and its version.
- **Separate tokens for separate purposes.** CDN policies increasingly distinguish search, training, agents and data collection, and Cloudflare notes that crawlers mixing search and training get blocked by rules that block training. One token per purpose lets sites apply their preferences precisely ([AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)).

Generic library defaults are worse than useless: Cloudflare's verified-bot form rejects user agents such as `Go-http-client`, `node` or `got`, and its bot scoring treats a missing User-Agent as automated with high confidence.

## The From header

RFC 9110 section 10.1.2 says a robotic user agent SHOULD send a valid `From` header (an email address) "so that the person responsible for running the robot can be contacted if problems occur on servers". Servers should not use it for access control. Use a role mailbox that someone actually reads.

```python
import httpx

BOT_NAME, BOT_VERSION = "AnalystHarnessBot", "1.4"
BOT_PAGE, BOT_CONTACT = "https://example.org/bot", "bot-ops@example.org"
USER_AGENT = f"{BOT_NAME}/{BOT_VERSION} (+{BOT_PAGE}; {BOT_CONTACT}) httpx/{httpx.__version__}"

client = httpx.Client(headers={"User-Agent": USER_AGENT, "From": BOT_CONTACT}, timeout=30)
```

```ts
const BOT_CONTACT = 'bot-ops@example.org';
const USER_AGENT = `AnalystHarnessBot/1.4 (+https://example.org/bot; ${BOT_CONTACT})`;
const res = await fetch('https://example.com/data.json', {
  headers: { 'user-agent': USER_AGENT, from: BOT_CONTACT },
});
```

Keep the name, page and contact in configuration rather than scattered through code ([Secrets and Configuration](../operations/secrets-and-config.md)).

## Identifying a headless browser

A browser's default User-Agent describes the browser, not your bot. Append your token rather than replacing the string with a different browser's:

```python
from playwright.sync_api import sync_playwright

BOT_TOKEN = "AnalystHarnessBot/1.4 (+https://example.org/bot; bot-ops@example.org)"

with sync_playwright() as p:
    browser = p.chromium.launch()
    probe = browser.new_page()
    base_ua = probe.evaluate("navigator.userAgent")  # includes HeadlessChrome when headless
    probe.close()
    context = browser.new_context(
        user_agent=f"{base_ua} {BOT_TOKEN}",
        extra_http_headers={"From": "bot-ops@example.org"},
    )
```

Extra headers go to every host the page contacts, including third parties, which is one more reason to use a role address.

## The bot information page

Publish one page that answers what a site owner needs:

- What the bot collects and why, and who operates it
- User-Agent strings and the robots.txt token
- Egress IP ranges (also as a machine-readable list) or the verification method
- Request rates, schedule, and whether it executes JavaScript or logs in
- How to opt out (robots.txt rules for the token, or email) and how fast you respond
- Data use and retention, and how to request deletion

A site can then target you precisely, as RFC 9309 matches groups by product token, case-insensitively:

```text
User-agent: AnalystHarnessBot
Disallow: /checkout/
```

See [robots.txt (RFC 9309)](../crawling/robots-txt.md).

## Verification methods

A User-Agent is a claim anyone can copy, so sites verify important bots by other means.

**Forward-confirmed reverse DNS.** The IP's PTR record must name a host under the operator's domain, and that host name must resolve back to the same IP. Google documents this for its crawlers (names under `googlebot.com`, `google.com` or `googleusercontent.com`).

```python
import ipaddress
import socket


def verify_crawler_ip(ip: str, allowed_suffixes: tuple[str, ...]) -> bool:
    """True if the PTR name ends with an allowed domain and resolves back to the IP."""
    try:
        host = socket.gethostbyaddr(ip)[0]
    except (socket.herror, socket.gaierror):
        return False
    if not host.endswith(allowed_suffixes):
        return False
    try:
        addresses = {ipaddress.ip_address(info[4][0]) for info in socket.getaddrinfo(host, None)}
    except socket.gaierror:
        return False
    return ipaddress.ip_address(ip) in addresses


print(verify_crawler_ip("66.249.66.1", (".googlebot.com", ".google.com", ".googleusercontent.com")))
```

To offer this yourself, set PTR records for your egress IPs to names under your domain, with matching forward records.

**Published IP lists.** Google publishes JSON lists of its crawler ranges (for example `https://developers.google.com/static/search/apis/ipranges/googlebot.json`), and other large operators do the same. Publish yours if your egress is stable ([Proxies: Types, Uses and Ethics](proxies-overview.md)).

**Web Bot Auth.** A cryptographic method built on HTTP Message Signatures (RFC 9421) and IETF drafts that are still evolving. The operator hosts its Ed25519 public keys as a JSON Web Key Set at `/.well-known/http-message-signatures-directory` and signs each request, sending three headers:

```text
Signature-Agent: "https://example.org"
Signature-Input: sig1=("@authority" "signature-agent");created=<unix-time>;expires=<unix-time>;keyid="<JWK thumbprint>";alg="ed25519";tag="web-bot-auth"
Signature: sig1=:<base64 signature>:
```

Cloudflare uses it for verified bots and agents, recommends short expiry windows against replay, and offers a test endpoint (`https://crawltest.com/cdn-cgi/web-bot-auth`) that returns 200 when the key is known and the message verifies, 401 when the key is unknown or verification fails, and 400 for malformed messages.

**Vendor programs.** Cloudflare's verified-bot directory (BotBase) accepts submissions that verify through Web Bot Auth or IP validation (a public IP list, or domain-based reverse DNS) and requires non-abusive behavior: obeying robots.txt, reasonable request rates and an accurate stated purpose. Breaches, such as IPs shared with other services or an AI crawler ignoring `crawl-delay`, remove a bot from the allowlist. Other CDN and WAF vendors keep their own known-bot lists ([WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)).

## Never impersonate

Do not send Googlebot's or another operator's User-Agent, and do not present a bot as a person's browser. Sites verify the big crawlers by DNS and IP, so impersonation is easy to catch, and it is deceptive whether or not it is caught.

## Pitfalls

- An unmonitored contact address, or a bot page that no longer exists.
- Changing the bot name with every release, which breaks site owners' robots.txt rules.
- Rotating egress IPs, which makes allowlisting impossible.
- Putting secrets or personal names in the User-Agent; use a role address.
- Treating verification as permission to crawl harder than the site allows.

## Checklist

- [ ] Unique bot name with version, bot page URL and contact in the User-Agent
- [ ] `From` header with a monitored role mailbox
- [ ] Bot page covering purpose, IPs, rates, opt-out and data use
- [ ] Stable egress IPs with PTR records or a published IP list
- [ ] Separate tokens for separate purposes
- [ ] Verified-bot programs considered for high-volume crawling

## See Also

- [robots.txt (RFC 9309)](../crawling/robots-txt.md)
- [WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)
- [Request Headers That Matter](../http/http-headers-for-scrapers.md)
- [AI Crawlers and Content Opt-Outs](../llm-scraping/ai-crawlers-and-opt-outs.md)
- [Proxies: Types, Uses and Ethics](proxies-overview.md)
- [Wikipedia and Wikidata](../sources/wikipedia-and-wikidata.md)
