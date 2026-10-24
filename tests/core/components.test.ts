import { PlanState } from '../../src/core/planning/plan';
import { BASELINE_PROFILE, parseProfileId, profileId, resolveProfile } from '../../src/core/profiles';
import {
  elisionStub,
  planReminder,
  stuckFailingReminder,
  stuckRepeatReminder,
  summaryWrapper,
} from '../../src/core/prompts';
import { StuckDetector } from '../../src/core/stuck-detector';
import { TokenEstimator } from '../../src/core/context/token-estimator';
import { ExternalStore } from '../../src/core/context/external-store';
import { addUsage, emptyUsage, promptTokens, textOf, toolCallsOf } from '../../src/core/types';
import { tmpDir } from '../helpers';
import path from 'node:path';

describe('PlanState (update_plan protocol)', () => {
  const item = (content: string, status: 'pending' | 'in_progress' | 'completed') => ({
    content,
    status,
    activeForm: content + 'ing',
  });

  test('accepts a plan with at most one in_progress task and renders it', () => {
    const plan = new PlanState();
    expect(plan.exists).toBe(false);
    expect(plan.render()).toBe('(no plan)');
    expect(
      plan.replace([item('Load', 'completed'), item('Query', 'in_progress'), item('Report', 'pending')]).ok,
    ).toBe(true);
    expect(plan.render()).toBe('1. [x] Load\n2. [>] Query\n3. [ ] Report');
    expect(plan.progress()).toEqual({ done: 1, total: 3 });
    expect(plan.updateCount).toBe(1);
  });

  test('rejects two in_progress tasks and empty plans without changing state', () => {
    const plan = new PlanState();
    plan.replace([item('A', 'in_progress')]);
    const bad = plan.replace([item('A', 'in_progress'), item('B', 'in_progress')]);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/Exactly ONE/);
    expect(plan.current).toHaveLength(1);
    expect(PlanState.validate([]).ok).toBe(false);
  });
});

describe('StuckDetector (Appendix A.4)', () => {
  const ok = { isError: false, content: 'same output' };
  const fail = { isError: true, content: 'Error: no such file' };

  test('one repeat reminder at the fifth identical call', () => {
    const d = new StuckDetector();
    const call = { name: 'read_file', input: { path: 'a' } };
    const signals = Array.from({ length: 7 }, () => d.observe(call, ok));
    expect(signals.slice(0, 4).every((s) => s === null)).toBe(true);
    expect(signals[4]).toMatchObject({ kind: 'repeat_reminder', count: 5 });
    expect(signals[5]).toBeNull();
    expect(signals[6]).toBeNull();
  });

  test('failing reminder at five identical failures, termination at eight', () => {
    const d = new StuckDetector();
    const call = { name: 'bash', input: { command: 'cat missing' } };
    const signals = Array.from({ length: 8 }, () => d.observe(call, fail));
    expect(signals[4]).toMatchObject({ kind: 'failing_reminder', tool: 'bash', count: 5 });
    expect(signals[7]).toMatchObject({ kind: 'terminate', count: 8 });
  });

  test('different arguments end the streak (paginated reads are fine)', () => {
    const d = new StuckDetector();
    for (let i = 0; i < 20; i++)
      expect(d.observe({ name: 'read_file', input: { path: 'a', offset: i * 100 + 1 } }, ok)).toBeNull();
  });

  test('argument key order does not matter for identity', () => {
    const d = new StuckDetector({ repeatThreshold: 2, failThreshold: 5, terminateThreshold: 8 });
    d.observe({ name: 'x', input: { a: 1, b: 2 } }, ok);
    expect(d.observe({ name: 'x', input: { b: 2, a: 1 } }, ok)).toMatchObject({ kind: 'repeat_reminder' });
  });

  test('a different error message restarts the failing count; successes reset it', () => {
    const d = new StuckDetector();
    const call = { name: 'bash', input: { command: 'make' } };
    for (let i = 0; i < 4; i++) d.observe(call, fail);
    d.observe(call, { isError: true, content: 'another error' });
    expect(d.state.failStreak).toBe(1);
    d.observe(call, ok);
    expect(d.state.failStreak).toBe(0);
    expect(d.state.streak).toBe(6);
  });

  test('permission denials never count as failures', () => {
    const d = new StuckDetector();
    const call = { name: 'bash', input: { command: 'sudo ls' } };
    const signals = Array.from({ length: 10 }, () =>
      d.observe(call, { isError: true, content: 'denied', permissionDenied: true }),
    );
    expect(signals.some((s) => s?.kind === 'terminate')).toBe(false);
    expect(signals[4]).toMatchObject({ kind: 'repeat_reminder' });
  });
});

describe('prompts', () => {
  test('stubs and wrappers follow Figure 19, without em dashes', () => {
    expect(elisionStub(10, 500, 41, true)).toBe(
      '[tool output elided: 10 lines / 500 chars. Use recall_event(41) for the full output, or re-read/re-run.]',
    );
    expect(elisionStub(10, 500, 41, false)).toBe(
      '[tool output elided: 10 lines / 500 chars. Re-read or re-run to get it again.]',
    );
    expect(summaryWrapper('S', 12, true)).toContain('recallable via recall_event up to event 12');
    expect(summaryWrapper('S', 12, false)).not.toContain('recall_event');
    for (const text of [
      planReminder('1. [ ] x'),
      stuckFailingReminder('bash', 5),
      stuckRepeatReminder('bash', 5),
      summaryWrapper('S', 1, true),
    ]) {
      expect(text).not.toContain('\u2014');
    }
  });
});

describe('profiles', () => {
  test('ids round-trip and encode the three ablated components', () => {
    const p = parseProfileId('t2-noplan-bash-64k');
    expect(p).toMatchObject({
      contextTier: 2,
      planning: false,
      actionSpace: 'bash',
      windowTokens: 64_000,
      softRatio: 0.6,
      hardRatio: 0.85,
    });
    expect(profileId(p)).toBe('t2-noplan-bash-64k');
    expect(profileId(BASELINE_PROFILE)).toBe(BASELINE_PROFILE.id);
    expect(() => parseProfileId('t9-plan-tools-1k')).toThrow(/Invalid profile id/);
  });

  test('resolveProfile merges overrides and objects', () => {
    expect(resolveProfile(undefined).id).toBe('t4-plan-tools-128k');
    expect(resolveProfile('t3-plan-tools-32k', { maxSteps: 5 })).toMatchObject({
      contextTier: 3,
      maxSteps: 5,
    });
    expect(resolveProfile({ contextTier: 1, planning: false }).id).toBe('t1-noplan-tools-128k');
  });
});

describe('TokenEstimator', () => {
  test('estimates by characters and calibrates toward observed usage', () => {
    const est = new TokenEstimator(0.25, 0.5);
    expect(est.estimateText('x'.repeat(400))).toBe(100);
    est.calibrate(1000, 500);
    expect(est.ratio).toBeCloseTo(0.375);
    est.calibrate(0, 10);
    est.calibrate(10, 0);
    expect(est.ratio).toBeCloseTo(0.375);
    est.calibrate(10, 1_000_000);
    expect(est.ratio).toBeLessThanOrEqual(1.5);
    const msg = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: 'abcd' },
        { type: 'tool_result' as const, toolCallId: 't', content: 'xy' },
        { type: 'opaque' as const, provider: 'p', kind: 'thinking', data: { s: 1 } },
        { type: 'tool_call' as const, id: 'c', name: 'n', input: { a: 1 } },
      ],
    };
    expect(TokenEstimator.messageChars(msg)).toBeGreaterThan(20);
    expect(
      TokenEstimator.fixedChars('sys', [{ name: 't', description: 'd', inputSchema: { type: 'object' } }]),
    ).toBeGreaterThan(5);
  });
});

describe('ExternalStore (M2)', () => {
  test('allocates ids, persists and reloads events, counts recalls', async () => {
    const file = path.join(await tmpDir(), 'store.jsonl');
    const store = new ExternalStore(file);
    const id = store.allocateId();
    await store.put({
      id,
      toolName: 'bash',
      toolCallId: 'c1',
      input: {},
      content: 'out',
      isError: false,
      step: 1,
    });
    expect(store.recall(id)?.content).toBe('out');
    expect(store.recall(99)).toBeUndefined();
    expect(store.recallCount).toBe(1);
    const loaded = await ExternalStore.load(file);
    expect(loaded.get(id)?.toolName).toBe('bash');
    expect(loaded.allocateId()).toBe(2);
    expect(loaded.size).toBe(1);
  });
});

describe('core type helpers', () => {
  test('usage arithmetic and message accessors', () => {
    const u = addUsage(emptyUsage(), {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
    });
    expect(promptTokens(u)).toBe(8);
    const m = {
      role: 'assistant' as const,
      content: [
        { type: 'text' as const, text: ' hi ' },
        { type: 'tool_call' as const, id: '1', name: 'x', input: {} },
      ],
    };
    expect(textOf(m)).toBe('hi');
    expect(toolCallsOf(m)).toHaveLength(1);
  });
});
