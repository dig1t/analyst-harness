---
tags: [scraping, http, tls, certificates, security]
aliases: [TLS, HTTPS, SSL errors, CA bundle, Certificate verification, SNI]
---

# TLS and HTTPS for Scrapers

> Sources: RFC 8446, TLS 1.3 (https://www.rfc-editor.org/rfc/rfc8446); RFC 6066, TLS Extensions including SNI (https://www.rfc-editor.org/rfc/rfc6066); RFC 7301, ALPN (https://www.rfc-editor.org/rfc/rfc7301); RFC 8996, Deprecating TLS 1.0 and TLS 1.1 (https://www.rfc-editor.org/rfc/rfc8996); RFC 9849, TLS Encrypted Client Hello (https://www.rfc-editor.org/rfc/rfc9849); CA/Browser Forum, Baseline Requirements (https://cabforum.org/working-groups/server/baseline-requirements/); Python ssl module (https://docs.python.org/3/library/ssl.html); truststore (https://github.com/sethmlarson/truststore); Node.js CLI docs, NODE_EXTRA_CA_CERTS and --use-system-ca (https://nodejs.org/api/cli.html); curl, SSL certificate verification (https://curl.se/docs/sslcerts.html); Ivan Ristić, Bulletproof TLS and PKI, Feisty Duck (https://www.feistyduck.com/books/bulletproof-tls-and-pki/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

TLS gives a scraper two guarantees: the server really is the host in the URL (a certificate chain to a trusted root, valid dates, a matching name) and nobody in between can read or alter the traffic. Nearly every target is HTTPS, so TLS problems are routine: an unknown issuer behind a corporate proxy, a server that omits an intermediate certificate, an outdated CA bundle, a name mismatch from connecting by IP, an expired certificate. The fix is always to correct trust, never to switch verification off. Disabling verification exposes your credentials and lets anything on the path feed you fabricated data, which is a data-quality failure as much as a security one.

## What happens in the handshake

1. **ClientHello.** The client offers TLS versions and ciphers, sends the host name in SNI (RFC 6066) so a shared IP can pick the right certificate, and lists application protocols in ALPN (`h2`, `http/1.1`).
2. **Server certificate.** The server returns its leaf certificate plus intermediates.
3. **Verification by the client.** The chain must lead to a root in the client's trust store, every certificate must be within its validity dates, and the leaf's Subject Alternative Names must cover the requested host.
4. **Encrypted HTTP** over the negotiated protocol.

TLS 1.3 (RFC 8446) and TLS 1.2 are current; TLS 1.0 and 1.1 are deprecated (RFC 8996). Encrypted Client Hello (RFC 9849) hides SNI from observers and changes nothing for a correctly configured client. Certificates are getting shorter-lived: under CA/Browser Forum ballot SC-081 the maximum validity drops to 200 days from March 2026, 100 days from March 2027 and 47 days from March 2029. Expect frequent rotation and never pin leaf certificates.

## Where each client gets its trust

| Client | Default trust store | How to add a CA |
|---|---|---|
| requests | certifi (Mozilla bundle) | `verify="/path/ca.pem"`, or `REQUESTS_CA_BUNDLE` / `CURL_CA_BUNDLE` |
| httpx 0.28 | certifi, or `SSL_CERT_FILE` / `SSL_CERT_DIR` when set | `verify=ssl.create_default_context(cafile=...)` (string paths are deprecated) |
| httpx2, niquests | Operating system store | Add the CA to the OS store, or pass an `ssl.SSLContext` |
| Python `ssl` | OpenSSL default paths (system store on Linux distributions) | `ssl.create_default_context(cafile=...)` |
| Any Python 3.10+ client | `truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)` uses the OS store | Pass the context as `verify=` |
| Node.js | Bundled Mozilla roots | `NODE_EXTRA_CA_CERTS=/path/ca.pem` (read at startup); `--use-system-ca` (Node 23.8 and later) or `NODE_USE_SYSTEM_CA=1` (24.6, 22.19) for the OS store |
| curl | Depends on the build (CA file on Linux, native store on Windows) | `--cacert`, `--capath`, `CURL_CA_BUNDLE`; `--ca-native` (8.2.0 and later) for the OS store |
| Playwright browsers | Browser or OS store | OS store, or `ignore_https_errors` only for test environments you own |

A classic surprise: the python.org installer for macOS ships its own OpenSSL and does not read the Keychain; it relies on its "Install Certificates" step, which installs certifi.

## Corporate proxies and TLS interception

Many companies, and some CI and sandbox environments, route HTTPS through a proxy that re-terminates TLS with its own CA. Your scraper then receives certificates issued by something like "Corp Proxy Issuing CA" instead of a public CA, and verification fails until that CA is trusted.

- **Diagnose:** look at the issuer of the certificate you actually receive (snippet below). A private issuer on a public site means interception.
- **Fix:** get the proxy root certificate in PEM format from the network team and add it through the mechanisms above. If a tool replaces rather than extends the default store, build a combined bundle: `cat "$(python -m certifi)" corp-root-ca.pem > combined.pem`.
- **Proxy variables:** requests and httpx honor `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` by default (`trust_env=True`). Node ignores them unless started with `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` (Node 24.0 and 22.21), or given an undici `EnvHttpProxyAgent`.

```python
import ssl

import httpx
import truststore  # pip install truststore (Python 3.10+)

# Option A: trust exactly the CA you were given (for example the proxy root).
corp_only = ssl.create_default_context(cafile="corp-root-ca.pem")
# Option B: trust what the operating system trusts (where IT usually installs the proxy CA).
system = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)

with httpx.Client(verify=system, timeout=15.0) as client:  # or verify=corp_only
    r = client.get("https://example.com/")
```

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/corp-root-ca.pem node scraper.ts
curl --cacert corp-root-ca.pem https://example.com/
```

## Diagnosing failures

| Message | Likely cause | Fix |
|---|---|---|
| Python: `CERTIFICATE_VERIFY_FAILED ... unable to get local issuer certificate`; curl: `(60) SSL certificate problem: unable to get local issuer certificate`; Node: `UNABLE_TO_VERIFY_LEAF_SIGNATURE` or `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | Unknown root (interception, private CA) or the server omits an intermediate | Trust the right CA; for a missing intermediate, add it to your bundle and tell the site owner |
| `SELF_SIGNED_CERT_IN_CHAIN`, `self-signed certificate in certificate chain` | Interception proxy or private PKI | Trust that specific CA for that client |
| Python: `Hostname mismatch, certificate is not valid for 'host'`; Node: `ERR_TLS_CERT_ALTNAME_INVALID` | Wrong host name, connecting by IP, or a CDN default certificate | Use the real host name; to target one IP, keep the name and pin the address (`curl --resolve host:443:IP`) |
| `certificate has expired`, `CERT_HAS_EXPIRED` | The site's certificate expired, or your clock is wrong | Check the system clock; otherwise wait and report it |
| `wrong version number`, `unsupported protocol` | Speaking TLS to a plain-HTTP port, or a server limited to old TLS versions | Check scheme and port; isolate any legacy exception to that one host |
| `handshake failure` alert | No common cipher, missing SNI, or a client certificate is required | Check SNI, TLS settings and whether the API expects mTLS |

"It works in my browser" is common with missing intermediates: some browsers fetch them from the certificate's AIA URL or ship them preloaded, while OpenSSL-based clients do not.

## Inspecting what you get

```python
import socket
import ssl
from datetime import datetime, timezone


def tls_info(host: str, port: int = 443, cafile: str | None = None) -> dict:
    """Handshake like a client would and report what was negotiated and when the cert expires."""
    ctx = ssl.create_default_context(cafile=cafile)  # verification and hostname checks stay on
    ctx.set_alpn_protocols(["h2", "http/1.1"])
    with socket.create_connection((host, port), timeout=10) as sock:
        with ctx.wrap_socket(sock, server_hostname=host) as tls:  # server_hostname also sets SNI
            cert, version, alpn = tls.getpeercert(), tls.version(), tls.selected_alpn_protocol()
    expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(cert["notAfter"]), tz=timezone.utc)
    return {
        "tls": version,
        "alpn": alpn,
        "issuer": dict(item[0] for item in cert["issuer"]).get("commonName"),
        "names": [value for kind, value in cert.get("subjectAltName", ()) if kind == "DNS"],
        "days_left": (expires - datetime.now(timezone.utc)).days,
    }


print(tls_info("example.com"))
# {'tls': 'TLSv1.3', 'alpn': 'h2', 'issuer': '...', 'names': [...], 'days_left': 41}
```

From a shell: `openssl s_client -connect example.com:443 -servername example.com -alpn h2,http/1.1 -showcerts` prints the chain the server really sends, and `curl -v` shows the handshake summary.

## Never disable verification

`verify=False`, `curl -k`, `NODE_TLS_REJECT_UNAUTHORIZED=0` and `rejectUnauthorized: false` turn off the only thing proving you talk to the real site. Captive portals, misrouted DNS and attackers can then inject content that your pipeline stores as fact, and the setting tends to leak from a debugging session into production. If you control a host with a private certificate, trust that CA for that client only. If a third-party site has a broken certificate, report it and pause; do not scrape through it.

## Client certificates (mTLS)

Some B2B and financial APIs require a client certificate. Load it into the context (`ctx.load_cert_chain("client.pem", "client.key")`) and pass `verify=ctx` in httpx (the separate `cert=` argument is deprecated in httpx 0.28), `cert=(crt, key)` in requests, or `--cert` and `--key` in curl. Store the key like any other secret ([Secrets and Configuration](../operations/secrets-and-config.md)).

## Pitfalls

- **Turning verification off** to "get unblocked", then forgetting it is off.
- **Replacing instead of extending** the trust store, so adding the corporate CA breaks every public site.
- **Stale bundles** in old containers or pinned `certifi` versions: new roots are missing and old ones linger.
- **Connecting by IP** or overriding `Host` without SNI, getting the default certificate.
- **Pinning leaf certificates or fingerprints** while lifetimes shrink toward 47 days.
- **Ignoring the clock**: a VM with a wrong date fails every handshake.
- **Assuming Node reads proxy variables** like Python does.

## Checklist

- [ ] Verification on everywhere, enforced in code review and linting
- [ ] Corporate or private CAs added explicitly, scoped to the clients that need them
- [ ] CA bundles and base images updated regularly
- [ ] Real host names and SNI used; `--resolve`-style pinning when targeting one IP
- [ ] Certificate expiry and issuer of key targets monitored
- [ ] Client keys stored as secrets

## See Also

- [HTTP/2, HTTP/3 and Connection Reuse](http2-http3-and-connection-reuse.md)
- [Proxies: Types, Uses and Ethics](../anti-bot/proxies-overview.md)
- [Secrets and Configuration](../operations/secrets-and-config.md)
- [Authentication Patterns](authentication-patterns.md)
- [curl and HTTPie Cheatsheet](curl-cheatsheet.md)
