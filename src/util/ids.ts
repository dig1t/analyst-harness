import { randomBytes } from 'node:crypto';

/** Sortable, human-readable id: `<prefix>_20261024T170501Z_3f9a1c`. */
export function newId(prefix: string, now: Date = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return `${prefix}_${stamp}_${randomBytes(3).toString('hex')}`;
}

export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
