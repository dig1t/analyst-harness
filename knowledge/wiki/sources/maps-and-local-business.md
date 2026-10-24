---
tags: [scraping, sources, openstreetmap, geocoding, local-business]
aliases: [OSM, Overpass API, Nominatim, POI data, points of interest]
---

# Maps and Local Business Data

> Sources: OSMF, Nominatim Usage Policy (https://operations.osmfoundation.org/policies/nominatim/); OpenStreetMap Wiki, Overpass API (https://wiki.openstreetmap.org/wiki/Overpass_API); OSMF, Tile Usage Policy (https://operations.osmfoundation.org/policies/tiles/); OpenStreetMap, Copyright and License (https://www.openstreetmap.org/copyright); Open Data Commons, Open Database License (https://opendatacommons.org/licenses/odbl/); Geofabrik download server (https://download.geofabrik.de/); Overture Maps, Places guide (https://docs.overturemaps.org/guides/places); Google Maps Platform Terms of Service (https://cloud.google.com/maps-platform/terms); Google Maps Platform Service Specific Terms (https://cloud.google.com/maps-platform/terms/maps-service-terms)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Map and point-of-interest (POI) data comes from three worlds. OpenStreetMap (OSM) is open data under the ODbL, served by volunteer-run public services with strict fair-use policies, and available in full as downloadable extracts. Open POI datasets such as Overture Maps' places theme publish permissively licensed business locations. Commercial map platforms (Google, Apple, HERE, Mapbox and others) sell API access under terms that forbid scraping and limit caching. For local business details not covered by these, individual business websites publish `LocalBusiness` structured data. Pick by license first, then by coverage.

## OpenStreetMap access options

- **Bulk files.** The weekly planet file (`planet.openstreetmap.org`) and daily regional extracts in `.osm.pbf` format from Geofabrik are the right choice for anything bigger than a neighborhood. Load them with osmium, osm2pgsql or DuckDB spatial tooling and query locally.
- **Overpass API** for targeted queries by tag and area. The main instance, `https://overpass-api.de/api/interpreter`, is run by FOSSGIS. Its guidance (as of 2026-10): you are safe below 10,000 queries per day and 1 GB of downloads per day, and if you run something regularly you should divide those numbers by 100. Usage by all users of your app counts together, apps should send an identifying User-Agent or Referer, and commercial use should go to self-hosted or paid Overpass instances.
- **Nominatim** (`nominatim.openstreetmap.org`) for geocoding. The usage policy (as of 2026-10): an absolute maximum of 1 request per second for the whole application, a valid identifying User-Agent or Referer (stock library user agents are not acceptable), results must be cached on your side, attribution displayed, and client-side autocomplete against the public instance is not allowed. Bulk geocoding is discouraged; small one-off bulk jobs must run single-threaded from a single machine, and periodic or long-running jobs are expected to go considerably slower. For volume, run your own Nominatim (or Photon or Pelias) on an extract.
- **Tiles.** `tile.openstreetmap.org` forbids bulk downloading, prefetching and offline use, and requires a proper application User-Agent. Use a commercial tile provider or render your own.

## Minimal example

```python
import functools
import time
import httpx

UA = "ExampleGeoBot/1.0 (+https://example.org/bot; geo@example.org)"

QUERY = """
[out:json][timeout:60];
node["amenity"="cafe"](52.50,13.37,52.53,13.43);
out body;
"""   # bounding box order: south, west, north, east

r = httpx.post("https://overpass-api.de/api/interpreter", data={"data": QUERY},
               headers={"User-Agent": UA}, timeout=90)
r.raise_for_status()
cafes = [{"osm_id": e["id"], "name": e.get("tags", {}).get("name"), "lat": e["lat"], "lon": e["lon"],
          "opening_hours": e.get("tags", {}).get("opening_hours")} for e in r.json()["elements"]]

_last = 0.0

@functools.lru_cache(maxsize=10_000)        # use a persistent cache in production
def geocode(q: str):
    """Nominatim lookup throttled to under 1 request/second, cached."""
    global _last
    wait = 1.1 - (time.monotonic() - _last)
    if wait > 0:
        time.sleep(wait)
    _last = time.monotonic()
    resp = httpx.get("https://nominatim.openstreetmap.org/search",
                     params={"q": q, "format": "jsonv2", "limit": 1},
                     headers={"User-Agent": UA}, timeout=30)
    resp.raise_for_status()
    hits = resp.json()
    return (float(hits[0]["lat"]), float(hits[0]["lon"])) if hits else None
```

## OSM data model

OSM has nodes (points), ways (lines and polygons) and relations, each with free-form tags such as `amenity=cafe`, `shop=bakery`, `name`, `addr:*` and `opening_hours` (which has its own syntax; parse it with a dedicated library). A business can be a node or a building way, so query `nwr[...]` and use `out center` when you need one coordinate per feature. Ids identify OSM objects, not real-world businesses: features get deleted and redrawn. Coverage and tag consistency vary a lot by region.

## Open POI datasets

Overture Maps publishes a places theme as GeoParquet in cloud storage, with regular releases. Since the 2025-09-24 release the places data is multi-licensed per record according to its `source`: Foursquare-sourced records are Apache 2.0 (with notice and change-statement obligations), most others are CDLA Permissive 2.0, and AllThePlaces records are CC0. Filter on the source property if you need a single license. Joining these datasets with OSM data can make the result a derivative database under the ODbL.

## Commercial map platforms

Google Maps Platform terms prohibit scraping or exporting Google Maps content for use outside the services, so collecting business listings or reviews from Google Maps pages is out of bounds. The APIs also restrict storage: the service terms allow temporarily caching Places latitude and longitude values for up to 30 consecutive days, while place IDs may be stored under the Places API policies. Other providers have similar clauses. Use their APIs for what the license allows (display, routing, lookups) and store only the identifiers you are permitted to keep.

## Local business websites

Chains publish store locators, usually backed by JSON endpoints, and individual businesses often include `LocalBusiness` JSON-LD (`name`, `address`, `geo`, `telephone`, `openingHoursSpecification`). The open AllThePlaces project maintains spiders for store locators and releases the output under CC0, which may already cover the brands you need. See [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md).

## Attribution and license obligations

OSM data requires the credit "© OpenStreetMap contributors" with a link to the copyright page. Under the ODbL, a derivative database that you distribute must be shared under the ODbL, while produced works (maps, charts, statistics) can use any license as long as they carry the attribution. Keep the license of each source next to every record so mixed datasets stay compliant ([Provenance and Lineage](../data-quality/provenance-and-lineage.md)).

## Personal data

Locations attached to people are personal data: home-based businesses and sole traders, geocoded personal addresses, and opening hours that reveal an individual's schedule. Geocoding a customer list is processing personal data; using a public geocoder sends those addresses to a third party, so self-host when the addresses are sensitive.

## Pitfalls

- Coordinate order: GeoJSON is longitude, latitude; most APIs print latitude, longitude.
- Overpass bounding boxes are south, west, north, east; swapped values return empty results quickly.
- Overpass `timeout` and `maxsize` settings that are too large get queries rejected on busy servers; split big areas into tiles.
- Geocoder ambiguity: "Springfield" has dozens of matches; pass country codes and structured address fields.
- Conflating POIs from several sources needs name similarity plus distance thresholds ([Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)).
- Closed businesses linger in every dataset; carry a last-confirmed date.
- Opening hours are local time; store the time zone.

## Checklist

- [ ] License chosen deliberately (ODbL, CDLA, Apache, CC0, or a commercial API license).
- [ ] Bulk extracts used for large areas; public Overpass and Nominatim kept to fair use.
- [ ] Nominatim throttled to under 1 request/second with caching and an identifying User-Agent.
- [ ] No scraping of commercial map platforms; caching within their terms.
- [ ] Attribution text stored and displayed.
- [ ] Personal data in addresses and home businesses minimized.

## See Also

- [Catalog of Useful Open APIs](../apis/official-apis-catalog.md)
- [Politeness and Rate Limiting](../crawling/politeness-and-rate-limiting.md)
- [Structured Data (JSON-LD, Microdata, OpenGraph)](../parsing/structured-data-schema-org.md)
- [Record Deduplication and Entity Resolution](../data-quality/record-deduplication-entity-resolution.md)
- [Real Estate Listings](real-estate.md)
- [Reviews and Forums](reviews-and-forums.md)
