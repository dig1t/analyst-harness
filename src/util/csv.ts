/**
 * RFC 4180 CSV: quoted fields, doubled quotes, embedded delimiters and line breaks, CRLF or
 * LF. Shared by the CSV scraper source and the dashboard data loader.
 */
export function parseCsvRows(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // skip a UTF-8 byte order mark
  for (; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** Parse CSV into objects keyed by the header row. Duplicate or empty headers get a suffix. */
export function parseCsv(
  text: string,
  opts: { delimiter?: string; header?: boolean; skipRows?: number } = {},
): { columns: string[]; rows: Record<string, string>[] } {
  const all = parseCsvRows(text, opts.delimiter ?? ',').slice(opts.skipRows ?? 0);
  if (all.length === 0) return { columns: [], rows: [] };
  const width = Math.max(...all.map((r) => r.length));
  let columns: string[];
  let body: string[][];
  if (opts.header === false) {
    columns = Array.from({ length: width }, (_, i) => `column_${i + 1}`);
    body = all;
  } else {
    const seen = new Map<string, number>();
    columns = Array.from({ length: width }, (_, i) => {
      const base = (all[0]![i] ?? '').trim() || `column_${i + 1}`;
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return n === 0 ? base : `${base}_${n + 1}`;
    });
    body = all.slice(1);
  }
  const rows = body.map((r) => {
    const o: Record<string, string> = {};
    columns.forEach((c, i) => (o[c] = r[i] ?? ''));
    return o;
  });
  return { columns, rows };
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}
