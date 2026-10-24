import { createHash } from 'node:crypto';

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** JSON.stringify with object keys sorted recursively, so equal data hashes equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function hashRecord(value: unknown): string {
  return sha256(stableStringify(value)).slice(0, 16);
}
