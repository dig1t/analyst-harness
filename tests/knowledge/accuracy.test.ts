import {
  accuracyReport,
  checkVaultLinks,
  formatAccuracy,
  verificationTask,
} from '../../src/knowledge/accuracy';
import { extractUrls, KnowledgeVault } from '../../src/knowledge/vault';
import { tmpDir, writeFiles } from '../helpers';

const article = (title: string, meta: { sources: string; raw: string; updated: string }, body: string) =>
  `---\ntags: [scraping]\n---\n\n# ${title}\n\n> Sources: ${meta.sources}\n> Raw: ${meta.raw}\n> Updated: ${meta.updated}\n\n## Overview\n\n${body}\n\n## See Also\n`;

async function makeVault() {
  const dir = await tmpDir('harness-accuracy-');
  await writeFiles(dir, {
    'raw/http/2026-10-01-rfc-9110.md': 'https://www.rfc-editor.org/rfc/rfc9110\nfetched 2026-10-01\n',
    'wiki/http/grounded.md': article(
      'Grounded',
      {
        sources: 'RFC 9110 (https://www.rfc-editor.org/rfc/rfc9110)',
        raw: '[RFC 9110 capture](../../raw/http/2026-10-01-rfc-9110.md)',
        updated: '2026-10-01',
      },
      'Status codes. See [hub](hub.md).',
    ),
    'wiki/http/hub.md': article(
      'Hub',
      {
        sources: 'PyPI JSON API (https://pypi.org/pypi/requests/json)',
        raw: 'none yet (seed article)',
        updated: '2024-01-01',
      },
      'Links: [a](grounded.md), [b](no-urls.md). Example `https://ignored.example.org/in-code`.\nAlso https://docs.python.org/3/ and https://pypi.org/project/httpx/.',
    ),
    'wiki/http/no-urls.md': article(
      'No URLs',
      { sources: 'expert knowledge', raw: 'none yet (seed article)', updated: '2026-10-20' },
      'Nothing cited. See [hub](hub.md) and [grounded](grounded.md).',
    ),
    'wiki/http/blocked.md': article(
      'Blocked',
      {
        sources: 'MDN (https://developer.mozilla.org/en-US/docs/Web/HTTP)',
        raw: 'none yet (seed article)',
        updated: '2026-10-20',
      },
      'See [hub](hub.md).',
    ),
    'wiki/lessons/lesson-a.md': article(
      'Lesson: x',
      { sources: 'harness run run_1', raw: 'none yet (harness lesson)', updated: '2026-10-20' },
      'Do x. See [hub](../http/hub.md).',
    ),
  });
  return new KnowledgeVault(dir);
}

const answers = (host: string) =>
  ({ 'pypi.org': true, 'www.rfc-editor.org': true, 'developer.mozilla.org': false })[host];

describe('vault accuracy', () => {
  test('URLs come from prose and links, not from code', () => {
    expect(extractUrls('See https://a.org/x. and [b](https://b.org/y), not `https://c.org/z`.')).toEqual([
      'https://a.org/x',
      'https://b.org/y',
    ]);
  });

  test('the report ranks ungrounded, stale, central, verifiable articles first', async () => {
    const vault = await makeVault();
    const report = await accuracyReport(vault, { environment: 'server', answers, today: '2026-10-25' });
    expect(report.articles.map((a) => [a.path, a.priority])).toEqual([
      ['wiki/http/hub.md', 9],
      ['wiki/http/blocked.md', 2],
      ['wiki/http/no-urls.md', 1],
      ['wiki/http/grounded.md', 0],
    ]);
    const [hub, blocked, noUrls, grounded] = report.articles;
    expect(hub).toMatchObject({
      seed: true,
      grounded: false,
      stale: true,
      ageDays: 1028,
      inbound: 3,
      citedHosts: ['docs.python.org', 'pypi.org'],
      reachableHosts: ['pypi.org'],
      reasons: [
        'seed article (no captured source)',
        'not updated for 1028 days',
        '3 articles link here',
        '1 of 2 cited hosts answer here',
      ],
    });
    expect(hub!.citedUrls).not.toContain('https://ignored.example.org/in-code');
    expect(blocked!.reasons).toContain('no cited host answers here');
    expect(grounded).toMatchObject({
      grounded: true,
      rawFiles: ['raw/http/2026-10-01-rfc-9110.md'],
      stale: false,
      reasons: ['grounded and current'],
    });
    expect(noUrls!.reasons).toContain('cites no URL (find a source first)');
    expect(report.totals).toEqual({
      articles: 4,
      grounded: 1,
      seed: 3,
      stale: 1,
      citations: 5,
      hosts: 4,
      hostsReachable: 2,
      hostsUnreachable: 1,
      verifiableNow: 2,
    });
    const text = formatAccuracy(report, 2);
    expect(text).toContain('4 articles: 1 grounded in captured sources (25%), 3 seed, 1 stale');
    expect(text).toContain('5 citations to 4 hosts; from server: 2 answer, 1 do not, 1 unknown');
    expect(text).toContain('  1. [');
    expect(text).not.toContain('  3. [');

    const task = verificationTask(hub!, '2026-10-25');
    expect(task).toContain('knowledge/wiki/http/hub.md ("Hub")');
    expect(task).toContain('https://pypi.org/pypi/requests/json');
    expect(task).toContain('knowledge/raw/http/2026-10-25-<source-slug>.md');
    expect(task).toContain('set Updated to 2026-10-25');
  });

  test('the link checker attributes each URL to the articles that cite it', async () => {
    const vault = await makeVault();
    const probed: string[] = [];
    const result = await checkVaultLinks(vault, {
      skip: (url) => (url.includes('mozilla') ? 'listed as unreachable' : null),
      probe: async (url) => {
        probed.push(url);
        return url.includes('docs.python.org') ? 'http-404' : url.includes('httpx') ? 'http-403' : 'ok';
      },
      concurrency: 2,
    });
    expect(result.broken).toEqual([
      { url: 'https://docs.python.org/3/', status: 'http-404', articles: ['wiki/http/hub.md'] },
    ]);
    expect(result.unchecked.map((u) => u.url)).toEqual(['https://developer.mozilla.org/en-US/docs/Web/HTTP']);
    // 403 means the host answers (it refuses bots or wants a login), not a dead link.
    expect(result.ok).toBe(3);
    expect(probed).not.toContain('https://developer.mozilla.org/en-US/docs/Web/HTTP');
    expect(probed.sort()).toEqual([...new Set(probed)].sort());
  });
});
