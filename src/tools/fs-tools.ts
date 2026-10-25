import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { PostEditDiagnostics } from '../diagnostics/post-edit';
import { ToolError } from '../util/errors';
import { DEFAULT_IGNORES, globToRegExp, isIgnoredPath } from '../util/glob';
import { unifiedDiff } from '../util/diff';
import { walkFiles } from '../util/fs';
import { defineTool, requirePermission, type ToolContext, type ToolDefinition } from './types';

async function statOrNull(abs: string) {
  try {
    return await fsp.stat(abs);
  } catch {
    return null;
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

async function guardSensitiveRead(ctx: ToolContext, display: string): Promise<void> {
  if (ctx.workspace.isSensitive(display)) {
    await requirePermission(ctx, {
      kind: 'read_sensitive',
      tool: 'read_file',
      summary: `read sensitive file ${display}`,
      path: display,
    });
  }
}

const diagnostics = new PostEditDiagnostics();

async function postEdit(ctx: ToolContext, abs: string, content: string): Promise<string> {
  if (!ctx.config.postEditDiagnostics) return '';
  return PostEditDiagnostics.format(await diagnostics.check(abs, content));
}

export const readFileTool = defineTool({
  name: 'read_file',
  category: 'workspace',
  readOnly: true,
  usageRule:
    'read files and datasets with line numbers; required before edit_file or write_file(overwrite=true).',
  description: `Read the contents of a text file from the workspace, returned with 1-based line numbers and a header describing what range was read.
When: call this BEFORE edit_file or write_file(overwrite=true) on any existing file: the harness enforces read-before-write and rejects edits without a recorded full read. For directory listings use list_files; for content search use grep_text; for large tabular data prefer sql_query.
Protocol: returns lines [offset, offset+limit) using 1-based offsets. Default reads from line 1 with limit=2000. The read is recorded as full_read=True ONLY when offset=1 AND limit covers the entire file; partial reads do NOT satisfy the read-before-write gate.
Error modes: returns an error for non-existent paths, paths outside the workspace, directories (use list_files), binary files (NUL byte in the first 8KB), files over the size cap (use bash with head/sed), or offsets past EOF. Sensitive paths (.env, secrets, keys) trigger a permission prompt.
Side effects: records the read in the session's file state.`,
  schema: z.object({
    path: z.string().describe('Path relative to the workspace root'),
    offset: z.number().int().min(1).optional().describe('1-based line to start from (default 1)'),
    limit: z.number().int().min(1).max(20_000).optional().describe('Maximum number of lines (default 2000)'),
  }),
  async execute({ path: p, offset = 1, limit = 2000 }, ctx) {
    const r = await ctx.workspace.resolve(p, 'read');
    const st = await statOrNull(r.abs);
    if (!st) throw new ToolError(`File not found: ${r.display}`);
    if (st.isDirectory())
      throw new ToolError(`${r.display} is a directory. Use list_files to see its contents.`);
    if (st.size > ctx.config.maxReadBytes) {
      throw new ToolError(
        `${r.display} is ${st.size} bytes, over the ${ctx.config.maxReadBytes}-byte read cap. Use bash with head, tail or sed, or sql_query for tabular data.`,
      );
    }
    await guardSensitiveRead(ctx, r.display);
    const buf = await fsp.readFile(r.abs);
    if (looksBinary(buf))
      throw new ToolError(`${r.display} looks binary. Use bash (file, xxd, or a parser) to inspect it.`);
    const text = buf.toString('utf8');
    const lines = text.length === 0 ? [] : text.replace(/\n$/, '').split('\n');
    if (lines.length > 0 && offset > lines.length) {
      throw new ToolError(`offset ${offset} is past the end of ${r.display} (${lines.length} lines).`);
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const fullRead = offset === 1 && slice.length === lines.length;
    ctx.workspace.fileState.recordRead(r.abs, text, fullRead);
    const width = String(offset + slice.length).length;
    const body = slice.map((line, i) => `${String(offset + i).padStart(width)}\t${line}`).join('\n');
    const end = offset + slice.length - 1;
    const header =
      lines.length === 0
        ? `[${r.display}: empty file]`
        : `[${r.display}: lines ${offset}-${end} of ${lines.length}${fullRead ? ', full read' : ', partial read'}]`;
    return { content: body ? `${header}\n${body}` : header };
  },
});

export const writeFileTool = defineTool({
  name: 'write_file',
  category: 'workspace',
  readOnly: false,
  usageRule:
    'prefer for NEW files. To overwrite an existing file pass overwrite=true AND read it fully first.',
  description: `Write content to a file path: creates a new file or overwrites an existing one. Returns a unified diff of the change (against empty content for new files).
When: use this for (a) creating new files (scripts, reports, cleaned datasets), (b) full-file rewrites. For small in-place edits to existing files use edit_file instead.
Protocol: if the path doesn't exist, the file is created and parent directories are created as needed. If the path exists, you MUST pass overwrite=true AND you MUST have called read_file with a full read on this path in this session.
Error modes: recoverable errors when the file exists and overwrite=false (use edit_file or overwrite=true), when the path is a directory, outside the workspace or in a read-only mount, when the file was never read or only partially read, or when it changed on disk since the recorded read.
Side effects: writes the file. Updates the session's file state, so a later edit_file on this path passes the read-before-write check without re-reading. Supported file types get post-edit diagnostics appended.`,
  schema: z.object({
    path: z.string().describe('Path relative to the workspace root'),
    content: z.string().describe('Full file content'),
    overwrite: z.boolean().optional().describe('Required (true) to replace an existing file'),
  }),
  async execute({ path: p, content, overwrite = false }, ctx) {
    const r = await ctx.workspace.resolve(p, 'write');
    const st = await statOrNull(r.abs);
    let previous = '';
    if (st?.isDirectory()) throw new ToolError(`${r.display} is a directory.`);
    if (st) {
      if (!overwrite)
        throw new ToolError(
          `${r.display} already exists. Use edit_file for targeted changes, or pass overwrite=true after reading it fully.`,
        );
      previous = await ctx.workspace.fileState.assertCanModify(r.abs, r.display);
    }
    await requirePermission(ctx, {
      kind: 'write',
      tool: 'write_file',
      summary: `${st ? 'overwrite' : 'create'} ${r.display}`,
      path: r.display,
    });
    await fsp.mkdir(path.dirname(r.abs), { recursive: true });
    await fsp.writeFile(r.abs, content, 'utf8');
    ctx.workspace.fileState.recordWrite(r.abs, content);
    const diff = unifiedDiff(previous, content, r.display);
    const diag = await postEdit(ctx, r.abs, content);
    return {
      content: `${st ? 'Overwrote' : 'Created'} ${r.display} (${content.length} chars).\n${diff}${diag}`,
      changedFiles: [r.display],
    };
  },
});

export const editFileTool = defineTool({
  name: 'edit_file',
  category: 'workspace',
  readOnly: false,
  usageRule: '`old_text` must be unique in the file (or pass replace_all=true). Read the target fully first.',
  description: `Edit a text file by replacing one or more occurrences of old_text with new_text. Returns a unified diff of the applied change.
When: use this for SMALL, TARGETED changes to EXISTING files. For new files use write_file; for full rewrites use write_file(overwrite=true).
Protocol: old_text MUST appear in the file and the match is byte-exact (including whitespace and line endings). If old_text appears more than once, provide more surrounding context to make it unique, or pass replace_all=true. old_text == new_text is rejected as a no-op. The file MUST have been fully read in this session.
Error modes: recoverable errors for a missing file (use write_file), a directory, old_text not found, an ambiguous match without replace_all, identical old/new text, a path outside the workspace or in a read-only mount, a file never read or only partially read, or a file modified on disk since the read.
Side effects: writes the file and updates the session's file state. Supported file types get post-edit diagnostics appended.`,
  schema: z.object({
    path: z.string(),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().optional(),
  }),
  async execute({ path: p, old_text, new_text, replace_all = false }, ctx) {
    const r = await ctx.workspace.resolve(p, 'write');
    const st = await statOrNull(r.abs);
    if (!st) throw new ToolError(`${r.display} does not exist. Use write_file to create it.`);
    if (st.isDirectory()) throw new ToolError(`${r.display} is a directory.`);
    if (old_text === new_text) throw new ToolError('old_text and new_text are identical; nothing to change.');
    const current = await ctx.workspace.fileState.assertCanModify(r.abs, r.display);
    const occurrences = current.split(old_text).length - 1;
    if (occurrences === 0)
      throw new ToolError(
        `old_text was not found in ${r.display}. Re-read the file and copy the exact text, including whitespace.`,
      );
    if (occurrences > 1 && !replace_all) {
      throw new ToolError(
        `old_text appears ${occurrences} times in ${r.display}. Add surrounding context to make it unique, or pass replace_all=true.`,
      );
    }
    const updated = replace_all
      ? current.split(old_text).join(new_text)
      : current.replace(old_text, () => new_text);
    await requirePermission(ctx, {
      kind: 'write',
      tool: 'edit_file',
      summary: `edit ${r.display}`,
      path: r.display,
    });
    await fsp.writeFile(r.abs, updated, 'utf8');
    ctx.workspace.fileState.recordWrite(r.abs, updated);
    const diag = await postEdit(ctx, r.abs, updated);
    return {
      content: `Edited ${r.display} (${replace_all ? occurrences : 1} replacement${occurrences > 1 && replace_all ? 's' : ''}).\n${unifiedDiff(current, updated, r.display)}${diag}`,
      changedFiles: [r.display],
    };
  },
});

export const listFilesTool = defineTool({
  name: 'list_files',
  category: 'workspace',
  readOnly: true,
  usageRule: 'explore structure before reading; set recursive=true to descend.',
  description: `List files and directories in the workspace, returning a tree-style view with relative paths and (for files) byte sizes.
When: use this to explore project or dataset structure before reading specific files. For pattern-based discovery use glob_files; for content search use grep_text.
Protocol: returns up to max_entries entries (default 200, max 2000), sorted alphabetically within each directory. Set recursive=true to descend into subdirectories; depth is shown by indentation. Mount aliases such as knowledge/ and skills/ address the knowledge vault and the skills library.
Error modes: returns an error if path doesn't exist or isn't a directory. Ignored names (.git, __pycache__, .venv, node_modules) are filtered. Paths outside the workspace are rejected.
Side effects: none (read-only).`,
  schema: z.object({
    path: z.string().optional().describe('Directory relative to the workspace root (default ".")'),
    recursive: z.boolean().optional(),
    max_entries: z.number().int().min(1).max(2000).optional(),
  }),
  async execute({ path: p = '.', recursive = false, max_entries = 200 }, ctx) {
    const r = await ctx.workspace.resolve(p, 'read');
    const st = await statOrNull(r.abs);
    if (!st) throw new ToolError(`Directory not found: ${r.display}`);
    if (!st.isDirectory()) throw new ToolError(`${r.display} is a file, not a directory. Use read_file.`);
    const lines: string[] = [];
    let truncated = false;
    async function visit(dir: string, depth: number) {
      const entries = (await fsp.readdir(dir, { withFileTypes: true })).filter(
        (e) => !DEFAULT_IGNORES.includes(e.name),
      );
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (lines.length >= max_entries) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, e.name);
        const indent = '  '.repeat(depth);
        if (e.isDirectory()) {
          lines.push(`${indent}${e.name}/`);
          if (recursive) await visit(abs, depth + 1);
        } else {
          const size = (await statOrNull(abs))?.size ?? 0;
          lines.push(`${indent}${e.name} (${size} bytes)`);
        }
      }
    }
    await visit(r.abs, 0);
    const header = `[${r.display}${recursive ? ', recursive' : ''}: ${lines.length} entries${truncated ? `, truncated at ${max_entries}` : ''}]`;
    return { content: lines.length ? `${header}\n${lines.join('\n')}` : `${header}\n(empty)` };
  },
});

export const globFilesTool = defineTool({
  name: 'glob_files',
  category: 'workspace',
  readOnly: true,
  usageRule: 'find files by pattern such as **/*.csv.',
  description: `Find files matching a glob pattern within the workspace.
When: use this when you know the file pattern (\`**/*.csv\`, \`datasets/*/2026-*.jsonl\`). For listing a single directory use list_files; for content search use grep_text.
Protocol: returns up to max_matches matching file paths (default 200, max 1000), relative to the searched path's mount. Pattern syntax: \`**\` recursive, \`*\` within a segment, \`?\` single char, \`[abc]\` character class, \`{a,b}\` alternation. Only files are returned.
Error modes: returns an empty result (not an error) when no files match. Returns an error if path doesn't exist or isn't a directory. Ignored directories are skipped.
Side effects: none (read-only).`,
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    max_matches: z.number().int().min(1).max(1000).optional(),
  }),
  async execute({ pattern, path: p = '.', max_matches = 200 }, ctx) {
    const r = await ctx.workspace.resolve(p, 'read');
    const st = await statOrNull(r.abs);
    if (!st?.isDirectory()) throw new ToolError(`${r.display} is not a directory.`);
    const re = globToRegExp(pattern);
    const files = await walkFiles(r.abs, (rel) => isIgnoredPath(rel));
    const prefix = r.display === '.' ? '' : `${r.display}/`;
    const matches = files
      .filter((f) => re.test(f))
      .slice(0, max_matches)
      .map((f) => prefix + f);
    if (matches.length === 0) return { content: `No files match ${pattern} under ${r.display}.` };
    return {
      content: `[${matches.length} match${matches.length === 1 ? '' : 'es'}${matches.length === max_matches ? ' (limit reached)' : ''}]\n${matches.join('\n')}`,
    };
  },
});

export const grepTextTool = defineTool({
  name: 'grep_text',
  category: 'workspace',
  readOnly: true,
  usageRule: 'search file contents by regex; restrict with include (for example *.py).',
  description: `Search for a regex pattern across workspace files, returning matched lines with paths and line numbers.
When: use this to find content: column names, function definitions, error messages, configuration values, TODOs. For file-name patterns use glob_files.
Protocol: query is a JavaScript regular expression (a leading (?i) makes it case-insensitive). Returns up to max_matches hits (default 100), formatted as path:line:matched_text. Use include to restrict to a filename glob (for example *.py or **/*.sql). Set case_sensitive=false for case-insensitive matching.
Error modes: returns an empty result (not an error) when there are no matches. Binary files and files over 10MB are skipped. An invalid regex returns an error.
Side effects: none (read-only).`,
  schema: z.object({
    query: z.string().min(1),
    path: z.string().optional(),
    include: z.string().optional(),
    case_sensitive: z.boolean().optional(),
    max_matches: z.number().int().min(1).max(1000).optional(),
  }),
  async execute({ query, path: p = '.', include, case_sensitive = true, max_matches = 100 }, ctx) {
    const r = await ctx.workspace.resolve(p, 'read');
    let source = query;
    let flags = case_sensitive ? '' : 'i';
    if (source.startsWith('(?i)')) {
      source = source.slice(4);
      flags = 'i';
    }
    let re: RegExp;
    try {
      re = new RegExp(source, flags);
    } catch (err) {
      throw new ToolError(`Invalid regular expression: ${(err as Error).message}`);
    }
    const includeRe = include ? globToRegExp(include.includes('/') ? include : `**/${include}`) : undefined;
    const st = await statOrNull(r.abs);
    if (!st) throw new ToolError(`Path not found: ${r.display}`);
    const files = st.isDirectory() ? await walkFiles(r.abs, (rel) => isIgnoredPath(rel)) : [''];
    const prefix = st.isDirectory() ? (r.display === '.' ? '' : `${r.display}/`) : r.display;
    const hits: string[] = [];
    for (const rel of files) {
      if (hits.length >= max_matches) break;
      if (includeRe && rel && !includeRe.test(rel)) continue;
      const abs = rel ? path.join(r.abs, rel) : r.abs;
      const fst = await statOrNull(abs);
      if (!fst || fst.size > 10 * 1024 * 1024) continue;
      const buf = await fsp.readFile(abs);
      if (looksBinary(buf)) continue;
      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length && hits.length < max_matches; i++) {
        if (re.test(lines[i]!)) hits.push(`${prefix}${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
      }
    }
    if (hits.length === 0) return { content: `No matches for /${query}/ under ${r.display}.` };
    return {
      content: `[${hits.length} match${hits.length === 1 ? '' : 'es'}${hits.length >= max_matches ? ' (limit reached)' : ''}]\n${hits.join('\n')}`,
    };
  },
});

export const fileTools: Array<ToolDefinition<never>> = [
  readFileTool,
  writeFileTool,
  editFileTool,
  listFilesTool,
  globFilesTool,
  grepTextTool,
] as Array<ToolDefinition<never>>;
