import { isMissing } from './infer';
import { toTime } from './time';
import type { ColumnType, Interval } from './types';

export type Formatter = (v: unknown) => string;

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();

function numberFormat(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `n|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.NumberFormat | undefined;
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, opts);
    } catch {
      f = new Intl.NumberFormat('en-US', opts);
    }
    cache.set(key, f);
  }
  return f;
}

function dateFormat(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `d|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key) as Intl.DateTimeFormat | undefined;
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...opts });
    } catch {
      f = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts });
    }
    cache.set(key, f);
  }
  return f;
}

/** Formats a dashboard spec may name. Parameters follow a colon: `decimal:1`, `currency:EUR`. */
export const FORMAT_NAMES = [
  'auto',
  'number',
  'integer',
  'decimal',
  'percent',
  'compact',
  'currency',
  'date',
  'datetime',
  'month',
  'quarter',
  'year',
  'text',
  'url',
  'bytes',
  'duration',
] as const;

export function isValidFormat(format: string): boolean {
  const [name, arg, arg2] = format.split(':');
  if (!(FORMAT_NAMES as readonly string[]).includes(name!)) return false;
  if (name === 'currency')
    return /^[A-Za-z]{3}$/.test(arg ?? '') && (arg2 === undefined || /^\d$/.test(arg2));
  if (name === 'decimal' || name === 'percent') return arg === undefined || /^\d$/.test(arg);
  return arg === undefined;
}

export function compactNumber(n: number, locale = 'en-US'): string {
  if (Math.abs(n) < 1000)
    return numberFormat(locale, { maximumFractionDigits: Math.abs(n) < 10 ? 2 : 1 }).format(n);
  return numberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Sizes in SI units (1 kB = 1000 B), so decimal and log axis ticks read as round numbers. */
export function formatBytes(n: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(n);
  let i = 0;
  while (v >= 999.5 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const text = i > 0 && v < 9.95 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v));
  return `${n < 0 ? '-' : ''}${text} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(Math.abs(seconds));
  const parts: string[] = [];
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m && d === 0) parts.push(`${m}m`);
  if (sec && d === 0 && h === 0) parts.push(`${sec}s`);
  return (seconds < 0 ? '-' : '') + (parts.join(' ') || '0s');
}

/** Show a URL without its scheme and trailing slash, shortened to fit a table cell. */
export function displayUrl(url: string, max = 48): string {
  const s = url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
  return s.length > max ? s.slice(0, max - 1) + '\u2026' : s;
}

export function formatTime(ms: number, interval: Interval | 'datetime', locale = 'en-US'): string {
  switch (interval) {
    case 'minute':
    case 'hour':
      return dateFormat(locale, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(ms);
    case 'datetime':
      return (
        dateFormat(locale, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(ms) + ' UTC'
      );
    case 'day':
      return dateFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms);
    case 'week':
      return `Week of ${dateFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(ms)}`;
    case 'month':
      return dateFormat(locale, { year: 'numeric', month: 'short' }).format(ms);
    case 'quarter':
      return `Q${Math.floor(new Date(ms).getUTCMonth() / 3) + 1} ${new Date(ms).getUTCFullYear()}`;
    case 'year':
      return String(new Date(ms).getUTCFullYear());
  }
}

/** Build a formatter from a spec format (or the column type when the format is absent). */
export function makeFormatter(format: string | undefined, type: ColumnType, locale = 'en-US'): Formatter {
  const [name = 'auto', arg, arg2] = (format ?? 'auto').split(':');
  const num =
    (fn: (n: number) => string): Formatter =>
    (v) => {
      if (isMissing(v)) return '';
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? fn(n) : String(v);
    };
  const time =
    (interval: Interval | 'datetime'): Formatter =>
    (v) => {
      if (isMissing(v)) return '';
      const t = toTime(v);
      return t === null ? String(v) : formatTime(t, interval, locale);
    };
  switch (name) {
    case 'integer':
      return num((n) => numberFormat(locale, { maximumFractionDigits: 0 }).format(n));
    case 'number':
      return num((n) => numberFormat(locale, { maximumFractionDigits: 2 }).format(n));
    case 'decimal': {
      const d = Number(arg ?? 2);
      return num((n) =>
        numberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d }).format(n),
      );
    }
    case 'percent': {
      const d = Number(arg ?? 1);
      return num((n) => numberFormat(locale, { style: 'percent', maximumFractionDigits: d }).format(n));
    }
    case 'compact':
      return num((n) => compactNumber(n, locale));
    case 'currency': {
      const currency = (arg ?? 'USD').toUpperCase();
      const opts: Intl.NumberFormatOptions = { style: 'currency', currency };
      if (arg2 !== undefined) {
        opts.minimumFractionDigits = Number(arg2);
        opts.maximumFractionDigits = Number(arg2);
      }
      return num((n) => numberFormat(locale, opts).format(n));
    }
    case 'bytes':
      return num(formatBytes);
    case 'duration':
      return num(formatDuration);
    case 'date':
      return time('day');
    case 'datetime':
      return time('datetime');
    case 'month':
      return time('month');
    case 'quarter':
      return time('quarter');
    case 'year':
      return time('year');
    case 'url':
      return (v) => (isMissing(v) ? '' : displayUrl(String(v)));
    case 'text':
      return (v) => (isMissing(v) ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
    default:
      break;
  }
  switch (type) {
    case 'integer':
      return makeFormatter('integer', type, locale);
    case 'number':
      return num((n) =>
        numberFormat(locale, {
          maximumFractionDigits: Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 1 ? 2 : 4,
        }).format(n),
      );
    case 'date':
      return time('day');
    case 'datetime':
      return time('datetime');
    case 'boolean':
      return (v) => (isMissing(v) ? '' : v === true || v === 'true' ? 'Yes' : 'No');
    case 'url':
      return makeFormatter('url', type, locale);
    default:
      return makeFormatter('text', type, locale);
  }
}

/** Axis tick labels: compact from 1,000 up, decimals only as fine as the tick step. */
export function formatTick(v: number, step: number, locale = 'en-US'): string {
  if (Math.abs(v) >= 1000 || (Math.abs(step) >= 1000 && v !== 0)) return compactNumber(v, locale);
  const decimals = step >= 1 || step === 0 ? 0 : Math.min(6, Math.ceil(-Math.log10(step)));
  return numberFormat(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(v);
}

/** Time tick labels, coarse to fine; the first tick and each January carry the year. */
export function formatTimeTick(ms: number, level: Interval, isFirst: boolean, locale = 'en-US'): string {
  const d = new Date(ms);
  switch (level) {
    case 'year':
      return String(d.getUTCFullYear());
    case 'quarter':
    case 'month':
      return isFirst || d.getUTCMonth() === 0
        ? dateFormat(locale, { month: 'short', year: 'numeric' }).format(ms)
        : dateFormat(locale, { month: 'short' }).format(ms);
    case 'week':
    case 'day':
      return isFirst || (d.getUTCMonth() === 0 && d.getUTCDate() <= 7)
        ? dateFormat(locale, { month: 'short', day: 'numeric', year: 'numeric' }).format(ms)
        : dateFormat(locale, { month: 'short', day: 'numeric' }).format(ms);
    default:
      return d.getUTCHours() === 0 && d.getUTCMinutes() === 0
        ? dateFormat(locale, { month: 'short', day: 'numeric' }).format(ms)
        : dateFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms);
  }
}
