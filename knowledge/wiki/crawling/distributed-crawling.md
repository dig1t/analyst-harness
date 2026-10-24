---
tags: [scraping, crawling, distributed-systems, sharding, redis]
aliases: [distributed crawler, crawl cluster, host sharding, rendezvous hashing, consistent hashing, crawl leases, scrapy-redis]
---

# Distributed Crawling

> Sources: Boldi, Codenotti, Santini and Vigna, UbiCrawler: a scalable fully distributed Web crawler, Software: Practice and Experience 2004 (https://doi.org/10.1002/spe.587); Shkapenyuk and Suel, Design and implementation of a high-performance distributed Web crawler, ICDE 2002 (https://doi.org/10.1109/ICDE.2002.994750); Lee, Leonard, Wang and Loguinov, IRLbot, WWW 2008 (https://doi.org/10.1145/1367497.1367556); Karger et al., Consistent hashing and random trees, STOC 1997 (https://doi.org/10.1145/258533.258660); Thaler and Ravishankar, Using name-based mappings to increase hit rates (rendezvous hashing), IEEE/ACM ToN 1998 (https://doi.org/10.1109/90.663936); Olston and Najork, Web Crawling, 2010 (https://doi.org/10.1561/1500000017); Redis documentation, Scripting with Lua (https://redis.io/docs/latest/develop/programmability/eval-intro/); scrapy-redis (https://github.com/rmax/scrapy-redis)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Distribute a crawler only when one machine is genuinely not enough: a single async process is usually limited by politeness, not CPU, and IRLbot reached billions of pages on one server by getting its data structures right. When you do distribute, the central rule is **partition by host**. If every host has exactly one owner, that owner enforces robots.txt, rate limits and the per-host part of the seen-set locally, and workers never coordinate per request. Assign hosts with consistent or rendezvous hashing so adding a worker moves only its share. The alternative, a **shared frontier** in Redis or a database with **leases** (a host is checked out while fetched; a crashed worker's lease expires and its work is requeued), trades a central dependency for simpler elasticity. Either way, assume at-least-once processing: make fetch-and-store idempotent, bound every queue, and monitor per shard.

## Two architectures

| | Host-sharded workers | Shared frontier with leases |
|---|---|---|
| Who decides what to fetch | each worker, for the hosts it owns | any worker, claiming a ready host atomically |
| Politeness | local to the owner, exact | enforced by the shared store (one lease per host) |
| Discovered links for other hosts | sent to the owner's inbox (queue partition) | pushed into the shared store |
| Scaling up or down | rebalancing moves hosts and their state | add or remove workers freely |
| Failure of a worker | its hosts stall until reassigned | leases expire, work is requeued automatically |
| Central dependency | the message bus | the store (Redis, Postgres) |
| Classic examples | Mercator's distributed mode, UbiCrawler (consistent hashing), StormCrawler partitioning by host, domain or IP | scrapy-redis (shared queue and dupefilter in Redis), Crawlee request queues |

Partition by **registrable domain** or **IP** rather than hostname when many subdomains share servers, for the same reasons as in [Politeness and Rate Limiting](politeness-and-rate-limiting.md).

## Assigning hosts: rendezvous hashing

`hash(host) % N` reshuffles almost every host when N changes. Consistent hashing (Karger et al.) and rendezvous or highest-random-weight hashing (Thaler and Ravishankar) move only about 1/N of the hosts. Rendezvous hashing is a few lines and needs no ring:

```python
import hashlib


def owner(host: str, workers: list[str]) -> str:
    """Rendezvous (highest-random-weight) hashing: stable host -> worker assignment.
    Adding or removing a worker only moves the hosts that worker wins or loses."""
    def weight(worker: str) -> int:
        digest = hashlib.blake2b(f"{worker}|{host}".encode(), digest_size=8).digest()
        return int.from_bytes(digest, "big")
    return max(workers, key=weight)
```

With 10,000 hosts and four workers each got 24 to 26% of hosts; adding a fifth worker moved 21% of hosts, all of them to the new worker. Watch for hot shards: one giant host lives on one worker no matter how many you add, which is fine, because politeness caps its rate anyway.

## Shared frontier with leases (Redis)

The scripts below keep, per host, a Redis list of URLs; a sorted set `ready` maps each host to the earliest time it may be fetched; `inflight` records leased URLs with their expiry; `seen` deduplicates. Lua scripts run atomically, so two workers can never claim the same host, and server time (`TIME`) avoids clock skew between workers. Tested against a real Redis 7 server with three workers and a simulated crash: no host ever had two requests in flight, per-host gaps never fell below the configured delay, and the crashed worker's URL was requeued and fetched after its lease expired.

```python
import uuid

import redis.asyncio as redis

NOW = "local t = redis.call('TIME') local now = tonumber(t[1]) + tonumber(t[2]) / 1e6 "

ENQUEUE = NOW + """
if redis.call('SADD', KEYS[1], ARGV[1]) == 0 then return 0 end      -- seen before
redis.call('RPUSH', ARGV[3] .. ARGV[2], ARGV[1])
local not_before = tonumber(redis.call('HGET', KEYS[3], ARGV[2]) or now)
redis.call('ZADD', KEYS[2], 'NX', not_before, ARGV[2])              -- no-op if scheduled or leased
return 1
"""

CLAIM = NOW + """
local lease = tonumber(ARGV[1])
while true do
  local hosts = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)
  if #hosts == 0 then return false end
  local host = hosts[1]
  local url = redis.call('LPOP', ARGV[2] .. host)
  if url then
    redis.call('ZADD', KEYS[1], now + lease, host)                  -- host checked out
    redis.call('ZADD', KEYS[2], now + lease, host .. '\\t' .. url .. '\\t' .. ARGV[3])
    return {host, url}
  end
  redis.call('ZREM', KEYS[1], host)                                 -- empty queue
end
"""

COMPLETE = NOW + """
if redis.call('ZREM', KEYS[2], ARGV[1] .. '\\t' .. ARGV[2] .. '\\t' .. ARGV[3]) == 0 then
  return 0                                                          -- lease expired and was reaped
end
local not_before = now + tonumber(ARGV[4])
redis.call('HSET', KEYS[3], ARGV[1], not_before)
if redis.call('LLEN', ARGV[5] .. ARGV[1]) > 0 then
  redis.call('ZADD', KEYS[1], not_before, ARGV[1])
else
  redis.call('ZREM', KEYS[1], ARGV[1])
end
return 1
"""

REAP = NOW + """
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, item in ipairs(expired) do
  local host, url = string.match(item, '^([^\\t]*)\\t([^\\t]*)\\t')
  redis.call('LPUSH', ARGV[1] .. host, url)                         -- retry it first
  redis.call('ZADD', KEYS[1], now, host)
  redis.call('ZREM', KEYS[2], item)
end
return #expired
"""


class RedisFrontier:
    """Shared frontier: per-host lists, a ready zset with leases, crash recovery by reaping.

    Scripts touch per-host keys not listed in KEYS, so run this on a single Redis
    (or a Redis Cluster with all keys in one hash slot), not across cluster shards.
    """

    def __init__(self, r: redis.Redis, prefix: str = "crawl:"):
        self.r, self.p = r, prefix
        self.keys = {k: prefix + k for k in ("seen", "ready", "inflight", "next")}
        self._enqueue, self._claim = r.register_script(ENQUEUE), r.register_script(CLAIM)
        self._complete, self._reap = r.register_script(COMPLETE), r.register_script(REAP)

    async def enqueue(self, url: str, host: str) -> bool:
        k = self.keys
        return bool(await self._enqueue(keys=[k["seen"], k["ready"], k["next"]],
                                        args=[url, host, self.p + "q:"]))

    async def claim(self, lease_s: float = 120) -> tuple[str, str, str] | None:
        token = uuid.uuid4().hex
        got = await self._claim(keys=[self.keys["ready"], self.keys["inflight"]],
                                args=[lease_s, self.p + "q:", token])
        return (got[0].decode(), got[1].decode(), token) if got else None

    async def complete(self, host: str, url: str, token: str, gap_s: float) -> bool:
        k = self.keys
        return bool(await self._complete(keys=[k["ready"], k["inflight"], k["next"]],
                                         args=[host, url, token, gap_s, self.p + "q:"]))

    async def reap(self) -> int:
        return await self._reap(keys=[self.keys["ready"], self.keys["inflight"]],
                                args=[self.p + "q:"])
```

A worker loops: `claim()`, fetch, store, `enqueue()` the normalized links, then `complete(host, url, token, gap_s=max(min_delay, 10 * fetch_seconds))`. Run `reap()` every few seconds from any process. The lease token stops a slow worker whose lease already expired from rescheduling a host that another worker now holds. Set the lease comfortably above your fetch timeout. The `seen` set grows without bound; at large scale replace it with a Bloom filter or a sharded store (see [Deduplication](deduplication.md)).

## Coordination and failure handling

- **At-least-once is the norm.** Leases, SQS visibility timeouts and Kafka consumer rebalances all redeliver work after failures. Make storage idempotent: key raw responses by content hash, upsert records by natural key plus fetch time (see [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)).
- **Poison URLs.** Count attempts per URL; after a few failures move it to a dead-letter list with the error, instead of letting it cycle forever.
- **Checkpoints.** Persist frontier and seen-set (Redis AOF or snapshots, database tables, Kafka retention). A crawl that cannot resume after a deploy will be restarted from zero.
- **Backpressure.** Bound queues and stop link discovery for a host or shard when its queue is full; let the frontier, not the fetchers, decide what to drop (see [Queues and Workers](../operations/queues-and-workers.md)).
- **Shared rate limits.** If several workers must call the same API, use one central limiter (a Redis token bucket or GCRA script) rather than per-process limits; see [API Rate Limits and Quotas](../apis/api-rate-limits.md).
- **DNS and connections.** Run a caching resolver per node and reuse HTTP connections; a cluster that re-resolves every URL can overload DNS before it overloads anyone's web server.

## Operating a fleet

- Metrics per shard and per host: queue depth, oldest queued URL, fetches per minute, status mix, lease expiries, dead letters ([Monitoring and Alerting](../operations/monitoring-and-alerting.md)).
- One configuration source for User-Agent, robots handling and rate limits, so every worker behaves identically ([Identifying Your Bot](../anti-bot/identifying-your-bot.md)).
- Rolling deploys that drain workers (finish leases) before stopping them.
- Cost awareness: bandwidth, storage and browser workers dominate; see [Cost Control](../operations/cost-control.md).

## Pitfalls

- Per-process politeness in a fleet: ten Scrapy processes sharing a scrapy-redis queue each apply their own per-domain limit, so a site sees ten times the intended rate.
- Modulo sharding that reshuffles every host (and its politeness state) whenever a worker is added.
- Leases shorter than the slowest fetch, causing duplicate fetches and double-counted politeness.
- Workers using their own clocks for "not before" times; skew breaks spacing. Use the store's clock.
- Unbounded seen-sets and queues in Redis memory.
- Distributing before profiling: the single-process version was waiting on politeness, so the cluster only added cost.

## Checklist

- [ ] One owner per host (sharding) or one lease per host (shared frontier), never per-process politeness.
- [ ] Consistent or rendezvous hashing for assignment; hot hosts accepted as single-owner.
- [ ] Leases longer than fetch timeouts; reaper requeues expired work; lease tokens prevent stale completions.
- [ ] Idempotent storage, attempt counters and a dead-letter queue.
- [ ] Bounded queues, persisted state and per-shard metrics.
- [ ] Central configuration for identity, robots handling and limits.

## See Also

- [Crawler Architecture](crawler-architecture.md)
- [URL Frontier and Scheduling](url-frontier-and-scheduling.md)
- [Politeness and Rate Limiting](politeness-and-rate-limiting.md)
- [Queues and Workers](../operations/queues-and-workers.md)
- [Retries, Backoff and Idempotency](../operations/retries-backoff-idempotency.md)
- [Deduplication (URLs and Content)](deduplication.md)
