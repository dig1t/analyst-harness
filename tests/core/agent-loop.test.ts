import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { FALLBACK_AGENT, type AgentDefinition } from '../../src/agents/definition';
import { buildSystemPrompt, runAgent, type AgentEvent, type AgentRunConfig } from '../../src/core/agent-loop';
import { BASELINE_PROFILE, parseProfileId, type HarnessProfile } from '../../src/core/profiles';
import type { Message } from '../../src/core/types';
import { PriceBook } from '../../src/llm/pricing';
import { ProviderError, type CompletionRequest } from '../../src/llm/provider';
import { ScriptedProvider, type ScriptedTurn } from '../../src/llm/scripted';
import { PermissionManager } from '../../src/safety/permissions';
import { bashTool } from '../../src/tools/bash-tool';
import { fileTools } from '../../src/tools/fs-tools';
import { harnessTools } from '../../src/tools/harness-tools';
import { ToolRegistry } from '../../src/tools/registry';
import { DEFAULT_TOOL_RUNTIME, defineTool, type ToolDefinition } from '../../src/tools/types';
import { webFetchTool } from '../../src/tools/web-fetch';
import { silentLogger } from '../../src/util/logger';
import { makeWorkspace, writeFiles } from '../helpers';

const registry = () =>
  new ToolRegistry([...fileTools, bashTool, webFetchTool, ...harnessTools] as Array<ToolDefinition<never>>);

async function setup(
  script: ScriptedTurn[] | ((req: CompletionRequest, i: number) => ScriptedTurn),
  opts: Partial<AgentRunConfig> & {
    profile?: HarnessProfile;
    caps?: { bindsThinkingToPrefix?: boolean };
  } = {},
) {
  const { root, workspace } = await makeWorkspace();
  await writeFiles(root, { 'data/sales.csv': 'region,amount\nnorth,10\nsouth,20\n' });
  const provider = new ScriptedProvider(script, opts.caps ?? {});
  const events: AgentEvent[] = [];
  const cfg: AgentRunConfig = {
    runId: 'run_t',
    task: 'Total the sales by region.',
    agent: FALLBACK_AGENT,
    profile: BASELINE_PROFILE,
    model: 'claude-opus-5-5',
    effort: 'medium',
    provider,
    registry: registry(),
    workspace,
    permissions: new PermissionManager(),
    services: {},
    toolRuntime: { ...DEFAULT_TOOL_RUNTIME, postEditDiagnostics: false },
    priceBook: new PriceBook(),
    logger: silentLogger,
    env: { PATH: process.env.PATH },
    onEvent: (e) => void events.push(e),
    retrySleep: async () => undefined,
    ...opts,
  };
  return { cfg, provider, events, root };
}

const lastUserText = (req: CompletionRequest) => {
  const last = req.messages[req.messages.length - 1]!;
  return last.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n');
};

describe('runAgent (ReAct loop)', () => {
  test('completes with a final text answer and reports usage and cost', async () => {
    const { cfg, events } = await setup([
      { text: 'North 10, south 20.', usage: { inputTokens: 1000, outputTokens: 100 } },
    ]);
    const res = await runAgent(cfg);
    expect(res).toMatchObject({
      outcome: 'completed',
      finalText: 'North 10, south 20.',
      steps: 1,
      toolCalls: 0,
    });
    expect(res.costUsd).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6);
    expect(events.map((e) => e.type)).toEqual(['run_start', 'llm_response', 'run_end']);
  });

  test('executes tool calls, pairs results with calls and continues', async () => {
    const { cfg, provider } = await setup([
      {
        text: 'Reading the file.',
        toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'data/sales.csv' } }],
      },
      {
        toolCalls: [
          {
            id: 'c2',
            name: 'write_file',
            input: { path: 'reports/total.md', content: 'north 10, south 20\n' },
          },
        ],
      },
      { text: 'Done: north 10, south 20.' },
    ]);
    const res = await runAgent(cfg);
    expect(res.outcome).toBe('completed');
    expect(res.toolCalls).toBe(2);
    expect(res.changedFiles).toContain('reports/total.md');
    const second = provider.requests[1]!;
    const results = second.messages[second.messages.length - 1]!.content.filter(
      (b) => b.type === 'tool_result',
    );
    expect(results).toEqual([
      expect.objectContaining({
        type: 'tool_result',
        toolCallId: 'c1',
        eventId: 1,
        content: expect.stringContaining('north,10'),
      }),
    ]);
    expect(await fsp.readFile(path.join(cfg.workspace.root, 'reports/total.md'), 'utf8')).toContain(
      'north 10',
    );
  });

  test('the system prompt carries the base prompt, tool rules, planning protocol and extras', async () => {
    const { cfg, provider } = await setup([{ text: 'ok' }], { systemExtras: ['# Extra block'] });
    await runAgent(cfg);
    const sys = provider.requests[0]!.system;
    expect(sys).toMatch(/^You are a data analyst agent/);
    expect(sys).toContain('# Tool Usage Rules');
    expect(sys).toContain('# Task planning');
    expect(sys).toContain('# Extra block');
    expect(sys).toContain('# Role: analyst');
    expect(provider.requests[0]!.tools.map((t) => t.name)).toContain('update_plan');
    expect(provider.requests[0]!.effort).toBe('medium');
  });

  test('planning reminders are ephemeral for ordinary providers (paper behaviour)', async () => {
    const { cfg, provider } = await setup([
      {
        toolCalls: [
          {
            name: 'update_plan',
            input: { plan: [{ content: 'Read data', status: 'in_progress', activeForm: 'Reading data' }] },
          },
        ],
      },
      { toolCalls: [{ name: 'list_files', input: {} }] },
      { text: 'done' },
    ]);
    const events: AgentEvent[] = [];
    cfg.onEvent = (e) => void events.push(e);
    await runAgent(cfg);
    expect(lastUserText(provider.requests[0]!)).toContain('You have not created a plan yet');
    expect(lastUserText(provider.requests[1]!)).toContain('[>] Read data');
    // Not stored: the second request's first user message no longer carries the first reminder.
    expect(JSON.stringify(provider.requests[2]!.messages.slice(0, -1))).not.toContain('system-reminder');
    expect(events.find((e) => e.type === 'plan')).toMatchObject({ done: 0, total: 1 });
  });

  test('planning reminders are appended and kept for preserved-thinking providers', async () => {
    const { cfg, provider } = await setup(
      [
        { toolCalls: [{ name: 'list_files', input: {} }] },
        { toolCalls: [{ name: 'list_files', input: { path: 'data' } }] },
        { text: 'done' },
      ],
      { caps: { bindsThinkingToPrefix: true } },
    );
    await runAgent(cfg);
    const third = JSON.stringify(provider.requests[2]!.messages);
    expect(third.match(/You have not created a plan yet/g)?.length).toBe(3);
    // Append-only: every request's messages are a prefix of the next request's messages.
    for (let i = 1; i < provider.requests.length; i++) {
      const prev = provider.requests[i - 1]!.messages;
      expect(provider.requests[i]!.messages.slice(0, prev.length)).toEqual(prev);
    }
  });

  test('planning off removes the tool and the protocol', async () => {
    const { cfg, provider } = await setup([{ text: 'ok' }], {
      profile: parseProfileId('t4-noplan-tools-128k'),
    });
    await runAgent(cfg);
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain('update_plan');
    expect(provider.requests[0]!.system).not.toContain('# Task planning');
    expect(lastUserText(provider.requests[0]!)).not.toContain('system-reminder');
  });

  test('bash-only action space exposes bash plus auxiliary tools with the bash-only prompts', async () => {
    const { cfg, provider } = await setup([{ text: 'ok' }], { profile: parseProfileId('t4-plan-bash-128k') });
    await runAgent(cfg);
    const req = provider.requests[0]!;
    expect(req.tools.map((t) => t.name).sort()).toEqual([
      'bash',
      'delegate_task',
      'domain_status',
      'load_skill',
      'recall_event',
      'run_scraper',
      'search_knowledge',
      'update_plan',
    ]);
    expect(req.tools.find((t) => t.name === 'bash')!.description).toMatch(/ONLY tool/);
    expect(req.system).toContain('# Working with only a shell');
  });

  test('tiers without recall do not expose recall_event', async () => {
    const { cfg, provider } = await setup([{ text: 'ok' }], {
      profile: parseProfileId('t1-plan-tools-128k'),
    });
    await runAgent(cfg);
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain('recall_event');
  });

  test('unknown tools become observations and the loop continues', async () => {
    const { cfg, provider } = await setup([
      { toolCalls: [{ name: 'str_replace_editor', input: {} }] },
      { text: 'recovered' },
    ]);
    const res = await runAgent(cfg);
    expect(res.outcome).toBe('completed');
    expect(res.toolErrors).toBe(1);
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain('Unknown tool');
  });

  test('stuck detection injects a reminder and then terminates a failing streak', async () => {
    const { cfg, provider, events } = await setup(() => ({
      toolCalls: [{ name: 'read_file', input: { path: 'missing.csv' } }],
    }));
    const res = await runAgent(cfg);
    expect(res.outcome).toBe('stuck');
    expect(res.steps).toBe(8);
    expect(res.stuckReminders).toBe(1);
    expect(JSON.stringify(provider.requests[5]!.messages.at(-1))).toContain('keeps failing the same way');
    expect(events.filter((e) => e.type === 'stuck').map((e) => (e.type === 'stuck' ? e.kind : ''))).toEqual([
      'failing_reminder',
      'terminate',
    ]);
  });

  test('tool calls cut off at max_tokens are not executed', async () => {
    const { cfg, provider, root } = await setup([
      {
        toolCalls: [{ name: 'write_file', input: { path: 'half.txt', content: 'partial' } }],
        stopReason: 'max_tokens',
      },
      { text: 'ok' },
    ]);
    await runAgent(cfg);
    await expect(fsp.access(path.join(root, 'half.txt'))).rejects.toThrow();
    expect(JSON.stringify(provider.requests[1]!.messages.at(-1))).toContain(
      'cut off at the output token limit',
    );
  });

  test('a truncated final answer is continued', async () => {
    const { cfg, provider } = await setup([
      { text: 'Part one', stopReason: 'max_tokens' },
      { text: 'Part two' },
    ]);
    const res = await runAgent(cfg);
    expect(res.finalText).toBe('Part two');
    expect(lastUserText(provider.requests[1]!)).toContain('Continue exactly where you stopped');
  });

  test('refusals, context exhaustion, budgets and aborts end the run cleanly', async () => {
    expect((await runAgent((await setup([{ text: '', stopReason: 'refusal' }])).cfg)).outcome).toBe(
      'refusal',
    );
    expect((await runAgent((await setup([{ text: '', stopReason: 'context_exceeded' }])).cfg)).outcome).toBe(
      'context_overflow',
    );

    const budget = await setup(
      () => ({
        toolCalls: [{ name: 'list_files', input: { path: '.' } }],
        usage: { inputTokens: 1_000_000, outputTokens: 0 },
      }),
      { runBudgetUsd: 5 },
    );
    const b = await runAgent(budget.cfg);
    expect(b.outcome).toBe('budget_exceeded');
    expect(b.error).toMatch(/run budget/);

    const daily = await setup([{ text: 'never' }], {
      budget: { exceeded: () => 'daily cap reached', record: () => undefined },
    });
    expect(await runAgent(daily.cfg)).toMatchObject({
      outcome: 'budget_exceeded',
      error: 'daily cap reached',
      steps: 1,
    });

    const controller = new AbortController();
    controller.abort();
    expect((await runAgent((await setup([{ text: 'x' }], { signal: controller.signal })).cfg)).outcome).toBe(
      'aborted',
    );
  });

  test('T0 terminates on context overflow; managed tiers keep going', async () => {
    const big = 'x'.repeat(20_000);
    const tools = [
      defineTool({
        name: 'dump',
        description: 'd',
        category: 'workspace',
        readOnly: true,
        schema: z.object({ n: z.number() }),
        execute: async () => ({ content: big }),
      }),
    ];
    const reg = new ToolRegistry(tools as Array<ToolDefinition<never>>);
    const script = (_r: CompletionRequest, i: number): ScriptedTurn =>
      i < 6 ? { toolCalls: [{ name: 'dump', input: { n: i } }] } : { text: 'finished' };
    const t0 = await setup(script, { registry: reg, profile: { ...parseProfileId('t0-noplan-tools-16k') } });
    expect((await runAgent(t0.cfg)).outcome).toBe('context_overflow');
    const t1 = await setup(script, { registry: reg, profile: { ...parseProfileId('t1-noplan-tools-16k') } });
    const r1 = await runAgent(t1.cfg);
    expect(r1.outcome).toBe('completed');
    expect(r1.contextEvents).toBeGreaterThan(0);
  });

  test('T3 summarization calls the provider with the summarizer prompt and counts its cost', async () => {
    const big = 'y'.repeat(16_000);
    const reg = new ToolRegistry([
      defineTool({
        name: 'dump',
        description: 'd',
        category: 'workspace',
        readOnly: true,
        schema: z.object({ n: z.number() }),
        execute: async () => ({ content: big }),
      }),
    ] as Array<ToolDefinition<never>>);
    const script = (req: CompletionRequest, i: number): ScriptedTurn => {
      if (req.purpose === 'summarize')
        return { text: '## Goal\nTotal sales', usage: { inputTokens: 100, outputTokens: 10 } };
      return i < 8 ? { toolCalls: [{ name: 'dump', input: { n: i } }] } : { text: 'finished' };
    };
    const { cfg, provider } = await setup(script, {
      registry: reg,
      profile: parseProfileId('t3-noplan-tools-24k'),
    });
    const res = await runAgent(cfg);
    expect(res.outcome).toBe('completed');
    expect(res.summaryCalls).toBeGreaterThan(0);
    const summarize = provider.requests.find((r) => r.purpose === 'summarize')!;
    expect(summarize.system).toMatch(/compacting a data analyst agent's conversation/);
    expect(summarize.tools).toEqual([]);
    const after = provider.requests[provider.requests.length - 1]!;
    expect(JSON.stringify(after.messages)).toContain('<context-summary>');
  });

  test('retryable provider errors are retried; fatal ones end the run', async () => {
    let calls = 0;
    const flaky = await setup([{ text: 'ok' }]);
    const inner = flaky.cfg.provider;
    flaky.cfg.provider = {
      name: 'flaky',
      capabilities: () => inner.capabilities('m'),
      complete: async (req) => {
        if (calls++ < 2) throw new ProviderError('overloaded', true, 529, 'overloaded');
        return inner.complete(req);
      },
    };
    expect((await runAgent(flaky.cfg)).outcome).toBe('completed');
    expect(calls).toBe(3);

    const fatal = await setup([{ text: 'x' }]);
    fatal.cfg.provider = {
      name: 'f',
      capabilities: () => ({ bindsThinkingToPrefix: false, contextWindow: 1e6 }),
      complete: async () => Promise.reject(new ProviderError('bad key', false, 401, 'auth')),
    };
    expect(await runAgent(fatal.cfg)).toMatchObject({ outcome: 'provider_error', error: 'bad key' });
  });

  test('a thinking-binding rejection strips thinking once and retries', async () => {
    let calls = 0;
    const seen: Message[][] = [];
    const s = await setup([{ text: 'ok' }]);
    s.cfg.provider = {
      name: 'binding',
      capabilities: () => ({ bindsThinkingToPrefix: true, contextWindow: 1e6 }),
      complete: async (req) => {
        seen.push(structuredClone(req.messages));
        calls++;
        if (calls === 1) {
          return {
            message: {
              role: 'assistant',
              content: [
                { type: 'opaque', provider: 'anthropic', kind: 'thinking', data: { type: 'thinking' } },
                { type: 'tool_call', id: 't1', name: 'list_files', input: {} },
              ],
            },
            stopReason: 'tool_use',
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            model: 'm',
          };
        }
        if (calls === 2)
          throw new ProviderError('Invalid `signature` in `thinking` block', false, 400, 'thinking_binding');
        return {
          message: { role: 'assistant', content: [{ type: 'text', text: 'final' }] },
          stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          model: 'm',
        };
      },
    };
    const res = await runAgent(s.cfg);
    expect(res.outcome).toBe('completed');
    expect(JSON.stringify(seen[1])).toContain('opaque');
    expect(JSON.stringify(seen[2])).not.toContain('opaque');
  });

  test('progress notes from thinking blocks are surfaced in events', async () => {
    const { cfg, events } = await setup([
      {
        opaque: [
          {
            type: 'opaque',
            provider: 'anthropic',
            kind: 'thinking',
            data: { type: 'thinking', thinking: 'Checking the sales file next.' },
          },
        ],
        toolCalls: [{ name: 'list_files', input: {} }],
      },
      { text: 'done' },
    ]);
    await runAgent(cfg);
    const first = events.find((e) => e.type === 'llm_response');
    expect(first).toMatchObject({ progress: ['Checking the sales file next.'] });
  });

  test('event handler failures never break the run', async () => {
    const { cfg } = await setup([{ text: 'ok' }], {
      onEvent: () => Promise.reject(new Error('handler broke')),
    });
    expect((await runAgent(cfg)).outcome).toBe('completed');
  });

  test('agent tool allow-lists and max_steps are honored', async () => {
    const agent: AgentDefinition = { ...FALLBACK_AGENT, name: 'narrow', tools: ['read_file'], maxSteps: 2 };
    const { cfg, provider } = await setup(
      () => ({
        toolCalls: [
          { name: 'read_file', input: { path: 'data/sales.csv', offset: Math.floor(Math.random() * 2) + 1 } },
        ],
      }),
      { agent },
    );
    const res = await runAgent(cfg);
    expect(res.outcome).toBe('max_steps');
    expect(res.steps).toBe(2);
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(['read_file']);
  });

  test('buildSystemPrompt omits empty extras', () => {
    const sys = buildSystemPrompt({ ...FALLBACK_AGENT, systemPrompt: '' }, BASELINE_PROFILE, registry(), [
      '',
      '  ',
    ]);
    expect(sys).not.toContain('# Role');
  });
});
