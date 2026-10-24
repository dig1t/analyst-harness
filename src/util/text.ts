/** Count lines the way a reader would (a trailing newline does not add a line). */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/**
 * Truncate long text by keeping the head and the tail and noting what was cut. The paper's
 * harness truncates tool results to 24k characters; keeping the tail preserves error
 * messages that usually appear at the end of command output.
 */
export function truncateMiddle(text: string, maxChars: number, tailRatio = 0.25): string {
  if (text.length <= maxChars) return text;
  const marker = (n: number) => `\n[... ${n} characters truncated ...]\n`;
  const budget = Math.max(0, maxChars - marker(text.length).length);
  const tail = Math.floor(budget * tailRatio);
  const head = budget - tail;
  const removed = text.length - head - tail;
  return text.slice(0, head) + marker(removed) + (tail > 0 ? text.slice(text.length - tail) : '');
}

export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, maxLength).replace(/-+$/g, '') || 'untitled';
}

/** Split text into chunks no longer than `size`, preferring line boundaries. */
export function chunkText(text: string, size: number): string[] {
  if (size < 1) throw new Error('chunk size must be positive');
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length > 0 || chunks.length === 0) chunks.push(rest);
  return chunks;
}

/** Render rows as a GitHub-flavoured Markdown table. */
export function markdownTable(headers: string[], rows: unknown[][]): string {
  const esc = (v: unknown) =>
    String(v ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const lines = [`| ${headers.map(esc).join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  for (const row of rows) lines.push(`| ${row.map(esc).join(' | ')} |`);
  return lines.join('\n');
}

export function formatUsd(amount: number): string {
  return `$${amount < 0.01 && amount > 0 ? amount.toFixed(4) : amount.toFixed(2)}`;
}
