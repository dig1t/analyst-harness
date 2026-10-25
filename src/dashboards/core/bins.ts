import { niceStep } from './scales';

export interface Bin {
  x0: number;
  x1: number;
  count: number;
}

/**
 * Histogram bins on round edges. The bin count follows the Freedman-Diaconis rule (robust to
 * outliers), falls back to Sturges for tiny spreads, and stays between 5 and `maxBins`.
 */
export function binNumbers(values: number[], requested?: number, maxBins = 40): Bin[] {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length === 0) return [];
  const lo = nums[0]!;
  const hi = nums[nums.length - 1]!;
  if (lo === hi) return [{ x0: lo, x1: lo + 1, count: nums.length }];
  let count = requested;
  if (!count) {
    const q1 = nums[Math.floor(nums.length * 0.25)]!;
    const q3 = nums[Math.floor(nums.length * 0.75)]!;
    const iqr = q3 - q1;
    const width = iqr > 0 ? (2 * iqr) / Math.cbrt(nums.length) : 0;
    count = width > 0 ? Math.ceil((hi - lo) / width) : Math.ceil(Math.log2(nums.length) + 1);
  }
  count = Math.max(5, Math.min(maxBins, count));
  const step = niceStep(hi - lo, count);
  const start = Math.floor(lo / step) * step;
  const n = Math.max(1, Math.ceil((hi - start) / step + 1e-9));
  const bins: Bin[] = Array.from({ length: n }, (_, i) => ({
    x0: Number((start + i * step).toPrecision(12)),
    x1: Number((start + (i + 1) * step).toPrecision(12)),
    count: 0,
  }));
  for (const v of nums) {
    const i = Math.min(n - 1, Math.floor((v - start) / step + 1e-9));
    bins[i]!.count++;
  }
  return bins;
}

export interface Tail {
  /** Values above `from` (the 99th percentile), up to `max`. */
  count: number;
  from: number;
  max: number;
}

/**
 * Bins for skewed data. When a few extreme values would squash everything else into one bar
 * (max more than three times the 99th percentile), bin up to the 99th percentile and report
 * the rest as a tail, so the shape stays readable and no value is dropped.
 */
export function binWithTail(
  values: number[],
  requested?: number,
  maxBins = 40,
): { bins: Bin[]; tail: Tail | null } {
  const nums = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (nums.length < 50) return { bins: binNumbers(nums, requested, maxBins), tail: null };
  const lo = nums[0]!;
  const hi = nums[nums.length - 1]!;
  const p99 = nums[Math.floor((nums.length - 1) * 0.99)]!;
  const heavy = hi > 0 && p99 > lo && hi > Math.abs(p99) * 3 && hi - p99 > p99 - lo;
  if (!heavy) return { bins: binNumbers(nums, requested, maxBins), tail: null };
  const core = nums.filter((v) => v <= p99);
  const rest = nums.length - core.length;
  return {
    bins: binNumbers(core, requested, maxBins),
    tail: rest > 0 ? { count: rest, from: p99, max: hi } : null,
  };
}

/** Should a positive distribution use a log axis? True when it spans orders of magnitude. */
export function prefersLog(values: number[]): boolean {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length < 20 || nums[0]! <= 0) return false;
  const q = (p: number) => nums[Math.floor((nums.length - 1) * p)]!;
  return q(0.9) / q(0.1) >= 100 || q(0.99) / q(0.5) >= 50;
}

/**
 * Log-spaced bins of equal width on a log axis (positive values only), so bar heights compare
 * fairly. Edges are whole decades split into 1 to 5 steps, aiming at about `target` bins.
 */
export function binLog(values: number[], target = 24): Bin[] {
  const nums = values.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (nums.length === 0) return [];
  const lo = Math.floor(Math.log10(nums[0]!));
  const hi = Math.max(lo + 1, Math.ceil(Math.log10(nums[nums.length - 1]!)));
  const per = Math.max(1, Math.min(5, Math.round(target / (hi - lo))));
  const edges: number[] = [];
  for (let k = lo * per; k <= hi * per; k++) edges.push(Number((10 ** (k / per)).toPrecision(12)));
  while (edges.length > 2 && edges[1]! <= nums[0]!) edges.shift();
  while (edges.length > 2 && edges[edges.length - 2]! >= nums[nums.length - 1]!) edges.pop();
  const bins: Bin[] = edges.slice(0, -1).map((x0, i) => ({ x0, x1: edges[i + 1]!, count: 0 }));
  let i = 0;
  for (const v of nums) {
    while (i < bins.length - 1 && v >= bins[i]!.x1) i++;
    bins[i]!.count++;
  }
  return bins;
}
