/**
 * A small, safe Markdown renderer for dashboard text blocks. All input HTML is escaped first,
 * then a fixed subset of Markdown is applied: headings, paragraphs, emphasis, inline code,
 * http(s) links, lists, quotes, code blocks, rules and pipe tables. Nothing the author writes
 * can produce a tag or attribute outside that subset.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(raw: string): string | null {
  const url = raw.trim();
  return /^https?:\/\/[^\s"'<>]+$/i.test(url) ? url : null;
}

/** Inline formatting on already-escaped text. Code spans park behind a private-use marker. */
function inline(escaped: string): string {
  const codes: string[] = [];
  let s = escaped.replace(/\ue000/g, '').replace(/`([^`]+)`/g, (_m, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\ue000${codes.length - 1}\ue000`;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) => {
    // The href was escaped with the rest; undo only the entity for & so query strings work.
    const url = safeHref(href.replace(/&amp;/g, '&'));
    return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>` : m;
  });
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
  return s.replace(/\ue000(\d+)\ue000/g, (_m, i: string) => codes[Number(i)] ?? '');
}

function tableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(escapeHtml(para.join(' ')))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed.startsWith('```')) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trim().startsWith('```'); i++) code.push(lines[i]!);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (trimmed === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flush();
      const level = Math.min(6, heading[1]!.length + 2);
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!))}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(trimmed)) {
      flush();
      out.push('<hr>');
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed)) {
      flush();
      const ordered = /^\d/.test(trimmed);
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const l = lines[i]!.trim();
        const m = ordered ? /^\d+[.)]\s+(.*)$/.exec(l) : /^[-*]\s+(.*)$/.exec(l);
        if (!m) break;
        items.push(`<li>${inline(escapeHtml(m[1]!))}</li>`);
      }
      i--;
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
      continue;
    }
    if (trimmed.startsWith('>')) {
      flush();
      const quote: string[] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith('>'); i++)
        quote.push(lines[i]!.trim().replace(/^>\s?/, ''));
      i--;
      out.push(`<blockquote><p>${inline(escapeHtml(quote.join(' ')))}</p></blockquote>`);
      continue;
    }
    if (trimmed.startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? '')) {
      flush();
      const head = tableRow(trimmed);
      const align = tableRow(lines[i + 1]!).map((c) =>
        c.endsWith(':') ? (c.startsWith(':') ? 'center' : 'right') : 'left',
      );
      const body: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) body.push(tableRow(lines[i]!));
      i--;
      const cell = (tag: string, c: string, j: number) =>
        `<${tag} style="text-align:${align[j] ?? 'left'}">${inline(escapeHtml(c))}</${tag}>`;
      out.push(
        `<div class="md-table"><table><thead><tr>${head.map((c, j) => cell('th', c, j)).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${head.map((_h, j) => cell('td', r[j] ?? '', j)).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    para.push(trimmed);
  }
  flush();
  return out.join('\n');
}
