import { addInterval, DAY, floorTime, HOUR, MINUTE } from './time';
import type { Interval } from './types';

/** A 1-2-5 step that splits `span` into about `count` intervals. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0) || count <= 0) return 1;
  const raw = span / count;
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** Round, evenly spaced ticks covering [min, max]; the domain extends to the outer ticks. */
export function niceTicks(min: number, max: number, count = 5): { ticks: number[]; step: number } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { ticks: [0], step: 1 };
  if (min === max) {
    if (min === 0) return { ticks: [0, 1], step: 1 };
    const pad = Math.abs(min) * 0.1;
    return niceTicks(min - pad, max + pad, count);
  }
  const step = niceStep(max - min, count);
  const start = Math.floor(min / step + 1e-9) * step;
  const end = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return { ticks, step };
}

export interface LinearScale {
  (v: number): number;
  domain: [number, number];
  range: [number, number];
  invert(px: number): number;
}

export function linearScale(domain: [number, number], range: [number, number]): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const scale = ((v: number) => r0 + (v - d0) * k) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  scale.invert = (px: number) => (k === 0 ? d0 : d0 + (px - r0) / k);
  return scale;
}

/** Whole decades around [min, max] (both positive), for a log axis. */
export function logDomain(min: number, max: number): [number, number] {
  const lo = 10 ** Math.floor(Math.log10(min) + 1e-9);
  const hi = 10 ** Math.ceil(Math.log10(max) - 1e-9);
  return [Number(lo.toPrecision(12)), Number((hi > lo ? hi : lo * 10).toPrecision(12))];
}

/** A log10 scale with the same shape as a linear one (for positive values only). */
export function logScale(domain: [number, number], range: [number, number]): LinearScale {
  const inner = linearScale([Math.log10(domain[0]), Math.log10(domain[1])], range);
  const scale = ((v: number) => inner(Math.log10(v))) as LinearScale;
  scale.domain = domain;
  scale.range = range;
  scale.invert = (px: number) => 10 ** inner.invert(px);
  return scale;
}

/** A value domain that includes zero for bars and areas (magnitudes grow from a baseline). */
export function valueDomain(
  values: number[],
  includeZero: boolean,
  count = 5,
): { ticks: number[]; step: number } {
  const finite = values.filter(Number.isFinite);
  let lo = finite.length ? Math.min(...finite) : 0;
  let hi = finite.length ? Math.max(...finite) : 1;
  if (includeZero) {
    lo = Math.min(0, lo);
    hi = Math.max(0, hi);
  }
  return niceTicks(lo, hi, count);
}

export interface BandScale {
  (v: string): number | undefined;
  domain: string[];
  bandwidth: number;
  step: number;
}

/** Evenly spaced bands across the range, with inner and outer padding as a share of a step. */
export function bandScale(
  domain: string[],
  range: [number, number],
  paddingInner = 0.3,
  paddingOuter = 0.15,
): BandScale {
  const n = domain.length;
  const [r0, r1] = range;
  const step = n === 0 ? 0 : (r1 - r0) / Math.max(1, n - paddingInner + 2 * paddingOuter);
  const bandwidth = step * (1 - paddingInner);
  const index = new Map(domain.map((d, i) => [d, i]));
  const start = r0 + step * paddingOuter;
  const scale = ((v: string) => {
    const i = index.get(v);
    return i === undefined ? undefined : start + i * step;
  }) as BandScale;
  scale.domain = domain;
  scale.bandwidth = bandwidth;
  scale.step = step;
  return scale;
}

const TIME_STEPS: Array<{ level: Interval; ms: number; every: number }> = [
  { level: 'minute', ms: MINUTE, every: 1 },
  { level: 'minute', ms: 5 * MINUTE, every: 5 },
  { level: 'minute', ms: 15 * MINUTE, every: 15 },
  { level: 'minute', ms: 30 * MINUTE, every: 30 },
  { level: 'hour', ms: HOUR, every: 1 },
  { level: 'hour', ms: 3 * HOUR, every: 3 },
  { level: 'hour', ms: 6 * HOUR, every: 6 },
  { level: 'hour', ms: 12 * HOUR, every: 12 },
  { level: 'day', ms: DAY, every: 1 },
  { level: 'day', ms: 2 * DAY, every: 2 },
  { level: 'week', ms: 7 * DAY, every: 1 },
  { level: 'week', ms: 14 * DAY, every: 2 },
  { level: 'month', ms: 30.44 * DAY, every: 1 },
  { level: 'month', ms: 91.3 * DAY, every: 3 },
  { level: 'month', ms: 182.6 * DAY, every: 6 },
  { level: 'year', ms: 365.25 * DAY, every: 1 },
  { level: 'year', ms: 2 * 365.25 * DAY, every: 2 },
  { level: 'year', ms: 5 * 365.25 * DAY, every: 5 },
  { level: 'year', ms: 10 * 365.25 * DAY, every: 10 },
];

/** Calendar-aligned ticks (whole days, months, years) inside [from, to], at most `maxTicks`. */
export function timeTicks(from: number, to: number, maxTicks = 6): { ticks: number[]; level: Interval } {
  const span = Math.max(1, to - from);
  const choice = TIME_STEPS.find((s) => span / s.ms <= maxTicks) ?? TIME_STEPS[TIME_STEPS.length - 1]!;
  const ticks: number[] = [];
  const unit: Interval = choice.level;
  let t = floorTime(from, unit);
  if (unit === 'year')
    t = Date.UTC(Math.ceil(new Date(t).getUTCFullYear() / choice.every) * choice.every, 0, 1);
  if (unit === 'month' && choice.every > 1) {
    const d = new Date(t);
    t = Date.UTC(d.getUTCFullYear(), Math.ceil(d.getUTCMonth() / choice.every) * choice.every, 1);
  }
  if ((unit === 'hour' || unit === 'minute') && choice.every > 1) {
    const size = unit === 'hour' ? HOUR : MINUTE;
    t = Math.ceil(t / (size * choice.every)) * size * choice.every;
  }
  for (let guard = 0; t <= to && guard < 1000; guard++) {
    if (t >= from) ticks.push(t);
    t = addInterval(t, unit, choice.every);
  }
  return { ticks, level: unit };
}

/** Ticks for a log axis: powers of ten, plus 2 and 5 multiples when the range is short. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const lo = Math.floor(Math.log10(min));
  const hi = Math.ceil(Math.log10(max));
  const mults = hi - lo <= 2 ? [1, 2, 5] : [1];
  const ticks: number[] = [];
  for (let e = lo; e <= hi; e++)
    for (const m of mults) {
      const v = Number((m * 10 ** e).toPrecision(12));
      if (v >= min * 0.999 && v <= max * 1.001) ticks.push(v);
    }
  return ticks;
}
