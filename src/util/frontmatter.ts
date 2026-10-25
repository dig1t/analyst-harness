import YAML from 'yaml';

export interface FrontmatterDoc<T = Record<string, unknown>> {
  data: T;
  body: string;
  hasFrontmatter: boolean;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Split a Markdown document into YAML frontmatter and body. Invalid YAML throws. */
export function parseFrontmatter<T = Record<string, unknown>>(text: string): FrontmatterDoc<T> {
  const match = FM_RE.exec(text);
  if (!match) return { data: {} as T, body: text, hasFrontmatter: false };
  const parsed: unknown = YAML.parse(match[1] ?? '');
  const data = (parsed && typeof parsed === 'object' ? parsed : {}) as T;
  return { data, body: text.slice(match[0].length), hasFrontmatter: true };
}

export function stringifyFrontmatter(data: Record<string, unknown>, body: string): string {
  const yaml = YAML.stringify(data).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, '')}`;
}
