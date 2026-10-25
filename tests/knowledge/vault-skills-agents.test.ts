import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { loadAgents, parseAgentDefinition } from '../../src/agents/definition';
import { bestSnippet, Bm25Index, tokenize } from '../../src/knowledge/bm25';
import { extractLinks, KnowledgeVault, stripCode, TOPIC_DESCRIPTIONS } from '../../src/knowledge/vault';
import { SkillRegistry } from '../../src/skills/registry';
import { tmpDir, writeFiles } from '../helpers';

const article = (
  title: string,
  body: string,
  meta = '> Sources: Test\n> Raw: none yet (seed article)\n> Updated: 2026-10-24',
) =>
  `---\ntags: [scraping, http]\naliases: [${title.toLowerCase()}]\n---\n\n# ${title}\n\n${meta}\n\n## Overview\n\n${body}\n\n## See Also\n\n- [Other](other.md)\n`;

describe('BM25', () => {
  test('tokenize lowercases, drops stopwords and stems plurals', () => {
    expect(tokenize('The Selectors and the CSS selector!')).toEqual(['selector', 'css', 'selector']);
  });
  test('ranks documents by term relevance with field weights', () => {
    const idx = new Bm25Index([
      { id: 'a', fields: [{ text: 'robots.txt parsing rules', weight: 4 }] },
      { id: 'b', fields: [{ text: 'cookies and sessions; robots mentioned once', weight: 1 }] },
      { id: 'c', fields: [{ text: 'nothing relevant', weight: 1 }] },
    ]);
    const hits = idx.search('robots rules');
    expect(hits.map((h) => h.id)).toEqual(['a', 'b']);
    expect(idx.search('the and')).toEqual([]);
    expect(idx.size).toBe(3);
  });
  test('bestSnippet picks the densest line', () => {
    expect(
      bestSnippet('# Title\n> meta\nintro line\nthe crawl delay setting matters\nend', 'crawl delay'),
    ).toBe('the crawl delay setting matters');
  });
});

describe('KnowledgeVault', () => {
  let dir: string;
  let vault: KnowledgeVault;
  beforeEach(async () => {
    dir = await tmpDir();
    vault = new KnowledgeVault(dir);
    await writeFiles(dir, {
      'wiki/http/cookies.md': article(
        'Cookies and Sessions',
        'Cookies keep **session** state. See [robots](../crawling/robots.md) and [missing](nope.md).',
      ),
      'wiki/http/other.md': article(
        'Other',
        'Links back to [cookies](cookies.md). Writing `[[wikilinks]]` in code is fine.',
      ),
      'wiki/crawling/robots.md': article(
        'Robots',
        'The robots.txt file controls crawling \u2014 and [[wikilinks]] are wrong here.',
        '> Sources: RFC 9309',
      ),
      'wiki/index.md':
        '# Knowledge Base Index\n\n## http\n\n| Article | Summary | Updated |\n|---|---|---|\n| [Cookies](http/cookies.md) | x | 2026-10-24 |\n| [Gone](http/gone.md) | x | 2026-10-24 |\n',
      'wiki/log.md': '# Wiki Log\n',
      'raw/.gitkeep': '',
    });
  });

  test('parses titles, metadata, tags and links', async () => {
    const arts = await vault.articles();
    const c = arts.find((a) => a.slug === 'cookies')!;
    expect(c).toMatchObject({
      path: 'wiki/http/cookies.md',
      topic: 'http',
      title: 'Cookies and Sessions',
      tags: ['scraping', 'http'],
      seed: true,
    });
    expect(c.meta).toMatchObject({ Sources: 'Test', Updated: '2026-10-24' });
    expect(c.links).toEqual(['../crawling/robots.md', 'nope.md', 'other.md']);
    expect(extractLinks('[a](https://x.y) [b](#anchor) [c](c.md#sec) `[d](d.md)`')).toEqual(['c.md']);
  });

  test('searches with an optional topic filter and returns mount paths', async () => {
    const hits = await vault.search('session cookies');
    expect(hits[0]).toMatchObject({ path: 'knowledge/wiki/http/cookies.md', title: 'Cookies and Sessions' });
    expect(await vault.search('robots', { topic: 'http' })).not.toContainEqual(
      expect.objectContaining({ title: 'Robots' }),
    );
    expect((await vault.search('robots', { topic: 'crawling' }))[0]!.title).toBe('Robots');
  });

  test('lint reports broken links, missing metadata, em dashes, wikilinks, orphans and index drift', async () => {
    const issues = await vault.lint();
    const msgs = issues.map((i) => `${i.severity}:${i.file}:${i.message}`);
    expect(msgs).toContainEqual('error:wiki/http/cookies.md:broken link: nope.md');
    expect(msgs).toContainEqual('error:wiki/crawling/robots.md:missing "> Raw:" metadata line');
    expect(msgs).toContainEqual('error:wiki/crawling/robots.md:contains an em dash (U+2014)');
    expect(msgs).toContainEqual(
      'error:wiki/crawling/robots.md:uses [[wikilinks]]; use relative Markdown links',
    );
    expect(msgs).toContainEqual('error:wiki/index.md:article not in index: wiki/http/other.md');
    expect(msgs).toContainEqual(
      'error:wiki/index.md:index entry points to a missing article: wiki/http/gone.md',
    );
    expect(msgs.some((m) => m.includes('orphan'))).toBe(false);
    expect(msgs.some((m) => m.startsWith('error:wiki/http/other.md'))).toBe(false);
    expect(stripCode('a `[[x]]` b\n```\n[[y]]\n```\nc')).toBe('a  b\n\nc');
    expect(await vault.lint({ checkIndex: false })).not.toContainEqual(
      expect.objectContaining({ file: 'wiki/index.md' }),
    );
  });

  test('builds an index grouped by topic with first-sentence summaries', async () => {
    const index = await vault.buildIndex({ 'http/other.md': 'Custom summary.' });
    expect(index).toMatch(/^# Knowledge Base Index/);
    expect(index).toContain('## http');
    expect(index).toContain(
      '| [Cookies and Sessions](http/cookies.md) | Cookies keep session state. | 2026-10-24 |',
    );
    expect(index).toContain('| [Other](http/other.md) | Custom summary. | 2026-10-24 |');
    expect(index.indexOf('## http')).toBeLessThan(index.indexOf('## crawling'));
    await vault.writeIndex();
    expect(await fsp.readFile(path.join(dir, 'wiki/index.md'), 'utf8')).toContain('crawling/robots.md');
  });

  test('upserts index rows and appends log entries', async () => {
    await vault.upsertIndexRow('lessons', 'lessons/a.md', 'Lesson: A', 'Do a | b.', '2026-10-24');
    await vault.upsertIndexRow('http', 'http/other.md', 'Other', 'Updated summary', '2026-10-25');
    await vault.upsertIndexRow('lessons', 'lessons/b.md', 'Lesson: B', 'Do b.', '2026-10-24');
    const idx = await fsp.readFile(path.join(dir, 'wiki/index.md'), 'utf8');
    expect(idx).toContain('## lessons');
    expect(idx).toContain('| [Lesson: A](lessons/a.md) | Do a / b. | 2026-10-24 |');
    expect(idx).toContain('| [Other](http/other.md) | Updated summary | 2026-10-25 |');
    expect(idx.indexOf('lessons/a.md')).toBeLessThan(idx.indexOf('lessons/b.md'));
    await vault.appendLog('ingest | Cookies', ['Disposition: New'], '2026-10-24');
    expect(await fsp.readFile(path.join(dir, 'wiki/log.md'), 'utf8')).toBe(
      '# Wiki Log\n\n## [2026-10-24] ingest | Cookies\n- Disposition: New\n',
    );
  });

  test('writes lessons and reinforces an existing lesson instead of duplicating it', async () => {
    const first = await vault.writeLesson({
      title: 'Use cursor pagination on the X API',
      context: 'X API',
      lesson: 'Follow next_cursor \u2014 not page numbers.',
      evidence: 'step 4 returned next_cursor',
      runId: 'run_a',
      date: '2026-10-24',
      tags: ['APIs'],
    });
    expect(first).toEqual({ path: 'wiki/lessons/use-cursor-pagination-on-the-x-api.md', created: true });
    const text = await fsp.readFile(path.join(dir, first.path), 'utf8');
    expect(text).toContain('# Lesson: Use cursor pagination on the X API');
    expect(text).toContain('> Raw: none yet (harness lesson)');
    expect(text).not.toContain('\u2014');
    const again = await vault.writeLesson({
      title: 'Use cursor pagination on the X API',
      context: '',
      lesson: '',
      evidence: 'seen again',
      runId: 'run_b',
      date: '2026-10-25',
    });
    expect(again.created).toBe(false);
    const updated = await fsp.readFile(path.join(dir, first.path), 'utf8');
    expect(updated).toContain('Confirmed again by run run_b (2026-10-25): seen again');
    expect(updated).toContain('> Updated: 2026-10-25');
  });
});

describe('the repository vault', () => {
  const vault = new KnowledgeVault(path.resolve(__dirname, '../../knowledge'));

  test('lints without errors and covers every topic', async () => {
    const issues = await vault.lint();
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    const articles = await vault.articles();
    expect(articles.length).toBeGreaterThanOrEqual(130);
    for (const topic of Object.keys(TOPIC_DESCRIPTIONS).filter((t) => t !== 'lessons'))
      expect(articles.filter((a) => a.topic === topic).length).toBeGreaterThanOrEqual(3);
  });

  test('search finds core articles', async () => {
    expect((await vault.search('robots.txt longest match allow disallow'))[0]!.path).toBe(
      'knowledge/wiki/crawling/robots-txt.md',
    );
    expect((await vault.search('declarative scraper spec yaml', { topic: 'harness' }))[0]!.path).toBe(
      'knowledge/wiki/harness/harness-scraper-spec.md',
    );
  });
});

describe('SkillRegistry', () => {
  test('loads SKILL.md folders, skips proposals and reports invalid or duplicate skills', async () => {
    const dir = await tmpDir();
    await writeFiles(dir, {
      'a/SKILL.md': '---\nname: alpha\ndescription: Does alpha things.\nextra: kept\n---\n\nAlpha body',
      'a/references/guide.md': 'ref',
      'b/SKILL.md': '---\nname: Bad Name\ndescription: x\n---\nbody',
      'c/SKILL.md': '---\nname: alpha\ndescription: duplicate\n---\nbody',
      'proposed/draft/SKILL.md': '---\nname: draft\ndescription: not yet\n---\nbody',
      'learned/beta/SKILL.md': '---\nname: beta\ndescription: Learned beta.\n---\nBeta',
      'd/SKILL.md': '---\nname: [broken\n---\n',
    });
    const reg = await SkillRegistry.load(dir);
    expect(reg.list().map((s) => s.name)).toEqual(['alpha', 'beta']);
    expect(reg.get('alpha')).toMatchObject({
      body: '\nAlpha body',
      files: ['skills/a/references/guide.md'],
      frontmatter: { extra: 'kept' },
      learned: false,
    });
    expect(reg.get('beta')!.learned).toBe(true);
    expect(reg.get('draft')).toBeUndefined();
    expect(reg.issues.map((i) => i.file).sort()).toEqual(['b/SKILL.md', 'c/SKILL.md', 'd/SKILL.md']);
    expect(reg.indexBlock()).toContain('- alpha: Does alpha things.');
    expect(reg.indexBlock(['beta'])).not.toContain('alpha');
    expect(reg.indexBlock(['none'])).toBe('');
    expect(reg.all()).toHaveLength(2);
  });

  test('extra roots add learned skills from a separate writable folder', async () => {
    const image = await tmpDir();
    const learned = await tmpDir();
    await writeFiles(image, { 'a/SKILL.md': '---\nname: alpha\ndescription: Built in.\n---\nA' });
    await writeFiles(learned, {
      'learned/gamma/SKILL.md': '---\nname: gamma\ndescription: Learned gamma.\n---\nG',
      'learned/gamma/notes.md': 'n',
      'proposed/draft/SKILL.md': '---\nname: draft\ndescription: pending\n---\nD',
      'dup/SKILL.md': '---\nname: alpha\ndescription: shadow attempt\n---\nX',
    });
    const reg = await SkillRegistry.load(image, 'skills', undefined, [
      { dir: learned, alias: 'learned-skills' },
    ]);
    expect(reg.list().map((s) => s.name)).toEqual(['alpha', 'gamma']);
    expect(reg.get('gamma')).toMatchObject({
      learned: true,
      files: ['learned-skills/learned/gamma/notes.md'],
    });
    // Built-in skills win over same-named files in the writable folder.
    expect(reg.get('alpha')!.description).toBe('Built in.');
    expect(reg.issues.map((i) => i.file)).toEqual(['learned-skills/dup/SKILL.md']);
  });

  test('the repository skills library loads cleanly, including the vendored LLM Wiki skills', async () => {
    const reg = await SkillRegistry.load(path.resolve(__dirname, '../../skills'));
    expect(reg.issues).toEqual([]);
    const names = reg.list().map((s) => s.name);
    for (const n of [
      'karpathy-llm-wiki',
      'karpathy-llm-wiki-prompts',
      'karpathy-system-prompt-learning',
      'build-scraper',
      'repair-scraper',
      'sql-analysis',
      'data-quality-checks',
      'discord-report',
      'responsible-scraping',
      'build-dashboard',
    ]) {
      expect(names).toContain(n);
    }
    expect(reg.get('build-dashboard')!.files).toEqual(
      expect.arrayContaining([
        'skills/harness/build-dashboard/reference.md',
        'skills/harness/build-dashboard/examples/release-tracker.yaml',
      ]),
    );
    expect(reg.get('karpathy-llm-wiki')!.files).toEqual(
      expect.arrayContaining([
        'skills/karpathy-llm-wiki/scripts/check_evidence.py',
        'skills/karpathy-llm-wiki/references/article-template.md',
      ]),
    );
  });
});

describe('agent definitions', () => {
  test('parse with defaults and validation', () => {
    const a = parseAgentDefinition(
      '---\nname: x\ndescription: y\ntools: [read_file]\nmax_steps: 5\n---\nBe careful.',
    );
    expect(a).toMatchObject({
      name: 'x',
      tools: ['read_file'],
      maxSteps: 5,
      knowledge: 'ro',
      skills: 'ro',
      scrapers: 'ro',
      systemPrompt: 'Be careful.',
    });
    expect(() => parseAgentDefinition('---\nname: Bad\ndescription: y\n---\n')).toThrow(
      /Invalid agent definition/,
    );
    expect(() => parseAgentDefinition('---\nname: [x\n---\n')).toThrow(/Invalid YAML/);
  });

  test('the repository agents load', async () => {
    const agents = await loadAgents(path.resolve(__dirname, '../../agents'));
    expect([...agents.keys()].sort()).toEqual([
      'analyst',
      'dashboard-builder',
      'librarian',
      'reporter',
      'scraper-engineer',
      'verifier',
    ]);
    expect(agents.get('librarian')).toMatchObject({ knowledge: 'rw', scrapers: 'none' });
    expect(await loadAgents('/nonexistent')).toEqual(new Map());
  });

  test('duplicate agent names are rejected', async () => {
    const dir = await tmpDir();
    await writeFiles(dir, {
      'a.md': '---\nname: x\ndescription: y\n---\n',
      'b.md': '---\nname: x\ndescription: z\n---\n',
    });
    await expect(loadAgents(dir)).rejects.toThrow(/Duplicate agent/);
  });
});
