---
tags: [scraping, crawling, deduplication, simhash, bloom-filter]
aliases: [dedup, dedupe, near-duplicate detection, SimHash, MinHash, Bloom filter, seen set]
---

# Deduplication (URLs and Content)

> Sources: Bloom, Space/time trade-offs in hash coding with allowable errors, CACM 1970 (https://doi.org/10.1145/362686.362692); Broder, On the resemblance and containment of documents, 1997 (https://doi.org/10.1109/SEQUEN.1997.666900); Charikar, Similarity estimation techniques from rounding algorithms, STOC 2002 (https://doi.org/10.1145/509907.509965); Manku, Jain and Das Sarma, Detecting near-duplicates for web crawling, WWW 2007 (https://doi.org/10.1145/1242572.1242592); Henzinger, Finding near-duplicate web pages: a large-scale evaluation of algorithms, SIGIR 2006 (https://doi.org/10.1145/1148170.1148222); Leskovec, Rajaraman and Ullman, Mining of Massive Datasets, chapter 3 (http://www.mmds.org/); datasketch documentation (https://ekzhu.com/datasketch/)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

A crawler deduplicates at three points. **Before fetching**, a seen-set of normalized URL keys stops it from requesting the same URL twice. **After fetching**, an exact content hash catches the same body served at different URLs (mirrors, session ids, soft 404 pages). **Near-duplicate detection** (shingling with MinHash, or SimHash) catches pages that differ only in boilerplate, dates or ads. Exact sets are simple and correct up to tens of millions of keys; Bloom filters trade a small, tunable false-positive rate for an order of magnitude less memory; SimHash stores 64 bits per document and finds near-duplicates by Hamming distance. Deduplicating extracted records (entity resolution) is a separate step covered in [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md).

## URL deduplication

1. Normalize the URL ([URL Normalization and Canonicalization](url-normalization.md)).
2. Hash the key to a fixed width (8 or 16 bytes of BLAKE2b, xxHash or SHA-256).
3. Check and insert atomically, so two workers cannot both claim a URL.

Width matters at scale. With a 64-bit hash the birthday bound gives a collision probability of about n^2 / 2^65: roughly 0.03% for 100 million URLs and about 3% for a billion. Collisions mean a URL is silently never fetched, so use 128-bit keys beyond a few hundred million.

| Seen-set | Memory for 100M URLs | Trade-off |
|---|---|---|
| Python `set` of ints | several GB (object overhead) | exact, simplest, one process |
| Sorted 8-byte hashes on disk (LMDB, RocksDB, SQLite) | about 0.8 GB plus index | exact, survives restarts |
| Redis set or hash | several GB of RAM | exact, shared by workers |
| Bloom filter at 0.1% false positives | about 180 MB | probabilistic, shared if stored in Redis |

IRLbot (Lee et al., WWW 2008) crawled over six billion pages by batching seen-checks against disk-resident sorted files (its DRUM structure) instead of random lookups; the same batching idea applies to any disk-backed store.

### Bloom filters

A Bloom filter is a bit array with k hash functions. It never forgets a member (no false negatives) but sometimes claims an unseen URL was seen (false positive), which in a crawler means that URL is skipped. Sizing for n items at false-positive rate p:

- bits m = -n ln(p) / (ln 2)^2
- hash functions k = (m / n) ln 2

So 100 million URLs at p = 0.001 need about 180 MB and k = 10; a billion URLs at p = 0.01 need about 1.2 GB and k = 7. Plain Bloom filters cannot delete and degrade when you exceed capacity: size for the whole crawl, or use a scalable variant. Redis offers Bloom filters as a probabilistic data type (`BF.RESERVE`, `BF.ADD`, `BF.EXISTS`), which gives multiple workers one shared filter. Do not use a Bloom filter for URLs you are obliged to fetch (a client's list, a sitemap you must cover completely); a false positive there is data loss.

## Exact content deduplication

Hash what you consider "the content", not necessarily the raw bytes. Raw-body hashes break on per-request noise: CSRF tokens, timestamps, ad slots, nonce attributes. Two practical levels:

- **Raw hash** (SHA-256 of the decompressed body): detects byte-identical responses, for example a soft 404 template returned for every unknown path, or one document mirrored on many URLs.
- **Normalized hash**: hash the extracted main text (boilerplate removed, Unicode normalized, whitespace collapsed; see [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md)). This also powers change detection between crawls ([Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)).

When many URLs on one host share a raw hash, treat it as a trap signal, not just a duplicate (see [Spider Traps and Crawl Hygiene](spider-traps.md)).

## Near-duplicate detection

Both standard techniques start by turning a document into **shingles**: overlapping word n-grams (3 to 5 words is typical) of the cleaned text.

**MinHash (Broder, 1997)** estimates the Jaccard similarity of two shingle sets. With 128 random hash functions, the fraction of positions where two signatures agree estimates Jaccard. To avoid comparing all pairs, **LSH banding** splits the signature into b bands of r rows; two documents become candidates if any band matches exactly, which happens with probability 1 - (1 - s^r)^b for similarity s. The threshold sits near (1/b)^(1/r), so 16 bands of 8 rows put it around 0.7.

**SimHash (Charikar, 2002)** maps a weighted feature set to one 64-bit fingerprint whose Hamming distance tracks the angle between feature vectors: the expected fraction of differing bits is theta/pi. Manku, Jain and Das Sarma used 64-bit SimHash at Google on 8 billion pages and found that treating fingerprints within 3 bits as near-duplicates worked for their features. Thresholds depend on features and document length, so calibrate: in a test with 600-word documents, two edited words plus a footer gave a distance of 6, while unrelated documents averaged 32.

| | MinHash + LSH | SimHash |
|---|---|---|
| Similarity estimated | Jaccard of shingle sets | cosine of weighted features |
| Storage per document | 128 values (0.5 to 1 KB) | 8 bytes |
| Threshold | any, set via bands and rows | small Hamming distance k |
| Strength | tunable, well understood | tiny, fast, easy to store in a column |

Henzinger's large-scale comparison (SIGIR 2006) found SimHash more precise than shingling overall, with both struggling on near-duplicates within the same site, where shared templates dominate. Remove boilerplate before hashing.

## Code

Standard library only (Python 3.10 or newer for `int.bit_count`). The index uses the pigeonhole trick from the Manku paper in its simplest form: split the fingerprint into k + 1 blocks, and any fingerprint within distance k must match the query exactly on at least one block.

```python
import hashlib
import math
import re
from collections import Counter


def shingles(text: str, k: int = 3) -> Counter:
    """Word k-grams with counts; lowercase, punctuation ignored."""
    words = re.findall(r"\w+", text.lower())
    return Counter(" ".join(words[i:i + k]) for i in range(max(1, len(words) - k + 1)))


def _h64(s: str) -> int:
    return int.from_bytes(hashlib.blake2b(s.encode(), digest_size=8).digest(), "big")


def simhash(text: str, bits: int = 64) -> int:
    """Charikar-style fingerprint: each weighted feature votes on every bit."""
    v = [0] * bits
    for feature, weight in shingles(text).items():
        h = _h64(feature)
        for i in range(bits):
            v[i] += weight if (h >> i) & 1 else -weight
    return sum(1 << i for i in range(bits) if v[i] > 0)


def hamming(a: int, b: int) -> int:
    return (a ^ b).bit_count()


class SimHashIndex:
    """Find fingerprints within Hamming distance k of a query.

    Split the 64 bits into k + 1 blocks. Two fingerprints that differ in at most k bits
    must agree exactly on at least one block (pigeonhole), so each block is a lookup key;
    candidates are then verified with hamming().
    """

    def __init__(self, k: int = 3, bits: int = 64):
        self.k = k
        edges = [round(i * bits / (k + 1)) for i in range(k + 2)]
        self.spans = list(zip(edges, edges[1:]))
        self.tables: list[dict[int, list[tuple[int, str]]]] = [{} for _ in self.spans]

    def _keys(self, fp: int) -> list[int]:
        return [(fp >> lo) & ((1 << (hi - lo)) - 1) for lo, hi in self.spans]

    def near(self, fp: int) -> set[str]:
        hits = set()
        for table, key in zip(self.tables, self._keys(fp)):
            for other, doc_id in table.get(key, []):
                if hamming(fp, other) <= self.k:
                    hits.add(doc_id)
        return hits

    def add(self, fp: int, doc_id: str) -> None:
        for table, key in zip(self.tables, self._keys(fp)):
            table.setdefault(key, []).append((fp, doc_id))


class BloomFilter:
    """Seen-set with a fixed false-positive rate; never a false negative."""

    def __init__(self, capacity: int, error_rate: float = 0.001):
        self.m = math.ceil(-capacity * math.log(error_rate) / math.log(2) ** 2)  # bits
        self.k = max(1, round(self.m / capacity * math.log(2)))                  # hash functions
        self.bits = bytearray((self.m + 7) // 8)

    def _positions(self, item: str):
        d = hashlib.blake2b(item.encode(), digest_size=16).digest()
        h1, h2 = int.from_bytes(d[:8], "little"), int.from_bytes(d[8:], "little") | 1
        return ((h1 + i * h2) % self.m for i in range(self.k))  # double hashing

    def add(self, item: str) -> bool:
        """Add item; return True if it was (probably) already present."""
        present = True
        for pos in self._positions(item):
            byte, bit = divmod(pos, 8)
            if not self.bits[byte] >> bit & 1:
                present = False
                self.bits[byte] |= 1 << bit
        return present

    def __contains__(self, item: str) -> bool:
        return all(self.bits[p // 8] >> (p % 8) & 1 for p in self._positions(item))
```

Usage: `idx = SimHashIndex(k=6)`, then for each cleaned document `fp = simhash(text)`; if `idx.near(fp)` is empty, keep it and `idx.add(fp, url)`. A Bloom filter built with `BloomFilter(100_000, 0.01)` measured a 1.02% false-positive rate on 100,000 unseen keys in testing.

For MinHash, use the `datasketch` library rather than writing your own:

```python
from datasketch import MinHash, MinHashLSH


def minhash(text: str, num_perm: int = 128) -> MinHash:
    m = MinHash(num_perm=num_perm)
    for shingle in shingles(text):          # shingles() from the block above
        m.update(shingle.encode("utf-8"))
    return m


article = (
    "The regional transit authority approved a two year plan on Monday to extend the "
    "light rail line north of the river, add three stations near the university and "
    "replace the oldest buses in the fleet. Officials said construction would begin in "
    "the spring and that fares would not change before the new stations open. Critics "
    "asked for more detail on how the project would be funded if federal grants fall short."
)
lsh = MinHashLSH(threshold=0.8, num_perm=128)   # picks bands and rows for you
lsh.insert("https://example.com/a", minhash(article))
print(lsh.query(minhash(article + " Share this story.")))  # ['https://example.com/a']
```

Real documents are longer than this example; very short texts have so few shingles that one added sentence moves the estimate a lot.

## Choosing thresholds

- Label a few hundred candidate pairs from your own corpus at several distances or similarities and pick the threshold from the precision you need.
- Calibrate per content type: short product pages and long articles behave differently.
- Keep the canonical choice deterministic (earliest fetched, or the URL matching `rel=canonical`) and record which URL a duplicate was folded into, for [Provenance and Lineage](../data-quality/provenance-and-lineage.md).

## Pitfalls

- Hashing raw HTML and concluding nothing is duplicated (per-request tokens make every body unique).
- Shingling pages with navigation and footers left in, so every page on a site looks similar.
- Reusing the Manku k = 3 threshold without checking it on your documents.
- Bloom filters sized for the first crawl, then overfilled; the false-positive rate climbs silently.
- Seen-sets that do not survive restarts, causing a full re-crawl after every deploy.
- Dropping near-duplicates that matter: price changes or a corrected figure are tiny edits.

## Checklist

- [ ] Normalized URL keys hashed to 128 bits at large scale, checked atomically.
- [ ] Seen-set persisted (disk or Redis) and shared across workers.
- [ ] Raw and normalized content hashes stored with each fetch.
- [ ] Boilerplate removed before near-duplicate hashing.
- [ ] SimHash or MinHash threshold calibrated on labeled pairs from your corpus.
- [ ] Duplicate decisions recorded with the URL they were merged into.

## See Also

- [URL Normalization and Canonicalization](url-normalization.md)
- [Spider Traps and Crawl Hygiene](spider-traps.md)
- [Distributed Crawling](distributed-crawling.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
- [Change Detection and Diffing](../data-quality/change-detection-and-diffing.md)
- [Converting HTML to Markdown and Text](../parsing/html-to-markdown.md)
