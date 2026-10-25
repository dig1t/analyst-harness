import { promises as fsp, type Dirent } from 'node:fs';
import path from 'node:path';

export async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}

/** Write JSON through a temp file and rename, so readers never see a half-written file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file);
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  await fsp.rename(tmp, file);
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fsp.appendFile(file, JSON.stringify(value) + '\n', 'utf8');
}

export async function readJsonl<T>(file: string): Promise<T[]> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn final line (crash mid-append) must not make the whole file unreadable.
    }
  }
  return out;
}

/** Recursively list files under `dir` (relative paths, POSIX separators), skipping ignored names. */
export async function walkFiles(
  dir: string,
  ignore: (relPath: string) => boolean = () => false,
): Promise<string[]> {
  const out: string[] = [];
  async function visit(rel: string) {
    const abs = path.join(dir, rel);
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (ignore(childRel)) continue;
      if (entry.isDirectory()) await visit(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  }
  await visit('');
  return out;
}
