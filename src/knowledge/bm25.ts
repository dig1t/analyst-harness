const STOPWORDS = new Set(
  'a an and are as at be but by for from has have how i in is it its of on or that the this to was what when where which who why will with you your do does not can into than then there these those use using via vs'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    // Light stemming: plural "s" only, enough to match "selectors" with "selector".
    out.push(raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
  }
  return out;
}

export interface Bm25Doc {
  id: string;
  /** Weighted fields: tokens in heavier fields count more. */
  fields: Array<{ text: string; weight: number }>;
}

/** Okapi BM25 over weighted fields (k1 = 1.2, b = 0.75). */
export class Bm25Index {
  private readonly docs: Array<{ id: string; tf: Map<string, number>; length: number }> = [];
  private readonly df = new Map<string, number>();
  private avgLength = 0;

  constructor(
    docs: Bm25Doc[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    let total = 0;
    for (const doc of docs) {
      const tf = new Map<string, number>();
      let length = 0;
      for (const field of doc.fields) {
        for (const token of tokenize(field.text)) {
          tf.set(token, (tf.get(token) ?? 0) + field.weight);
          length += field.weight;
        }
      }
      for (const token of tf.keys()) this.df.set(token, (this.df.get(token) ?? 0) + 1);
      this.docs.push({ id: doc.id, tf, length });
      total += length;
    }
    this.avgLength = this.docs.length ? total / this.docs.length : 0;
  }

  get size(): number {
    return this.docs.length;
  }

  search(query: string, limit = 10): Array<{ id: string; score: number }> {
    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];
    const n = this.docs.length;
    const scores: Array<{ id: string; score: number }> = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score +=
          (idf * f * (this.k1 + 1)) /
          (f + this.k1 * (1 - this.b + (this.b * doc.length) / (this.avgLength || 1)));
      }
      if (score > 0) scores.push({ id: doc.id, score });
    }
    return scores.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
  }
}

/** Pick the passage around the densest cluster of query terms. */
export function bestSnippet(text: string, query: string, width = 240): string {
  const terms = new Set(tokenize(query));
  const lines = text
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('>') && !l.startsWith('---') && !l.startsWith('#'));
  let best = lines[0] ?? '';
  let bestScore = -1;
  for (const line of lines) {
    const score = tokenize(line).filter((t) => terms.has(t)).length;
    if (score > bestScore) {
      best = line;
      bestScore = score;
    }
  }
  const clean = best.replace(/\s+/g, ' ').trim();
  return clean.length > width ? clean.slice(0, width - 3) + '...' : clean;
}
