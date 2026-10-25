---
tags: [scraping, parsing, dates, numbers, currency]
aliases: [date parsing, number parsing, price parsing, locale parsing, time zones, ISO 8601, ISO 4217]
---

# Parsing Dates, Numbers and Currencies

> Sources: ISO 8601 date and time format (https://www.iso.org/iso-8601-date-and-time-format.html); IETF RFC 3339, Date and Time on the Internet: Timestamps (https://www.rfc-editor.org/rfc/rfc3339); IETF RFC 5322, Internet Message Format (https://www.rfc-editor.org/rfc/rfc5322); IANA Time Zone Database (https://www.iana.org/time-zones); Python documentation, datetime (https://docs.python.org/3/library/datetime.html) and zoneinfo (https://docs.python.org/3/library/zoneinfo.html); Unicode CLDR (https://cldr.unicode.org/); Babel, Number formatting and parsing (https://babel.pocoo.org/en/latest/numbers.html); dateparser documentation (https://dateparser.readthedocs.io/); price-parser (https://github.com/scrapinghub/price-parser); ISO 4217 currency codes (https://www.iso.org/iso-4217-currency-codes.html)
> Raw: none yet (seed article)
> Updated: 2026-10-24

## Overview

Dates, numbers and money are where scrapers produce data that looks right and is wrong. `03/05/2024` is 5 March in the US and 3 May in Europe; `1.234` is one thousand two hundred thirty-four in Germany and one point two three four in the US; `2 hours ago` depends on when you fetched the page; `$` is the symbol of more than a dozen currencies; and daylight saving time creates local times that happen twice or never. The rules: decide the format, locale and time zone **per source**, not per value; parse strictly and fail loudly instead of guessing; store timestamps as timezone-aware UTC next to the original string; store money as a `Decimal` amount plus an ISO 4217 code, never as a float; and keep the fetch time, because relative dates are meaningless without it.

## Dates and times

| Format | Example | Parse with |
|---|---|---|
| ISO 8601, RFC 3339 | `2024-03-05T14:30:00Z`, `2024-03-05T14:30:00.123+01:00` | `datetime.fromisoformat` (Python 3.11+ also accepts `Z`, basic format and week dates) |
| Date only | `2024-03-05` | `date.fromisoformat` |
| RFC 5322 (RSS `pubDate`, email) | `Mon, 03 Feb 2025 09:00:00 +0100` | `email.utils.parsedate_to_datetime` |
| HTTP date | `Mon, 03 Feb 2025 08:00:00 GMT` | `email.utils.parsedate_to_datetime` |
| Unix time | `1709649000` (s), `1709649000123` (ms, JavaScript) | `datetime.fromtimestamp(x, tz=timezone.utc)`, dividing ms by 1000 |
| Fixed local pattern | `03/05/2024`, `5.3.2024 14:30` | `datetime.strptime` with the source's format |
| Localized text | `5 de marzo de 2024`, `3. März 2024` | dateparser with `languages=[...]` |
| Relative | `2 hours ago`, `hace 3 días`, `yesterday` | dateparser with `RELATIVE_BASE` set to the fetch time |

```python
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from zoneinfo import ZoneInfo
import dateparser

datetime.fromisoformat("2024-03-05T14:30:00Z")                 # 2024-03-05 14:30:00+00:00
parsedate_to_datetime("Mon, 03 Feb 2025 09:00:00 +0100")       # 2025-02-03 09:00:00+01:00
datetime.fromtimestamp(1709649000123 / 1000, tz=timezone.utc)  # milliseconds from JavaScript

# Ambiguous numeric dates: use the source's documented order, for every value from that source
datetime.strptime("03/05/2024", "%d/%m/%Y")                    # 3 May 2024 on a European site

# Naive local wall time: attach the source's IANA zone, then convert to UTC for storage
local = datetime(2025, 2, 3, 9, 0, tzinfo=ZoneInfo("Europe/Madrid"))
stored = local.astimezone(timezone.utc)                        # 2025-02-03 08:00:00+00:00

# Free text and relative dates
fetched_at = datetime(2024, 3, 10, 12, 0, tzinfo=timezone.utc)
dateparser.parse("5 de marzo de 2024", languages=["es"])                                   # 2024-03-05 00:00
dateparser.parse("hace 3 días", languages=["es"], settings={"RELATIVE_BASE": fetched_at})  # 2024-03-07 12:00
dateparser.parse("03/05/2024", settings={"DATE_ORDER": "DMY"})                            # 2024-05-03
dateparser.parse("not a date")                                                            # None
```

dateparser is flexible and slow; use it for free text and `strptime` or `fromisoformat` for fixed formats. Without `DATE_ORDER` it read `03/05/2024` as 5 March, so set the order explicitly. Its results are naive unless you pass `RETURN_AS_TIMEZONE_AWARE` and a `TIMEZONE`.

### Time zones and daylight saving

```python
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

mad = ZoneInfo("Europe/Madrid")
ambiguous = datetime(2024, 10, 27, 2, 30, tzinfo=mad)        # this wall time happens twice
print(ambiguous.utcoffset(), ambiguous.replace(fold=1).utcoffset())   # 2:00:00 1:00:00

missing = datetime(2024, 3, 31, 2, 30, tzinfo=mad)           # this wall time never happens
print(missing.astimezone(timezone.utc).astimezone(mad))       # 2024-03-31 03:30:00+02:00, silently moved
```

- Use IANA names (`Europe/Madrid`), never abbreviations: `IST` is India, Ireland or Israel, and `CST` is both China and US Central.
- Python does not raise for ambiguous or nonexistent local times; it picks an offset. Flag times inside DST transitions when precision matters.
- A date without a time is a `DATE`, not midnight UTC: midnight UTC is the previous day in the Americas.

## Numbers

| Locale | Example | Decimal | Grouping (CLDR) |
|---|---|---|---|
| `en_US` | `1,234.56` | `.` | `,` |
| `de_DE` | `1.234,56` | `,` | `.` |
| `fr_FR` | `1 234,56` | `,` | U+202F narrow no-break space |
| `de_CH` | `1’234.56` | `.` | U+2019 right single quotation mark |
| `en_IN` | `12,34,567.89` | `.` | `,` in lakh and crore groups |

Babel parses with CLDR data, but its default lax mode can be silently wrong: `parse_decimal("1.234,56", locale="en_US")` returns `1.23456`. Use `strict=True`, which raises with suggestions instead. Strict mode expects the exact CLDR group symbol, so `fr_FR` rejects a plain space or NBSP unless you normalize them first:

```python
import re
from decimal import Decimal
from babel.numbers import parse_decimal, get_group_symbol, NumberFormatError

SPACE_LIKE = re.compile(r"[\s\u00a0\u2009\u202f]")

def parse_amount(text: str, locale: str) -> Decimal:
    """Strict, locale-aware number parsing with accounting negatives. Raises NumberFormatError."""
    t = text.strip().replace("\u2212", "-")                                   # Unicode minus sign
    negative = (t.startswith("(") and t.endswith(")")) or t.startswith("-") or t.endswith("-")
    t = t.strip("()").strip("-").strip()
    group = get_group_symbol(locale)
    if group.isspace():
        t = SPACE_LIKE.sub(group, t)              # pages use spaces or NBSP where CLDR expects U+202F
    value = parse_decimal(t, locale=locale, strict=True)
    return -value if negative else value

print(parse_amount("1 234,56", "fr_FR"))         # 1234.56
print(parse_amount("(1,234.50)", "en_US"))       # -1234.50
print(parse_amount("1.234,50-", "de_DE"))        # -1234.50
print(parse_amount("1’234.56", "de_CH"))         # 1234.56 (an ASCII apostrophe fails: normalize it if the source uses one)
try:
    parse_amount("1.234,56", "en_US")
except NumberFormatError as e:
    print(e)                                     # ...Did you mean '1.23456'? Or maybe '1,234.56'?
```

Also decide explicitly how to treat percentages (`12,5 %` as 12.5 or 0.125), abbreviations (`1.2K`, `3,4 Mio.`, `2.5M`) and ranges. Use `Decimal` for anything that is money or will be summed: `sum([1.10] * 3)` is `3.3000000000000003` in floats and `3.30` in `Decimal`.

## Currencies

| Symbol | Could be |
|---|---|
| `$` | USD, CAD, AUD, NZD, MXN, SGD, HKD, ARS, CLP, COP and others |
| `kr` | SEK, NOK, DKK, ISK |
| `¥` | JPY or CNY |
| `£` | GBP, also EGP and others locally |
| `R$` versus `R` | BRL versus ZAR |

Resolve the code from the page's structured data (`priceCurrency`), the shop's currency selector, the storefront country or a per-source configuration, then store the ISO 4217 code. Mind minor units: JPY has no decimals, while BHD and KWD have three. price-parser separates amount and symbol and is a good first pass:

```python
from price_parser import Price

Price.fromstring("22,90 €")                           # Price(amount=Decimal('22.90'), currency='€')
Price.fromstring("$1,299.00").amount                  # Decimal('1299.00')
Price.fromstring("12,345").amount                     # Decimal('12345'): comma assumed to group thousands
Price.fromstring("12,345", decimal_separator=",").amount   # Decimal('12.345'): pass the source's separator
Price.fromstring("From $12 to $15").amount            # Decimal('12'): only the first number
Price.fromstring("Free").amount                       # Decimal('0'): decide if "free" really means 0
```

Store original amount and currency; convert later with dated exchange rates, never at scrape time.

## Pitfalls

- **Guessing per value.** Inferring day-first from "the day is above 12" makes one source's records inconsistent. Fix the format per source and assert it.
- **Relative dates without the fetch time.** Save `fetched_at` and use it as `RELATIVE_BASE`; re-parsing later with "now" shifts every value.
- **Two-digit years and missing years.** `03/05/24` and `5 March` need an explicit century rule and a year inferred from the fetch date.
- **Float money.** Floats accumulate rounding errors in sums and comparisons.
- **Lax parsers.** Babel's lax mode, price-parser's assumptions and dateparser's defaults all return a value rather than an error. Prefer strict modes and count failures.
- **Locale of the page, not of the server.** Shops serve different formats by URL path, cookie or `Accept-Language`; record which locale you requested ([Request Headers That Matter](../http/http-headers-for-scrapers.md)).

## Checklist

- [ ] Each source has a documented date format, number locale, time zone and currency rule.
- [ ] Timestamps stored as UTC with the raw string and source zone; date-only values stored as dates.
- [ ] Relative dates parsed against the stored fetch time.
- [ ] Numbers parsed strictly with the source locale; money as `Decimal` plus ISO 4217 code.
- [ ] Parse failures counted, sampled and alerted on.

## See Also

- [Text Cleaning and Unicode Normalization](text-cleaning-and-unicode.md)
- [Structured Data (JSON-LD, Microdata, OpenGraph)](structured-data-schema-org.md)
- [E-commerce and Price Monitoring](../sources/ecommerce-and-prices.md)
- [Schema Validation](../data-quality/schema-validation.md)
- [Data Modeling for Scraped Data](../storage/data-modeling-for-scraped-data.md)
