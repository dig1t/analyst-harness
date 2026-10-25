import { readFileSync } from 'node:fs';
import path from 'node:path';

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)?\s*$/;

/** Parse `.env` text: KEY=value lines, `export`, comments, single and double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    let value = (m[2] ?? '').trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // An unquoted value ends at an inline comment.
      value = value.replace(/\s+#.*$/, '');
    }
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Load `<root>/.env` (or HARNESS_ENV_FILE; `none` turns it off) into `env` without overriding
 * variables that are already set, so the real environment always wins. Returns the keys set.
 */
export function loadDotEnv(root: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const setting = env.HARNESS_ENV_FILE;
  if (setting === 'none' || setting === '') return [];
  const file = path.resolve(root, setting ?? '.env');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const loaded: string[] = [];
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (env[key] !== undefined) continue;
    env[key] = value;
    loaded.push(key);
  }
  return loaded;
}
