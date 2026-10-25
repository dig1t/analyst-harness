type Op = { kind: 'eq' | 'del' | 'add'; line: string };

/** Line diff via LCS. Quadratic, so callers cap the input size. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'eq', line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ kind: 'del', line: a[i++]! });
    } else {
      ops.push({ kind: 'add', line: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++]! });
  while (j < m) ops.push({ kind: 'add', line: b[j++]! });
  return ops;
}

/**
 * Unified diff between two texts with `context` lines around each change. Large inputs
 * fall back to a summary line instead of an expensive diff.
 */
export function unifiedDiff(
  oldText: string,
  newText: string,
  file: string,
  context = 3,
  maxLines = 4_000,
): string {
  if (oldText === newText) return '(no changes)';
  const a = oldText === '' ? [] : oldText.replace(/\n$/, '').split('\n');
  const b = newText === '' ? [] : newText.replace(/\n$/, '').split('\n');
  if (a.length > maxLines || b.length > maxLines) {
    return `--- a/${file}\n+++ b/${file}\n(file too large for an inline diff: ${a.length} -> ${b.length} lines)`;
  }
  const ops = diffLines(a, b);
  const out = [`--- a/${file}`, `+++ b/${file}`];
  // Group changes into hunks with surrounding context.
  let idx = 0;
  let oldLine = 1;
  let newLine = 1;
  const positions = ops.map((op) => {
    const pos = { op, oldLine, newLine };
    if (op.kind !== 'add') oldLine++;
    if (op.kind !== 'del') newLine++;
    return pos;
  });
  while (idx < positions.length) {
    while (idx < positions.length && positions[idx]!.op.kind === 'eq') idx++;
    if (idx >= positions.length) break;
    const start = Math.max(0, idx - context);
    let end = idx;
    let lastChange = idx;
    while (end < positions.length) {
      if (positions[end]!.op.kind !== 'eq') lastChange = end;
      if (end - lastChange > context * 2) break;
      end++;
    }
    end = Math.min(positions.length, lastChange + context + 1);
    const hunk = positions.slice(start, end);
    const oldCount = hunk.filter((p) => p.op.kind !== 'add').length;
    const newCount = hunk.filter((p) => p.op.kind !== 'del').length;
    const oldStart = oldCount === 0 ? hunk[0]!.oldLine - 1 : hunk[0]!.oldLine;
    const newStart = newCount === 0 ? hunk[0]!.newLine - 1 : hunk[0]!.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const p of hunk) out.push((p.op.kind === 'eq' ? ' ' : p.op.kind === 'del' ? '-' : '+') + p.op.line);
    idx = end;
  }
  return out.join('\n');
}
