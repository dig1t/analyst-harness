import type { RawRecord } from './extract';
import type { FieldRule, ScraperSpec } from './spec';

export interface InvalidRecord {
  index: number;
  errors: string[];
}

function isMissing(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === 'string' && v.trim() === '') ||
    (Array.isArray(v) && v.length === 0)
  );
}

export function coerce(
  value: unknown,
  rule: FieldRule,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (Array.isArray(value) && rule.type !== 'json') {
    const out: unknown[] = [];
    for (const v of value) {
      const r = coerce(v, rule);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  }
  switch (rule.type) {
    case 'string':
      return { ok: true, value: typeof value === 'object' ? JSON.stringify(value) : String(value) };
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(String(value).replace(/[,\s_]/g, ''));
      if (!Number.isFinite(n)) return { ok: false, error: `not a number: ${JSON.stringify(value)}` };
      if (rule.type === 'integer' && !Number.isInteger(n))
        return { ok: false, error: `not an integer: ${n}` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value };
      const s = String(value).trim().toLowerCase();
      if (['true', 'yes', '1', 'y'].includes(s)) return { ok: true, value: true };
      if (['false', 'no', '0', 'n'].includes(s)) return { ok: true, value: false };
      return { ok: false, error: `not a boolean: ${JSON.stringify(value)}` };
    }
    case 'url':
      try {
        const u = new URL(String(value));
        if (u.protocol !== 'http:' && u.protocol !== 'https:')
          return { ok: false, error: `not an http(s) URL: ${value}` };
        return { ok: true, value: u.toString() };
      } catch {
        return { ok: false, error: `not an absolute URL: ${JSON.stringify(value)}` };
      }
    case 'date': {
      const raw =
        typeof value === 'number' ? (value < 1e11 ? value * 1000 : value) : Date.parse(String(value));
      if (!Number.isFinite(raw)) return { ok: false, error: `not a date: ${JSON.stringify(value)}` };
      return { ok: true, value: new Date(raw).toISOString() };
    }
    case 'json':
      return { ok: true, value };
  }
}

/** Coerce field types and enforce required fields. Records without field rules pass through. */
export function validateRecords(
  spec: ScraperSpec,
  records: RawRecord[],
): { valid: RawRecord[]; invalid: InvalidRecord[] } {
  const rules = Object.entries(spec.fields);
  if (rules.length === 0) return { valid: records, invalid: [] };
  const valid: RawRecord[] = [];
  const invalid: InvalidRecord[] = [];
  records.forEach((rec, index) => {
    const out: RawRecord = {};
    const errors: string[] = [];
    for (const [name, rule] of rules) {
      let v = rec[name];
      if (isMissing(v)) {
        if (rule.default !== undefined) v = rule.default;
        else if (rule.required) {
          errors.push(`${name}: required but missing`);
          continue;
        } else {
          out[name] = null;
          continue;
        }
      }
      const r = coerce(v, rule);
      if (r.ok) out[name] = r.value;
      else if (rule.required) errors.push(`${name}: ${r.error}`);
      else out[name] = null;
    }
    if (errors.length) invalid.push({ index, errors });
    else valid.push(out);
  });
  return { valid, invalid };
}
