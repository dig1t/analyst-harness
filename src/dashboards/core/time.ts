import type { Interval, TimePreset } from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parse a date-like value to epoch milliseconds (UTC for date-only strings), or null. */
export function toTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}

/** Start of the UTC interval containing `ms`. Weeks start on Monday (ISO 8601). */
export function floorTime(ms: number, interval: Interval): number {
  const d = new Date(ms);
  switch (interval) {
    case 'minute':
      return Math.floor(ms / MINUTE) * MINUTE;
    case 'hour':
      return Math.floor(ms / HOUR) * HOUR;
    case 'day':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    case 'week': {
      const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
      const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
      return day - dow * DAY;
    }
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
    case 'year':
      return Date.UTC(d.getUTCFullYear(), 0, 1);
  }
}

export function addInterval(ms: number, interval: Interval, n = 1): number {
  const d = new Date(ms);
  switch (interval) {
    case 'minute':
      return ms + n * MINUTE;
    case 'hour':
      return ms + n * HOUR;
    case 'day':
      return ms + n * DAY;
    case 'week':
      return ms + n * 7 * DAY;
    case 'month':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate(), d.getUTCHours());
    case 'quarter':
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3 * n, d.getUTCDate(), d.getUTCHours());
    case 'year':
      return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate(), d.getUTCHours());
  }
}

/** Every interval start from `from` to `to`, inclusive of the bucket holding `to`. */
export function timeBuckets(from: number, to: number, interval: Interval, max = 5000): number[] {
  const out: number[] = [];
  for (let t = floorTime(from, interval); t <= to && out.length < max; t = addInterval(t, interval))
    out.push(t);
  return out;
}

const APPROX: Record<Interval, number> = {
  minute: MINUTE,
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30.44 * DAY,
  quarter: 91.3 * DAY,
  year: 365.25 * DAY,
};

/** The finest interval that keeps the bucket count at or below `maxBuckets`. */
export function autoInterval(from: number, to: number, maxBuckets = 120): Interval {
  const span = Math.max(0, to - from);
  const order: Interval[] = ['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'];
  for (const i of order) if (span / APPROX[i] <= maxBuckets) return i;
  return 'year';
}

export const PRESET_LABELS: Record<TimePreset, string> = {
  all: 'All time',
  today: 'Today',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  mtd: 'Month to date',
  ytd: 'Year to date',
  '12m': 'Last 12 months',
};

/** The range a preset covers, relative to `now` (UTC days; `to` is open-ended). */
export function presetRange(preset: TimePreset, now: number): { from?: number; to?: number } {
  const today = floorTime(now, 'day');
  switch (preset) {
    case 'all':
      return {};
    case 'today':
      return { from: today };
    case '7d':
      return { from: today - 6 * DAY };
    case '30d':
      return { from: today - 29 * DAY };
    case '90d':
      return { from: today - 89 * DAY };
    case 'mtd':
      return { from: floorTime(now, 'month') };
    case 'ytd':
      return { from: floorTime(now, 'year') };
    case '12m':
      return { from: addInterval(floorTime(now, 'month'), 'month', -11) };
  }
}

/** The equally long period right before [from, to). */
export function previousPeriod(from: number, to: number): { from: number; to: number } {
  return { from: from - (to - from), to: from };
}

export function periodLength(period: '7d' | '30d' | '90d' | 'week' | 'month' | 'quarter' | 'year'): number {
  switch (period) {
    case '7d':
      return 7 * DAY;
    case '30d':
      return 30 * DAY;
    case '90d':
      return 90 * DAY;
    case 'week':
      return 7 * DAY;
    case 'month':
      return Math.round(APPROX.month);
    case 'quarter':
      return Math.round(APPROX.quarter);
    case 'year':
      return Math.round(APPROX.year);
  }
}

export { DAY, HOUR, MINUTE };
