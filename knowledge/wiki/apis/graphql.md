---
tags: [scraping, apis, graphql, pagination, persisted-queries]
aliases: [GraphQL API, GraphQL endpoint, introspection, persisted queries, APQ, Relay connections]
---

# GraphQL Endpoints

> Sources: GraphQL Specification, September 2025 edition (https://spec.graphql.org/September2025/); GraphQL-over-HTTP specification, working draft (https://graphql.github.io/graphql-over-http/); Relay, GraphQL Cursor Connections Specification (https://relay.dev/graphql/connections.htm); Apollo documentation, Automatic persisted queries (https://www.apollographql.com/docs/apollo-server/performance/apq); GitHub Docs, Rate limits and query limits for the GraphQL API (https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api); graphql-ws protocol (https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A GraphQL API exposes one endpoint (usually `POST /graphql`) and a typed schema; the client sends a query document plus variables and gets back exactly the fields it asked for, in a `{"data": ..., "errors": [...]}` envelope. For data collection that is attractive: one request can replace a dozen REST calls, and you never download fields you do not need. The traps are specific: an HTTP 200 can still carry errors (and partial data), lists are paged through **connections** with opaque cursors, servers limit **query cost** rather than request count, introspection may be disabled, and production sites often accept only **persisted queries** (operations registered in advance and referenced by hash). The current spec edition is September 2025; the GraphQL-over-HTTP working draft defines how requests and status codes map onto HTTP.

## Request and response anatomy

```http
POST /graphql HTTP/1.1
Content-Type: application/json
Accept: application/graphql-response+json, application/json;q=0.9

{"query": "query Repo($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { stargazerCount } }",
 "variables": {"owner": "octocat", "name": "Hello-World"},
 "operationName": "Repo"}
```

- **Always send variables** instead of interpolating values into the query string; it avoids injection and lets servers cache the parsed document.
- **GET** is allowed for queries (not mutations) with `query`, `variables` and `operationName` as URL parameters, which makes them cacheable by CDNs.
- **Responses**: `data` holds the result, `errors` is a list of objects with `message` and usually `locations`, `path` and `extensions` (often a machine-readable `code`). A response can contain both: some fields resolved, others failed with `null`.
- **Status codes**: legacy servers answering with `application/json` typically use 200 for every well-formed request, even when `errors` is present. Under the GraphQL-over-HTTP draft, servers using `application/graphql-response+json` answer requests that produce no data with 4xx or 5xx (for example 400 when the JSON body or the GraphQL document cannot be parsed, 422 for a malformed GraphQL-over-HTTP request). Check the body either way.

## Discovering the schema

- **Documentation and explorers.** Public APIs (GitHub, Shopify, GitLab and others) document their schema and host an explorer such as GraphiQL.
- **Introspection.** The `__schema` and `__type` meta-fields return the schema itself: `{ __schema { queryType { name } types { name kind fields { name } } } }`. Tools like GraphiQL build autocomplete from it, and schema-diff tools such as GraphQL Inspector can alert you when fields you depend on change.
- **Disabled introspection** is a deliberate choice by the operator not to publish the schema. Work from the operations the site's own frontend sends (visible in DevTools, see [Finding Hidden APIs with DevTools](finding-hidden-apis.md)) and do not try to reconstruct the schema by probing error messages or guessing fields.

## Persisted queries

**Automatic persisted queries (APQ)**, popularized by Apollo, are a bandwidth optimization: the client first sends only `extensions: {"persistedQuery": {"version": 1, "sha256Hash": "<sha256 of the query text>"}}`; if the server does not know the hash it answers with a `PersistedQueryNotFound` error and the client resends with the full query, after which the hash alone works. Many sites send these as GET requests, so the hash appears in the URL.

**Persisted operations allowlists** ("trusted documents") are a security control: the server accepts only operations registered at build time. You can replay the exact operations the frontend uses (same hash, your own variables), but you cannot write new queries. Treat that as the boundary the operator set; if you need different data, look for a documented API or ask.

## Pagination with connections

Relay's Cursor Connections Specification is the dominant convention: a field takes `first` and `after` (or `last` and `before`) and returns `edges { cursor node { ... } }` plus `pageInfo { hasNextPage endCursor }`. Loop with `after: endCursor` until `hasNextPage` is false. Many schemas also offer a `nodes` shortcut that skips the edge wrapper. Rules from [Pagination Patterns](../crawling/pagination-patterns.md) apply: cursors are opaque, can expire, and must not be edited. Nested connections (issues, each with comments) multiply cost quickly; page the outer list, then fetch inner lists separately for the items that need them.

## Cost limits

GraphQL servers limit what a query *costs*, not just how many requests you send. GitHub, as a documented example: 5,000 points per hour for users, a secondary limit of 2,000 points per minute on the GraphQL endpoint, every connection must specify `first` or `last` between 1 and 100, and a single call may not request more than 500,000 total nodes. Ask for the `rateLimit { cost remaining resetAt }` object in the same query to see what each call spends. Other servers enforce maximum depth, complexity scores or timeouts. Smaller, flatter queries are both cheaper and less likely to time out. See [API Rate Limits and Quotas](api-rate-limits.md).

## Code: execute, paginate, persisted queries

Python 3.11 with `httpx`. Tested against a mock server: a 250-item connection paged in three requests, a validation error delivered with HTTP 200 raised as an exception, and an APQ round trip (hash rejected, full query registered, hash accepted).

```python
import hashlib
import json
from collections.abc import AsyncIterator

import httpx

ACCEPT = "application/graphql-response+json, application/json;q=0.9"


class GraphQLError(Exception):
    def __init__(self, errors: list[dict], data: dict | None = None):
        self.errors, self.data = errors, data             # data may be partial
        super().__init__("; ".join(e.get("message", "?") for e in errors))


def _result(r: httpx.Response) -> dict:
    if "json" not in r.headers.get("content-type", ""):
        r.raise_for_status()                               # HTML error page, proxy error, ...
    body = r.json()
    if body.get("errors"):                                 # HTTP 200 does not mean success
        raise GraphQLError(body["errors"], body.get("data"))
    return body["data"]


async def execute(client: httpx.AsyncClient, url: str, query: str,
                  variables: dict | None = None) -> dict:
    r = await client.post(url, json={"query": query, "variables": variables or {}},
                          headers={"Accept": ACCEPT})
    return _result(r)


async def execute_persisted(client: httpx.AsyncClient, url: str, query: str,
                            variables: dict | None = None) -> dict:
    """Apollo automatic persisted queries: send the hash first, the full text only if unknown."""
    ext = {"persistedQuery": {"version": 1, "sha256Hash": hashlib.sha256(query.encode()).hexdigest()}}
    params = {"variables": json.dumps(variables or {}), "extensions": json.dumps(ext)}
    try:
        return _result(await client.get(url, params=params, headers={"Accept": ACCEPT}))
    except GraphQLError as e:
        if not any(err.get("message") == "PersistedQueryNotFound" for err in e.errors):
            raise
    r = await client.post(url, json={"query": query, "variables": variables or {}, "extensions": ext},
                          headers={"Accept": ACCEPT})
    return _result(r)


async def connection_nodes(client: httpx.AsyncClient, url: str, query: str, variables: dict,
                           path: list[str], max_pages: int = 1000) -> AsyncIterator[dict]:
    """Walk a Relay-style connection (first/after, pageInfo.endCursor) located at `path`."""
    after = None
    for _ in range(max_pages):
        data = await execute(client, url, query, {**variables, "after": after})
        conn = data
        for key in path:
            conn = conn[key]
        for edge in conn["edges"]:
            yield edge["node"]
        if not conn["pageInfo"]["hasNextPage"]:
            return
        after = conn["pageInfo"]["endCursor"]
    raise RuntimeError("max_pages reached")


ISSUES = """
query Issues($owner: String!, $name: String!, $after: String) {
  rateLimit { cost remaining resetAt }
  repository(owner: $owner, name: $name) {
    issues(first: 100, after: $after, states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      edges { node { number title updatedAt } }
    }
  }
}
"""
```

Usage against GitHub (requires a token): create `httpx.AsyncClient(headers={"Authorization": f"Bearer {token}", "User-Agent": "ExampleBot/1.0"})`, then `async for issue in connection_nodes(client, "https://api.github.com/graphql", ISSUES, {"owner": "OWNER", "name": "REPO"}, ["repository", "issues"])`.

## Subscriptions

Real-time GraphQL subscriptions usually run over WebSockets using the `graphql-ws` library's protocol (subprotocol `graphql-transport-ws`, messages `connection_init`, `subscribe`, `next`, `complete`), or the older `subscriptions-transport-ws` protocol, which confusingly used the subprotocol name `graphql-ws`. Some servers stream over Server-Sent Events instead. Capturing and consuming these is covered in [WebSockets and Server-Sent Events](websockets-and-sse.md).

## Pitfalls

- Treating HTTP 200 as success and storing `null` fields from a partially failed query.
- Building query strings with f-strings instead of variables.
- Deeply nested queries that hit cost or timeout limits; split them.
- Paginating only the outer connection and silently truncating inner lists at `first: 100`.
- Hard-coding a persisted-query hash that changes on the site's next deploy; detect `PersistedQueryNotFound` and alert.
- Writing new operations against an allowlisted endpoint, or probing a schema whose introspection is disabled.

## Checklist

- [ ] Documented schema or the frontend's own operations identified; terms reviewed.
- [ ] Variables for every input; `operationName` set for logging.
- [ ] `errors` checked on every response, including HTTP 200.
- [ ] Connections paged with `first`/`after` until `hasNextPage` is false; inner connections handled.
- [ ] Query cost measured (`rateLimit` or equivalent) and kept within budget.
- [ ] Schema drift detected (introspection diff where allowed, or response validation).

## See Also

- [Consuming REST APIs Well](rest-api-consumption.md)
- [Finding Hidden APIs with DevTools](finding-hidden-apis.md)
- [API Rate Limits and Quotas](api-rate-limits.md)
- [Pagination Patterns](../crawling/pagination-patterns.md)
- [WebSockets and Server-Sent Events](websockets-and-sse.md)
- [GitHub and Developer Data](../sources/github-and-developer-data.md)
