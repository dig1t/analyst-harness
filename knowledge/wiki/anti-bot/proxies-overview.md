---
tags: [scraping, anti-bot, proxies, networking, ethics]
aliases: [proxy, proxies, residential proxies, datacenter proxies, forward proxy, egress proxy]
---

# Proxies: Types, Uses and Ethics

> Sources: RFC 9110, CONNECT method (https://www.rfc-editor.org/rfc/rfc9110#section-9.3.6); RFC 1928, SOCKS Protocol Version 5 (https://www.rfc-editor.org/rfc/rfc1928); HTTPX docs, Proxies (https://www.python-httpx.org/advanced/proxies/); Playwright docs, HTTP Proxy (https://playwright.dev/docs/network); Mi et al., "Resident Evil: Understanding Residential IP Proxy as a Dark Service" (IEEE S&P 2019); US Department of Justice announcement on dismantling the 911 S5 botnet (May 2024); Craigslist Inc. v. 3Taps Inc. (N.D. Cal. 2013)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A proxy relays your traffic so that the destination sees the proxy's IP address instead of yours. Proxies differ by protocol (HTTP forward proxies with CONNECT tunnels, SOCKS5, TLS-inspecting corporate gateways) and by where the traffic finally exits (data centers, ISP-registered ranges, real people's home connections, mobile carriers). They have solid legitimate uses: corporate egress control, stable IPs that a site can allowlist, testing your own site from other regions, contracted ad verification, debugging and reliability. They are not a tool for getting around blocks or rate limits, and residential and mobile proxy networks carry serious consent problems, because the exit devices often belong to people who never meaningfully agreed to relay strangers' traffic.

## How proxies work

- **HTTP forward proxy.** For `http://` URLs the client sends the full request to the proxy, which forwards it. For `https://` URLs the client sends `CONNECT host:443` and the proxy opens a blind tunnel (RFC 9110 section 9.3.6), so TLS still runs end to end between you and the site.
- **SOCKS5** (RFC 1928) relays TCP connections at a lower level, with optional authentication. In curl, `socks5h://` makes the proxy resolve DNS names as well.
- **TLS-inspecting proxies.** Corporate gateways and some sandboxes terminate TLS and re-encrypt it with their own certificate authority. Clients must trust that CA explicitly; never disable certificate verification to make one work ([TLS and HTTPS for Scrapers](../http/tls-and-https.md)).
- **Reverse proxies and CDNs** sit in front of servers rather than clients; they are where bot management usually runs ([WAFs and CDN Bot Management](waf-and-cdn-bot-management.md)).

## Types by exit network

| Type | Where traffic exits | Provenance and consent | Legitimate uses | Notes |
|---|---|---|---|---|
| Corporate or forward proxy | Your organization's gateway | Yours | Egress control, auditing, caching, compliance | May inspect TLS with a corporate CA |
| Datacenter | Cloud or hosting provider IPs | Provider-owned | Stable published egress, testing, failover | Recognizably non-residential, which is fine for an honest bot |
| ISP ("static residential") | IPs registered to consumer ISPs but hosted in data centers | Leased ranges | Contracted ad verification and localization QA | Looks residential although no household is involved |
| Residential peer network | Real people's devices and home connections | Often gathered through SDKs in free apps, VPNs or browser extensions, and sometimes through malware | Narrow: brand protection or ad verification by vendors with audited, informed consent | Serious consent and abuse problems |
| Mobile | Carrier networks behind carrier-grade NAT | Same sourcing issues as residential | Mobile ad and app QA under contract | Many real users share each IP, so blocking it harms bystanders |

## Legitimate uses

- **Egress control.** Route all scraper traffic through a gateway that enforces allowlists, logs requests and applies your organization's policy.
- **A stable, published identity.** Send traffic from a small set of fixed IPs (for example a cloud NAT gateway) and list them on your bot page so site owners can verify and allowlist you ([Identifying Your Bot](identifying-your-bot.md)).
- **Testing your own properties from elsewhere.** Check localized pricing, consent banners, CDN routing or geo restrictions on sites you operate, from the regions your customers use.
- **Contracted verification.** Ad verification and brand protection performed under contracts with the advertisers or rights holders involved.
- **Reliability.** A second egress path for when one provider has an outage, not for when a site says no.
- **Debugging.** An intercepting proxy on your own machine to inspect your own client's traffic.
- **Caching.** A shared HTTP cache that cuts repeated downloads, which also reduces load on the sites you visit.

## Configuring a proxy for legitimate egress

```bash
# Most tools honor these variables (curl, Python requests and httpx, many SDKs)
export HTTPS_PROXY=http://proxy.corp.example:3128
export NO_PROXY=localhost,127.0.0.1,.internal.example
```

```python
import ssl

import httpx

UA = "ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)"
# Trust the inspecting proxy's CA bundle; never verify=False.
ctx = ssl.create_default_context(cafile="/etc/ssl/certs/corp-ca-bundle.pem")

with httpx.Client(proxy="http://proxy.corp.example:3128", verify=ctx,
                  headers={"User-Agent": UA}, timeout=30) as client:
    print(client.get("https://example.com/").status_code)
```

```ts
// Node: undici's ProxyAgent
import { fetch, ProxyAgent } from 'undici';

const dispatcher = new ProxyAgent('http://proxy.corp.example:3128');
const res = await fetch('https://example.com/', {
  dispatcher,
  headers: { 'user-agent': 'ExampleResearchBot/1.0 (+https://example.org/bot; bot-ops@example.org)' },
});
console.log(res.status);
```

```ts
// Playwright: QA of your own site through your organization's German egress
const context = await browser.newContext({
  proxy: { server: 'http://de-egress.corp.example:3128' },
  locale: 'de-DE',
  timezoneId: 'Europe/Berlin',
});
```

Playwright accepts HTTP and SOCKS proxies per browser or per context, with optional credentials and a bypass list.

## The consent problem with residential networks

Residential and mobile proxy networks exit through other people's devices. Providers acquire them through SDKs bundled into free apps, "free VPN" products, browser extensions and bandwidth-sharing programs, and in the worst cases through malware. The people involved often do not understand that strangers' traffic, including abusive traffic, will leave from their home IP address and may get that address blocked or investigated.

- Mi and colleagues (IEEE S&P 2019) studied commercial residential proxy services and found evidence that many exit nodes were devices whose owners were probably unaware they were relaying traffic, including IoT devices.
- In May 2024 the US Department of Justice announced the takedown of the 911 S5 botnet, which it called likely the world's largest. It was built from malware-infected computers at roughly 19 million IP addresses and sold as residential proxy access that customers used for fraud and other crimes.

If your organization is evaluating a provider for one of the narrow legitimate uses above, ask how IPs are sourced, what users were told and paid, how they opt out, how the provider vets its customers and use cases, and get the answers in the contract.

## Proxies are not a fix for blocks

Rotating IPs to keep scraping after a site blocks or rate limits you is evasion:

- **It overrides an explicit decision.** The block is the message; see [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md).
- **It raises legal risk.** In Craigslist v. 3Taps (N.D. Cal. 2013) a federal court let a CFAA claim proceed against a company that kept collecting data through proxies after a cease-and-desist letter and IP blocks. Later cases changed the CFAA landscape in other respects; get advice for your situation ([CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)).
- **It rarely works for long.** Bot management scores proxy networks, and fingerprints and behavior persist across IPs ([How Bot Detection Works](how-bot-detection-works.md)).
- **It harms bystanders** whose home or mobile IPs absorb the reputation damage.
- **It costs money.** Proxy bandwidth is often one of the largest line items of an evasive scraper ([Cost Control](../operations/cost-control.md)).

## Pitfalls

- Disabling TLS verification to get through a corporate proxy instead of installing its CA.
- Letting `HTTP_PROXY` or `HTTPS_PROXY` from a developer machine leak into production jobs, or forgetting `NO_PROXY` for internal hosts.
- Sending credentials for one site through a third-party proxy you do not control.
- Treating "residential" as a quality tier rather than a consent question.
- Changing egress IPs often, which makes your bot harder to verify and allowlist.

## Checklist

- [ ] Every proxy in use has a documented, legitimate purpose
- [ ] Egress IPs are stable and published on the bot page
- [ ] TLS verification stays on, with the right CA bundle configured
- [ ] No IP or proxy rotation used to continue after a block or rate limit
- [ ] Any third-party proxy provider vetted for sourcing and consent, in writing

## See Also

- [Identifying Your Bot](identifying-your-bot.md)
- [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md)
- [TLS and HTTPS for Scrapers](../http/tls-and-https.md)
- [CFAA and Key US Cases](../legal-ethics/cfaa-and-key-us-cases.md)
- [Cost Control](../operations/cost-control.md)
