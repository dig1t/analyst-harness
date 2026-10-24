/**
 * Convert a glob to a RegExp over POSIX relative paths. Supports `**` (any depth), `*`
 * (within a segment), `?`, `[abc]` classes and `{a,b}` alternation.
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  let inClass = false;
  let braceDepth = 0;
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (inClass) {
      if (ch === ']') inClass = false;
      re += ch === '\\' ? '\\\\' : ch;
      continue;
    }
    switch (ch) {
      case '*': {
        if (glob[i + 1] === '*') {
          const atSegmentStart = i === 0 || glob[i - 1] === '/';
          const followedBySlash = glob[i + 2] === '/';
          if (atSegmentStart && followedBySlash) {
            re += '(?:[^/]*/)*';
            i += 2;
          } else {
            re += '.*';
            i += 1;
          }
        } else {
          re += '[^/]*';
        }
        break;
      }
      case '?':
        re += '[^/]';
        break;
      case '[':
        inClass = true;
        re += glob[i + 1] === '!' ? (i++, '[^') : '[';
        break;
      case '{':
        braceDepth++;
        re += '(?:';
        break;
      case '}':
        if (braceDepth > 0) {
          braceDepth--;
          re += ')';
        } else re += '\\}';
        break;
      case ',':
        re += braceDepth > 0 ? '|' : ',';
        break;
      default:
        re += /[.+^$()|\\]/.test(ch) ? '\\' + ch : ch;
    }
  }
  return new RegExp(`^${re}$`);
}

export const DEFAULT_IGNORES = ['.git', '__pycache__', '.venv', 'node_modules', '.obsidian', '.trash'];

export function isIgnoredPath(relPath: string, ignores: readonly string[] = DEFAULT_IGNORES): boolean {
  return relPath.split('/').some((segment) => ignores.includes(segment));
}
