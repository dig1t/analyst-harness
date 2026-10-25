---
tags: [scraping, anti-bot, fingerprinting, tls, privacy]
aliases: [browser fingerprinting, TLS fingerprinting, JA3, JA4, HTTP/2 fingerprinting, passive fingerprinting]
---

# Browser and TLS Fingerprinting

> Sources: Eckersley, "How Unique Is Your Web Browser?" (PETS 2010) (https://coveryourtracks.eff.org/static/browser-uniqueness.pdf); W3C, Mitigating Browser Fingerprinting in Web Specifications (https://www.w3.org/TR/fingerprinting-guidance/); Laperdrix, Rudametkin and Baudry, "Beauty and the Beast: Diverting Modern Web Browsers to Build Unique Browser Fingerprints" (IEEE S&P 2016); Mowery and Shacham, "Pixel Perfect: Fingerprinting Canvas in HTML5" (W2SP 2012); Salesforce, JA3 (https://github.com/salesforce/ja3); FoxIO, JA4+ (https://github.com/FoxIO-LLC/ja4); Shuster et al. (Akamai), "Passive Fingerprinting of HTTP/2 Clients" (Black Hat Europe 2017); Cloudflare docs, JA3/JA4 fingerprint (https://developers.cloudflare.com/bots/additional-configurations/ja3-ja4-fingerprint/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A fingerprint is a set of observable client characteristics that, taken together, identify the client software and sometimes the individual device, without cookies. The W3C distinguishes passive fingerprinting (what any request reveals: headers, IP address and network-level details), active fingerprinting (scripts probing the browser) and cookie-like re-identification through stored state. Fingerprints serve two purposes: tracking individuals across sites, which is a privacy problem, and classifying clients, for example checking whether a request that claims to be Chrome really comes from Chrome. Bot management relies on the second. This article explains what browser fingerprints, JA3 and JA4 are so you can reason about blocks. It does not cover altering fingerprints, which this vault treats as out of bounds.

## Browser (active) fingerprinting

Scripts read many attributes that are individually common but jointly rare:

- User-Agent and client hints, platform, languages, time zone
- Screen size, color depth, device pixel ratio, window metrics
- Hardware hints such as logical CPU count and device memory
- Installed fonts and media capabilities
- Canvas and WebGL rendering output, and the reported graphics vendor and renderer
- Audio processing output
- Supported APIs, permission states and CSS media features

Research established how identifying this is. Eckersley's Panopticlick study (PETS 2010) found that 83.6% of browsers in its sample had a unique fingerprint, rising to 94.2% among browsers with Flash or Java enabled. Mowery and Shacham (W2SP 2012) showed that drawing text to a canvas produces stable, distinguishing output, and the AmIUnique study by Laperdrix and colleagues (IEEE S&P 2016) measured modern attributes, including canvas and mobile browsers. Browsers have since worked to reduce this entropy, for example by trimming User-Agent detail and moving it into client hints, and the W3C guidance asks specification authors to minimize new fingerprinting surface.

## Passive network fingerprinting

### TLS: JA3 and JA4

The TLS ClientHello travels before encryption is established, and its contents depend on the TLS library and how the application configured it.

- **JA3** (Salesforce, 2017) takes five ClientHello fields in order (TLS version, cipher suites, extensions, elliptic curves, point formats), joins their decimal values with commas and dashes, and hashes the result with MD5 into a 32-character fingerprint. A JA3 string looks like `769,47-53-5-10-49161-49162-49171-49172-50-56-19-4,0-10-11,23-24-25,0`. JA3S does the same for the server's reply. Salesforce no longer maintains the project.
- **Extension randomization.** In early 2023 Chromium began randomizing the order of its TLS extensions, partly so servers would not hard-code logic around one fixed fingerprint. A single Chrome version then produced many JA3 values.
- **JA4** (FoxIO, 2023, maintained by JA3's original creator) sorts ciphers and extensions before hashing and adds readable fields. In `t13d1516h2_8daaf6152771_b186095e22b6`, `t` is TLS over TCP (`q` would be QUIC, `d` DTLS), `13` is TLS 1.3, `d` means SNI was present (`i` if not), `15` and `16` are the cipher and extension counts, and `h2` is the first and last character of the first ALPN value. The two hashes are truncated SHA-256 values of the sorted cipher list and of the sorted extensions plus signature algorithms. GREASE values are ignored.
- **JA4+** applies the idea to other layers: JA4S (server response), JA4H (HTTP client), JA4X (certificates), JA4T (TCP), JA4SSH and more. JA4 itself is BSD 3-Clause licensed; the other JA4+ methods use the FoxIO License 1.1, which allows internal and academic use but requires an OEM license to sell them as a product feature.

### HTTP/2

HTTP/2 clients differ in the SETTINGS values they send, their initial WINDOW_UPDATE, their use of priority information and the order of pseudo-headers such as `:method`, `:authority`, `:scheme` and `:path`. Akamai researchers described this passive fingerprint at Black Hat Europe 2017. Browsers, HTTP libraries and proxies each tend to produce recognizable combinations ([HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)).

### Headers and TCP

Header order and presence (summarized by JA4H) and TCP characteristics such as window size and options (JA4T, and older tools like p0f) add further passive signals.

## How bot management uses fingerprints

| Use | Example |
|---|---|
| Consistency checks | A request claims Chrome on Windows, but its TLS and HTTP/2 fingerprints match a scripting library |
| Population statistics | Cloudflare's JA4 signals include how often a fingerprint behaves like a browser, its cache hit ratio, and how it ranks by number of IPs and user agents |
| Known-bad lists | Fingerprints associated with malware or attack tools |
| Rate keys | Limits applied per fingerprint instead of per IP |
| Allowlisting | A stable, known fingerprint from a verified partner |

A fingerprint is one signal among many ([How Bot Detection Works](how-bot-detection-works.md)). On its own it rarely decides anything; contradictions between signals are what raise suspicion.

## What this means for your scraper

- **Your HTTP library has its own fingerprint, and that is fine.** An honest bot User-Agent on a library TLS stack is a consistent, truthful combination, and some sites allowlist exactly that.
- **Trouble starts with false claims.** A browser User-Agent on a library TLS stack is both detectable and deceptive. Do not impersonate browsers or other crawlers ([Identifying Your Bot](identifying-your-bot.md)).
- **Stability helps you.** A consistent fingerprint, User-Agent and egress IP make it easy for a site to recognize and permit your crawler.
- **Debugging your own traffic is legitimate.** The JA4 repository ships implementations for Wireshark, Zeek, Python and Rust that you can run on a packet capture of your own client.
- **If you are blocked**, follow [Recognizing Blocks and Responding Responsibly](blocks-and-responsible-response.md). Changing fingerprints to get past a block is evasion.

## Privacy note

Fingerprinting people is a privacy issue in its own right. The W3C guidance points out that it can correlate browsing without the user's knowledge or consent, and that clearing cookies or using a VPN does not prevent it. Scrapers should not collect visitor fingerprints or device identifiers from the sites they visit, and any such data that appears in scraped content is personal data ([Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)).

## Pitfalls

- Thinking the User-Agent string is your fingerprint; it is a small part of it.
- Assuming one JA3 value identifies Chrome; extension randomization ended that.
- Randomizing or spoofing fingerprints to blend in, which is deceptive, often more conspicuous, and out of scope here.
- Confusing fingerprints with IP reputation; both are evaluated, separately.

## Checklist

- [ ] One consistent, honest client identity per bot (User-Agent, HTTP library, egress IPs)
- [ ] No browser or crawler impersonation anywhere in the stack
- [ ] User-Agent and client library version logged, to help site owners investigate blocks
- [ ] No collection of visitor fingerprints from scraped pages

## See Also

- [How Bot Detection Works](how-bot-detection-works.md)
- [Identifying Your Bot](identifying-your-bot.md)
- [How Headless Browsers Are Detected](../browser-automation/headless-detection-explained.md)
- [TLS and HTTPS for Scrapers](../http/tls-and-https.md)
- [HTTP/2, HTTP/3 and Connection Reuse](../http/http2-http3-and-connection-reuse.md)
- [Personal Data: GDPR, CCPA and More](../legal-ethics/personal-data-gdpr-ccpa.md)
