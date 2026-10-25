import { ExternalStore } from '../../src/core/context/external-store';
import {
  ContextManager,
  DEFAULT_CONTEXT_CONFIG,
  TIER_MECHANISMS,
  type ContextConfig,
  type ContextTier,
} from '../../src/core/context/manager';
import { TokenEstimator } from '../../src/core/context/token-estimator';
import type { Message } from '../../src/core/types';

/** History: preamble + N turns, each with one bulky tool result and a reminder block. */
function history(turns: number, resultChars = 4_000, withThinking = false): Message[] {
  const h: Message[] = [
    { role: 'user', kind: 'preamble', content: [{ type: 'text', text: 'Analyze the dataset.' }] },
  ];
  for (let i = 1; i <= turns; i++) {
    h.push({
      role: 'assistant',
      kind: 'turn',
      content: [
        ...(withThinking
          ? [
              {
                type: 'opaque' as const,
                provider: 'anthropic',
                kind: 'thinking',
                data: { type: 'thinking', thinking: '', signature: 'sig' + i },
              },
            ]
          : []),
        { type: 'tool_call', id: `c${i}`, name: 'read_file', input: { path: `f${i}` } },
      ],
    });
    h.push({
      role: 'user',
      kind: 'turn',
      content: [
        { type: 'tool_result', toolCallId: `c${i}`, content: `line\n`.repeat(resultChars / 5), eventId: i },
        { type: 'text', text: '<system-reminder>plan</system-reminder>', origin: 'plan_reminder' },
      ],
    });
  }
  return h;
}

function manager(
  tier: ContextTier,
  windowTokens: number,
  overrides: Partial<ContextConfig> = {},
  summarizer = jest.fn(async () => 'SUMMARY'),
) {
  const store = new ExternalStore();
  for (let i = 0; i < 50; i++) store.allocateId();
  const cm = new ContextManager(
    { ...DEFAULT_CONTEXT_CONFIG, tier, windowTokens, ...overrides },
    new TokenEstimator(0.25, 0),
    store,
    summarizer,
  );
  cm.setFixed('system prompt', []);
  return { cm, summarizer };
}

const resultBodies = (h: Message[]) =>
  h.flatMap((m) =>
    m.content.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.content : '')),
  );

describe('ContextManager tiers (Table 2)', () => {
  test('mechanism table matches the paper', () => {
    expect(TIER_MECHANISMS[0]).toEqual({ elide: false, recall: false, summarize: false });
    expect(TIER_MECHANISMS[1]).toEqual({ elide: true, recall: false, summarize: false });
    expect(TIER_MECHANISMS[2]).toEqual({ elide: true, recall: true, summarize: false });
    expect(TIER_MECHANISMS[3]).toEqual({ elide: false, recall: false, summarize: true });
    expect(TIER_MECHANISMS[4]).toEqual({ elide: true, recall: true, summarize: true });
  });

  test('rejects soft >= hard thresholds', () => {
    expect(() => manager(4, 1000, { softRatio: 0.9, hardRatio: 0.8 })).toThrow();
  });

  test('T0 never edits and reports overflow once the window is exceeded', async () => {
    const { cm } = manager(0, 2_000);
    const h = history(4);
    const before = JSON.stringify(h);
    const res = await cm.prepare(h);
    expect(res.overflow).toBe(true);
    expect(res.edited).toBe(false);
    expect(JSON.stringify(h)).toBe(before);
    expect(res.events.map((e) => e.action)).toEqual(['overflow']);
  });

  test('nothing happens below the thresholds', async () => {
    const { cm, summarizer } = manager(4, 1_000_000);
    const h = history(3);
    const res = await cm.prepare(h);
    expect(res).toMatchObject({ overflow: false, edited: false, events: [] });
    expect(summarizer).not.toHaveBeenCalled();
  });

  test('T1 elides bulky middle observations at B2 with an unrecoverable stub', async () => {
    const { cm } = manager(1, 7_000);
    const h = history(6);
    const tokensBefore = cm.tokens(h);
    expect(tokensBefore).toBeGreaterThan(cm.hardLimit);
    const res = await cm.prepare(h);
    expect(res.events[0]).toMatchObject({ action: 'elide' });
    const bodies = resultBodies(h);
    expect(bodies.filter((b) => b.startsWith('[tool output elided'))).not.toHaveLength(0);
    expect(bodies.every((b) => !b.includes('recall_event'))).toBe(true);
    // The two most recent turns stay verbatim.
    expect(bodies.slice(-2).every((b) => b.startsWith('line'))).toBe(true);
  });

  test('T1 does not act between B1 and B2', async () => {
    const { cm } = manager(1, 7_000);
    const h = history(5);
    const t = cm.tokens(h);
    expect(t).toBeGreaterThan(cm.softLimit);
    expect(t).toBeLessThan(cm.hardLimit);
    expect((await cm.prepare(h)).edited).toBe(false);
  });

  test('T2 stubs point at recall_event with the event id', async () => {
    const { cm } = manager(2, 7_000);
    const h = history(6);
    await cm.prepare(h);
    const stub = resultBodies(h).find((b) => b.startsWith('[tool output elided'))!;
    expect(stub).toMatch(/Use recall_event\(\d+\) for the full output/);
  });

  test('T3 summarizes the oldest middle turns into a running summary after the preamble', async () => {
    const { cm, summarizer } = manager(3, 7_000);
    const h = history(6);
    const turnsBefore = cm.turns(h).length;
    const res = await cm.prepare(h);
    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(res.events.map((e) => e.action)).toContain('summarize');
    expect(h[1]!.kind).toBe('summary');
    expect(h[1]!.content[0]).toMatchObject({ type: 'text' });
    const text = h[1]!.content[0]!.type === 'text' ? h[1]!.content[0]!.text : '';
    expect(text).toMatch(/^<context-summary>\nSUMMARY/);
    expect(text).not.toContain('recall_event');
    expect(cm.turns(h).length).toBeLessThan(turnsBefore);
    expect(cm.stats.summaryCalls).toBe(1);
  });

  test('a second summarization updates the existing summary in place', async () => {
    const summarizer = jest.fn(async ({ previousSummary }: { previousSummary?: string }) =>
      previousSummary ? 'UPDATED' : 'FIRST',
    );
    const { cm } = manager(3, 7_000, {}, summarizer as never);
    const h = history(6);
    await cm.prepare(h);
    for (let i = 7; i <= 12; i++)
      h.push(
        ...history(1)
          .slice(1)
          .map((m) => ({ ...m })),
      );
    await cm.prepare(h);
    expect(summarizer).toHaveBeenCalledTimes(2);
    expect(summarizer.mock.calls[1]![0].previousSummary).toContain('FIRST');
    expect(h.filter((m) => m.kind === 'summary')).toHaveLength(1);
  });

  test('T4 elides at B1 (before summarizing) and keeps the summary recallable', async () => {
    const { cm, summarizer } = manager(4, 7_000);
    const h = history(5);
    expect(cm.tokens(h)).toBeGreaterThan(cm.softLimit);
    const res = await cm.prepare(h);
    expect(res.events[0]).toMatchObject({ action: 'elide' });
    expect(summarizer).not.toHaveBeenCalled();

    const big = manager(4, 7_000);
    const h2 = history(10);
    const res2 = await big.cm.prepare(h2);
    const actions = res2.events.map((e) => e.action);
    expect(actions[0]).toBe('elide');
    if (actions.includes('summarize')) {
      const s = h2.find((m) => m.kind === 'summary')!;
      expect(JSON.stringify(s)).toContain('recall_event');
    }
    expect(res2.overflow).toBe(false);
  });

  test('stale reminders are dropped only together with an elision pass', async () => {
    const { cm } = manager(4, 1_000_000, { bulkyMinChars: 10_000_000 });
    const h = history(6);
    // Force tokens over B1 with a tiny window but nothing bulky to elide.
    const tight = new ContextManager(
      { ...cm.config, windowTokens: 3_000, bulkyMinChars: 10_000_000 },
      new TokenEstimator(0.25, 0),
      new ExternalStore(),
    );
    const before = JSON.stringify(h);
    const res = await tight.prepare(h);
    expect(res.edited).toBe(false);
    expect(JSON.stringify(h)).toBe(before);
  });

  test('preserved-thinking providers get every thinking block stripped after an edit', async () => {
    const { cm } = manager(1, 7_000, { bindsThinking: true });
    const h = history(6, 4_000, true);
    const res = await cm.prepare(h);
    expect(res.events.map((e) => e.action)).toEqual(['elide', 'strip_thinking']);
    expect(h.some((m) => m.content.some((b) => b.type === 'opaque'))).toBe(false);
  });

  test('no edit means thinking blocks stay untouched', async () => {
    const { cm } = manager(4, 1_000_000, { bindsThinking: true });
    const h = history(3, 4_000, true);
    await cm.prepare(h);
    expect(h.filter((m) => m.content.some((b) => b.type === 'opaque'))).toHaveLength(3);
  });

  test('stripThinking keeps a non-empty placeholder when only thinking remained', () => {
    const { cm } = manager(4, 1000, { bindsThinking: true });
    const h: Message[] = [
      { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', kind: 'thinking', data: {} }] },
    ];
    expect(cm.stripThinking(h)).toBe(1);
    expect(h[0]!.content).toEqual([{ type: 'text', text: '(reasoning omitted)' }]);
  });

  test('recent window keeps at least two turns even when they exceed the ratio', () => {
    const { cm } = manager(4, 2_000);
    const h = history(5, 8_000);
    expect(cm.recentTurnCount(h)).toBe(2);
    expect(cm.middleTurns(h)).toHaveLength(3);
  });

  test('render adds an ephemeral reminder to the last user message without mutating history', () => {
    const { cm } = manager(4, 100_000);
    const h = history(1);
    const out = cm.render(h, 'REMINDER');
    expect(out[out.length - 1]!.content.at(-1)).toMatchObject({ type: 'text', text: 'REMINDER' });
    expect(h[h.length - 1]!.content.some((b) => b.type === 'text' && b.text === 'REMINDER')).toBe(false);
    expect(cm.render(h)).toEqual(h);
  });

  test('summarizer failures propagate to the caller', async () => {
    const { cm } = manager(
      3,
      7_000,
      {},
      jest.fn(async () => {
        throw new Error('summarizer down');
      }) as never,
    );
    await expect(cm.prepare(history(6))).rejects.toThrow('summarizer down');
  });
});
