import { aggLabel, aggregate, groupBy } from '../../src/dashboards/core/aggregate';
import { binLog, binNumbers, binWithTail, prefersLog } from '../../src/dashboards/core/bins';
import { decodeRows, encodeRows, safeJson } from '../../src/dashboards/core/encode';
import {
  applyFilters,
  facetCounts,
  isEmptyFilter,
  matchesFilter,
  valueKey,
} from '../../src/dashboards/core/filter';
import {
  compactNumber,
  displayUrl,
  formatBytes,
  formatDuration,
  formatTick,
  formatTime,
  formatTimeTick,
  isValidFormat,
  makeFormatter,
} from '../../src/dashboards/core/format';
import {
  coerceValue,
  describeProfile,
  inferColumns,
  inferType,
  normalizeRows,
  profileColumn,
} from '../../src/dashboards/core/infer';
import { sequentialStep, themeCss } from '../../src/dashboards/core/palette';
import { pivot } from '../../src/dashboards/core/pivot';
import {
  bandScale,
  linearScale,
  logDomain,
  logScale,
  logTicks,
  niceStep,
  niceTicks,
  timeTicks,
  valueDomain,
} from '../../src/dashboards/core/scales';
import { assignSeriesColors, foldSeries, rankSeries, seriesOf } from '../../src/dashboards/core/series';
import {
  addInterval,
  autoInterval,
  floorTime,
  presetRange,
  previousPeriod,
  timeBuckets,
  toTime,
} from '../../src/dashboards/core/time';
import type { ActiveFilter, Row } from '../../src/dashboards/core/types';

const T = (s: string) => Date.parse(s);

describe('time', () => {
  test('parses dates and floors to UTC intervals (ISO weeks start Monday)', () => {
    expect(toTime('2026-10-23')).toBe(T('2026-10-23T00:00:00Z'));
    expect(toTime('nope')).toBeNull();
    expect(toTime(null)).toBeNull();
    expect(toTime(new Date('invalid'))).toBeNull();
    const t = T('2026-10-23T15:47:12Z'); // a Friday
    expect(floorTime(t, 'minute')).toBe(T('2026-10-23T15:47:00Z'));
    expect(floorTime(t, 'hour')).toBe(T('2026-10-23T15:00:00Z'));
    expect(floorTime(t, 'day')).toBe(T('2026-10-23T00:00:00Z'));
    expect(floorTime(t, 'week')).toBe(T('2026-10-19T00:00:00Z'));
    expect(floorTime(T('2026-10-25T10:00:00Z'), 'week')).toBe(T('2026-10-19T00:00:00Z')); // Sunday
    expect(floorTime(t, 'month')).toBe(T('2026-10-01T00:00:00Z'));
    expect(floorTime(t, 'quarter')).toBe(T('2026-10-01T00:00:00Z'));
    expect(floorTime(T('2026-05-05T00:00:00Z'), 'quarter')).toBe(T('2026-04-01T00:00:00Z'));
    expect(floorTime(t, 'year')).toBe(T('2026-01-01T00:00:00Z'));
  });

  test('adds intervals across month and year boundaries', () => {
    expect(addInterval(T('2026-12-01T00:00:00Z'), 'month')).toBe(T('2027-01-01T00:00:00Z'));
    expect(addInterval(T('2026-11-01T00:00:00Z'), 'quarter')).toBe(T('2027-02-01T00:00:00Z'));
    expect(addInterval(T('2026-01-01T00:00:00Z'), 'year', 2)).toBe(T('2028-01-01T00:00:00Z'));
    expect(addInterval(0, 'week')).toBe(7 * 86_400_000);
    expect(timeBuckets(T('2026-10-01'), T('2026-10-03T12:00:00Z'), 'day')).toEqual([
      T('2026-10-01'),
      T('2026-10-02'),
      T('2026-10-03'),
    ]);
  });

  test('chooses intervals and resolves presets', () => {
    expect(autoInterval(T('2026-10-01'), T('2026-10-02'))).toBe('hour');
    expect(autoInterval(T('2026-10-01T00:00:00Z'), T('2026-10-01T01:00:00Z'))).toBe('minute');
    expect(autoInterval(T('2026-10-01'), T('2026-10-20'), 60)).toBe('day');
    expect(autoInterval(T('2020-01-01'), T('2026-01-01'), 120)).toBe('month');
    expect(autoInterval(T('1900-01-01'), T('2026-01-01'), 50)).toBe('year');
    const now = T('2026-10-23T15:00:00Z');
    expect(presetRange('all', now)).toEqual({});
    expect(presetRange('today', now)).toEqual({ from: T('2026-10-23') });
    expect(presetRange('7d', now)).toEqual({ from: T('2026-10-17') });
    expect(presetRange('mtd', now)).toEqual({ from: T('2026-10-01') });
    expect(presetRange('ytd', now)).toEqual({ from: T('2026-01-01') });
    expect(presetRange('12m', now)).toEqual({ from: T('2025-11-01') });
    expect(previousPeriod(10, 20)).toEqual({ from: 0, to: 10 });
  });
});

describe('inference and profiling', () => {
  test('infers types, including numbers and dates stored as strings', () => {
    expect(inferType([1, 2, null])).toBe('integer');
    expect(inferType(['1.5', ' 2 ', ''])).toBe('number');
    expect(inferType([true, 'false'])).toBe('boolean');
    expect(inferType(['2026-10-23', '2026-10-24'])).toBe('date');
    expect(inferType(['2026-10-23T10:00:00Z', '2026-10-24'])).toBe('datetime');
    expect(inferType(['https://a.test/x', 'http://b.test'])).toBe('url');
    expect(inferType([{ a: 1 }, [1]])).toBe('json');
    expect(inferType(['x', 1])).toBe('string');
    expect(inferType([])).toBe('string');
  });

  test('coerces values and normalizes rows to column types', () => {
    expect(coerceValue(' 3 ', 'integer')).toBe(3);
    expect(coerceValue('x', 'number')).toBeNull();
    expect(coerceValue('true', 'boolean')).toBe(true);
    expect(coerceValue('maybe', 'boolean')).toBeNull();
    expect(coerceValue(T('2026-10-23T05:00:00Z'), 'date')).toBe('2026-10-23');
    expect(coerceValue('2026-10-23T05:00:00Z', 'datetime')).toBe('2026-10-23T05:00:00Z');
    expect(coerceValue('not a date', 'datetime')).toBeNull();
    expect(coerceValue({ a: 1 }, 'string')).toBe('{"a":1}');
    expect(coerceValue('', 'string')).toBeNull();
    const rows = [
      { a: '1', b: 'x' },
      { a: '2', c: '2026-10-01' },
    ];
    const cols = inferColumns(rows, { b: { label: 'Bee' }, d: { type: 'number', format: 'compact' } });
    expect(cols).toEqual([
      { name: 'a', type: 'integer' },
      { name: 'b', type: 'string', label: 'Bee' },
      { name: 'c', type: 'date' },
      { name: 'd', type: 'number', format: 'compact' },
    ]);
    expect(normalizeRows(rows, cols)).toEqual([
      { a: 1, b: 'x', c: null, d: null },
      { a: 2, b: null, c: '2026-10-01', d: null },
    ]);
  });

  test('profiles numeric, time and text columns', () => {
    const rows: Row[] = [
      { n: 1, d: '2026-10-01', s: 'a' },
      { n: 3, d: '2026-10-03', s: 'b' },
      { n: null, d: null, s: 'a' },
    ];
    expect(profileColumn({ name: 'n', type: 'integer' }, rows)).toMatchObject({
      count: 3,
      nulls: 1,
      distinct: 2,
      min: 1,
      max: 3,
      mean: 2,
      median: 2,
    });
    expect(profileColumn({ name: 'd', type: 'date' }, rows)).toMatchObject({
      min: '2026-10-01',
      max: '2026-10-03',
    });
    expect(profileColumn({ name: 's', type: 'string' }, rows).top).toEqual([
      { value: 'a', count: 2 },
      { value: 'b', count: 1 },
    ]);
    const text = describeProfile(
      't',
      [
        { name: 'n', type: 'integer' },
        { name: 's', type: 'string' },
      ],
      rows,
    );
    expect(text).toContain('Dataset t: 3 rows, 2 columns');
    expect(text).toContain('- n [integer] 67% filled, 2 distinct, min 1, max 3, mean 2');
    expect(text).toContain('top: a (2); b (1)');
  });
});

describe('aggregation', () => {
  const rows: Row[] = [
    { k: 'a', v: 1, t: '2026-10-02' },
    { k: 'b', v: 4, t: '2026-10-01' },
    { k: 'a', v: null, t: '2026-10-03' },
    { k: 'a', v: '7', t: '2026-10-04' },
  ];
  test('computes every aggregate and handles empty input', () => {
    expect(aggregate(rows, { agg: 'count' })).toBe(4);
    expect(aggregate(rows, { agg: 'count', field: 'v' })).toBe(3);
    expect(aggregate(rows, { agg: 'distinct', field: 'k' })).toBe(2);
    expect(aggregate(rows, { agg: 'sum', field: 'v' })).toBe(12);
    expect(aggregate(rows, { agg: 'mean', field: 'v' })).toBe(4);
    expect(aggregate(rows, { agg: 'median', field: 'v' })).toBe(4);
    expect(aggregate(rows, { agg: 'min', field: 'v' })).toBe(1);
    expect(aggregate(rows, { agg: 'max', field: 'v' })).toBe(7);
    expect(aggregate(rows, { agg: 'p90', field: 'v' })).toBeCloseTo(6.4);
    expect(aggregate(rows, { agg: 'p10', field: 'v' })).toBeCloseTo(1.6);
    expect(aggregate(rows, { agg: 'first', field: 'v', orderBy: 't' })).toBe(4);
    expect(aggregate(rows, { agg: 'last', field: 'v', orderBy: 't' })).toBe(7);
    expect(aggregate(rows, { agg: 'last', field: 'v' })).toBe(7);
    expect(aggregate([], { agg: 'sum', field: 'v' })).toBe(0);
    expect(aggregate([], { agg: 'mean', field: 'v' })).toBeNull();
    expect(aggregate(rows, { agg: 'mean' })).toBeNull();
    expect([...groupBy(rows, (r) => r.k).keys()]).toEqual(['a', 'b']);
    expect(aggLabel({ agg: 'count' })).toBe('Rows');
    expect(aggLabel({ agg: 'mean', field: 'score' }, 'Score')).toBe('Average Score');
    expect(aggLabel({ agg: 'last', field: 'rate' })).toBe('Latest rate');
  });
});

describe('filters and facets', () => {
  const now = T('2026-10-23T12:00:00Z');
  const rows: Row[] = [
    { id: 1, by: 'ann', score: 10, at: '2026-10-22T08:00:00Z', title: 'Robots and you' },
    { id: 2, by: 'bob', score: 50, at: '2026-09-01T08:00:00Z', title: 'Parsing HTML' },
    { id: 3, by: null, score: null, at: null, title: 'Untitled robots' },
  ];
  const f = (id: string, fields: string[], value: ActiveFilter['value']): ActiveFilter => ({
    id,
    datasets: ['d'],
    fields,
    value,
  });
  test('matches values, ranges, time windows and search terms', () => {
    expect(
      rows
        .filter((r) => matchesFilter(r, f('a', ['by'], { kind: 'values', values: ['ann', '(empty)'] }), now))
        .map((r) => r.id),
    ).toEqual([1, 3]);
    expect(
      rows
        .filter((r) => matchesFilter(r, f('a', ['score'], { kind: 'range', min: 20 }), now))
        .map((r) => r.id),
    ).toEqual([2]);
    expect(
      rows
        .filter((r) => matchesFilter(r, f('a', ['at'], { kind: 'time', preset: '7d' }), now))
        .map((r) => r.id),
    ).toEqual([1]);
    expect(
      rows
        .filter((r) =>
          matchesFilter(r, f('a', ['at'], { kind: 'time', from: T('2026-09-01'), to: T('2026-09-02') }), now),
        )
        .map((r) => r.id),
    ).toEqual([2]);
    expect(
      rows
        .filter((r) => matchesFilter(r, f('a', ['title', 'by'], { kind: 'search', text: 'ROBOTS ann' }), now))
        .map((r) => r.id),
    ).toEqual([1]);
  });

  test('applies only active filters for the dataset, optionally skipping one', () => {
    const filters = [
      f('by', ['by'], { kind: 'values', values: ['bob'] }),
      f('empty', ['score'], { kind: 'range' }),
      { ...f('other', ['by'], { kind: 'values', values: ['ann'] }), datasets: ['elsewhere'] },
    ];
    expect(applyFilters(rows, 'd', filters, now).map((r) => r.id)).toEqual([2]);
    expect(applyFilters(rows, 'd', filters, now, 'by')).toHaveLength(3);
    expect(applyFilters(rows, 'd', [], now)).toBe(rows);
    expect(isEmptyFilter({ kind: 'time', preset: 'all' })).toBe(true);
    expect(isEmptyFilter({ kind: 'search', text: '  ' })).toBe(true);
    expect(facetCounts(rows, 'by')).toEqual([
      { value: '(empty)', count: 1 },
      { value: 'ann', count: 1 },
      { value: 'bob', count: 1 },
    ]);
    expect(valueKey({ a: 1 })).toBe('{"a":1}');
  });
});

describe('formatting', () => {
  test('number, percent, currency, compact, bytes and duration formats', () => {
    expect(makeFormatter('integer', 'number')(1234.6)).toBe('1,235');
    expect(makeFormatter('decimal:1', 'number')(2)).toBe('2.0');
    expect(makeFormatter('percent', 'number')(0.1234)).toBe('12.3%');
    expect(makeFormatter('currency:EUR', 'number')(12.5)).toBe('\u20ac12.50');
    expect(makeFormatter('currency:usd:0', 'number')(12.5)).toBe('$13');
    expect(makeFormatter('compact', 'number')(12900)).toBe('12.9K');
    expect(makeFormatter('bytes', 'number')(1536)).toBe('1.5 kB');
    expect(makeFormatter('duration', 'number')(3720)).toBe('1h 2m');
    expect(makeFormatter(undefined, 'number')(3.14159)).toBe('3.14');
    expect(makeFormatter(undefined, 'number')(1234.56)).toBe('1,234.6');
    expect(makeFormatter(undefined, 'number')(0.012345)).toBe('0.0123');
    expect(makeFormatter(undefined, 'integer')('12')).toBe('12');
    expect(makeFormatter('number', 'number')('abc')).toBe('abc');
    expect(makeFormatter('number', 'number')(null)).toBe('');
    expect(compactNumber(4_200_000)).toBe('4.2M');
    expect(compactNumber(7.25)).toBe('7.25');
    expect(formatBytes(-2048)).toBe('-2 kB');
    expect(formatBytes(999.6)).toBe('1 kB');
    expect(formatBytes(9_960_000)).toBe('10 MB');
    expect(formatBytes(512.4)).toBe('512 B');
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(90061)).toBe('1d 1h');
  });

  test('dates, booleans, urls and text', () => {
    const t = '2026-10-23T18:04:00Z';
    expect(makeFormatter('date', 'datetime')(t)).toBe('Oct 23, 2026');
    expect(makeFormatter(undefined, 'datetime')(t)).toBe('Oct 23, 2026, 18:04 UTC');
    expect(makeFormatter('month', 'date')(t)).toBe('Oct 2026');
    expect(makeFormatter('quarter', 'date')(t)).toBe('Q4 2026');
    expect(makeFormatter('year', 'date')(t)).toBe('2026');
    expect(makeFormatter(undefined, 'date')('garbage')).toBe('garbage');
    expect(makeFormatter(undefined, 'boolean')(true)).toBe('Yes');
    expect(makeFormatter(undefined, 'url')('https://example.com/a/')).toBe('example.com/a');
    expect(makeFormatter(undefined, 'json')({ a: 1 })).toBe('{"a":1}');
    expect(displayUrl('https://example.com/' + 'x'.repeat(60), 20)).toHaveLength(20);
    expect(formatTime(T('2026-10-19'), 'week')).toBe('Week of Oct 19, 2026');
    expect(formatTime(T('2026-10-19T09:30:00Z'), 'hour')).toBe('Oct 19, 09:30');
  });

  test('ticks and format validation', () => {
    expect(formatTick(2500, 500)).toBe('2.5K');
    expect(formatTick(0.25, 0.05)).toBe('0.25');
    expect(formatTick(40, 10)).toBe('40');
    expect(formatTimeTick(T('2026-01-01'), 'month', false)).toBe('Jan 2026');
    expect(formatTimeTick(T('2026-03-01'), 'month', false)).toBe('Mar');
    expect(formatTimeTick(T('2026-03-04'), 'day', true)).toBe('Mar 4, 2026');
    expect(formatTimeTick(T('2026-03-04'), 'day', false)).toBe('Mar 4');
    expect(formatTimeTick(T('2026-03-04T06:00:00Z'), 'hour', false)).toBe('06:00');
    expect(formatTimeTick(T('2026-03-04T00:00:00Z'), 'hour', false)).toBe('Mar 4');
    expect(formatTimeTick(T('2026-03-04'), 'year', false)).toBe('2026');
    for (const ok of ['auto', 'decimal:2', 'percent:0', 'currency:EUR', 'currency:JPY:0', 'date'])
      expect(isValidFormat(ok)).toBe(true);
    for (const bad of ['money', 'decimal:x', 'currency', 'currency:EURO', 'date:2'])
      expect(isValidFormat(bad)).toBe(false);
  });
});

describe('scales and bins', () => {
  test('nice steps and ticks', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(7, 5)).toBe(2);
    expect(niceStep(0, 5)).toBe(1);
    expect(niceTicks(3, 97, 5)).toEqual({ ticks: [0, 20, 40, 60, 80, 100], step: 20 });
    expect(niceTicks(0, 0)).toEqual({ ticks: [0, 1], step: 1 });
    expect(niceTicks(5, 5).ticks.length).toBeGreaterThan(1);
    expect(niceTicks(NaN, 1)).toEqual({ ticks: [0], step: 1 });
    expect(valueDomain([5, 9], true).ticks[0]).toBe(0);
    expect(valueDomain([5, 9], false).ticks[0]).toBe(5);
    expect(valueDomain([], true).ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  test('linear and band scales', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(50)).toBe(100);
    expect(y.invert(50)).toBe(75);
    expect(linearScale([1, 1], [0, 10])(1)).toBe(0);
    const x = bandScale(['a', 'b', 'c'], [0, 300], 0.2, 0);
    expect(x('a')).toBe(0);
    expect(x('d')).toBeUndefined();
    expect(x.bandwidth).toBeCloseTo(x.step * 0.8);
    expect(bandScale([], [0, 100]).step).toBe(0);
  });

  test('calendar-aligned time ticks', () => {
    const days = timeTicks(T('2026-10-01'), T('2026-10-05'), 6);
    expect(days.level).toBe('day');
    expect(days.ticks[0]).toBe(T('2026-10-01'));
    const months = timeTicks(T('2026-01-15'), T('2026-12-20'), 6);
    expect(months.level).toBe('month');
    expect(months.ticks.every((t) => new Date(t).getUTCDate() === 1)).toBe(true);
    const years = timeTicks(T('2000-03-01'), T('2026-03-01'), 6);
    expect(years.level).toBe('year');
    expect(years.ticks.every((t) => new Date(t).getUTCFullYear() % 5 === 0)).toBe(true);
    const hours = timeTicks(T('2026-10-01T01:10:00Z'), T('2026-10-01T13:00:00Z'), 6);
    expect(hours.level).toBe('hour');
    expect(hours.ticks.every((t) => new Date(t).getUTCHours() % 3 === 0)).toBe(true);
  });

  test('histogram bins on round edges', () => {
    const bins = binNumbers([1, 2, 2, 3, 9, 10, 11, 25]);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(8);
    expect(bins[0]!.x0).toBeLessThanOrEqual(1);
    expect(bins.at(-1)!.x1).toBeGreaterThanOrEqual(25);
    expect(binNumbers([4, 4, 4])).toEqual([{ x0: 4, x1: 5, count: 3 }]);
    expect(binNumbers([])).toEqual([]);
    expect(binNumbers([0, 100], 10)).toHaveLength(11);
  });

  test('skewed data: a labeled tail bar, or log bins of equal width', () => {
    const skewed = [...Array.from({ length: 200 }, (_, i) => i % 50), 10_000, 20_000];
    const { bins, tail } = binWithTail(skewed);
    expect(tail).toEqual({ count: 2, from: 49, max: 20_000 });
    expect(bins.at(-1)!.x1).toBeLessThan(100);
    expect(bins.reduce((s, b) => s + b.count, 0) + tail!.count).toBe(skewed.length);
    expect(binWithTail([1, 2, 3]).tail).toBeNull();

    const sizes = Array.from({ length: 100 }, (_, i) => 10 ** (1 + (i % 50) / 10));
    expect(prefersLog(sizes)).toBe(true);
    expect(prefersLog([...sizes, 0])).toBe(false);
    expect(prefersLog(Array.from({ length: 100 }, (_, i) => 100 + i))).toBe(false);
    const log = binLog(sizes, 10);
    const widths = log.map((b) => Math.log10(b.x1) - Math.log10(b.x0));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1e-9);
    expect(log[0]!.x0).toBeLessThanOrEqual(10);
    expect(log.reduce((s, b) => s + b.count, 0)).toBe(100);
    expect(binLog([0, -1])).toEqual([]);
    expect(binLog([100, 100])).toEqual([{ x0: 100, x1: expect.closeTo(158.489, 3), count: 2 }]);
  });

  test('log scales run decade to decade', () => {
    expect(logDomain(3, 4200)).toEqual([1, 10_000]);
    expect(logDomain(10, 10)).toEqual([10, 100]);
    expect(logTicks(1, 10_000)).toEqual([1, 10, 100, 1000, 10_000]);
    expect(logTicks(1, 100)).toEqual([1, 2, 5, 10, 20, 50, 100]);
    expect(logTicks(0, 10)).toEqual([]);
    const x = logScale([1, 1000], [0, 300]);
    expect(x(10)).toBeCloseTo(100);
    expect(x.invert(200)).toBeCloseTo(100);
  });
});

describe('series, pivots, encoding and palette', () => {
  const rows: Row[] = [
    { s: 'a', v: 5, c: 'x' },
    { s: 'b', v: 9, c: 'y' },
    { s: 'c', v: 1, c: 'x' },
    { s: 'a', v: 5, c: 'y' },
  ];
  test('ranks and folds series with stable colors', () => {
    const ranked = rankSeries(rows, 's', { agg: 'sum', field: 'v' });
    expect(ranked).toEqual(['a', 'b', 'c']);
    expect(foldSeries(ranked, 8)).toEqual({ kept: ranked, folded: [] });
    expect(foldSeries(ranked, 2)).toEqual({ kept: ['a'], folded: ['b', 'c'] });
    expect(
      foldSeries(
        Array.from({ length: 12 }, (_, i) => `s${i}`),
        99,
      ).kept,
    ).toHaveLength(7);
    expect(seriesOf(rows[2]!, 's', new Set(['a']))).toBe('Other');
    expect(seriesOf(rows[2]!, undefined, new Set())).toBe('');
  });

  test('series colors follow the entity across charts, never cycling', () => {
    const page = ['a', 'b', 'c', 'd'];
    // A chart that ranks by another measure still paints each value with its page slot.
    const colors = assignSeriesColors(['c', 'a'], page);
    expect(colors.get('a')).toBe('var(--series-1)');
    expect(colors.get('c')).toBe('var(--series-3)');
    expect(colors.get('Other')).toBe('var(--series-other)');
    // A value outside the page's top slots takes the lowest free slot.
    const wide = Array.from({ length: 12 }, (_, i) => `s${i}`);
    const tail = assignSeriesColors(['s0', 's10', 's11'], wide);
    expect(tail.get('s0')).toBe('var(--series-1)');
    expect(tail.get('s10')).toBe('var(--series-2)');
    expect(tail.get('s11')).toBe('var(--series-3)');
    const full = assignSeriesColors(wide.slice(0, 9), wide);
    expect(full.get('s8')).toBe('var(--series-other)');
  });

  test('pivots with totals that re-aggregate the rows', () => {
    const p = pivot(rows, 's', 'c', { agg: 'sum', field: 'v' });
    expect(p.rowKeys).toEqual(['a', 'b', 'c']);
    expect(p.colKeys).toEqual(['x', 'y'].sort((a, b) => (a === 'y' ? -1 : b === 'y' ? 1 : 0)));
    expect(p.cells.get('a')!.get('x')).toBe(5);
    expect(p.cells.get('b')!.get('x')).toBeNull();
    expect(p.total).toBe(20);
    expect(pivot(rows, 's', undefined, { agg: 'count' }).colKeys).toEqual([]);
  });

  test('encodes rows compactly and escapes JSON for script tags', () => {
    const cols = [
      { name: 'a', type: 'string' as const },
      { name: 'b', type: 'integer' as const },
    ];
    const enc = encodeRows(cols, [{ a: 'x', b: 1 }, { a: 'y' }]);
    expect(enc).toEqual([
      ['x', 1],
      ['y', null],
    ]);
    expect(decodeRows({ columns: cols, rows: enc })).toEqual([
      { a: 'x', b: 1 },
      { a: 'y', b: null },
    ]);
    const json = safeJson({ s: '</script><b>&\u2028' });
    expect(json).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(json)).toEqual({ s: '</script><b>&\u2028' });
  });

  test('theme tokens: complete light root, dark under the OS preference and the toggle', () => {
    const css = themeCss();
    expect(css.startsWith(':root {\n  color-scheme: light;')).toBe(true);
    expect(css).toContain('@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"])');
    expect(css).toContain(':root[data-theme="dark"]');
    expect(css).toContain('--series-1: #2a78d6');
    expect(css).toContain('--series-1: #3987e5');
    expect(css).toContain('--status-critical: #d03b3b');
    expect(sequentialStep(0)).toBe(0);
    expect(sequentialStep(1)).toBe(12);
    expect(sequentialStep(9)).toBe(12);
  });
});
