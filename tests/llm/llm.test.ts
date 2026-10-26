import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import {
  AnthropicProvider,
  anthropicCapabilities,
  fromAnthropicContent,
  mapAnthropicError,
  toAnthropicMessages,
  type AnthropicClientLike,
} from '../../src/llm/anthropic';
import { PriceBook } from '../../src/llm/pricing';
import { completeText, extractJson, ProviderError } from '../../src/llm/provider';
import { ScriptedProvider } from '../../src/llm/scripted';
import { SpendTracker } from '../../src/llm/spend';
import type { Message } from '../../src/core/types';
import { tmpDir } from '../helpers';

function fakeClient(response: Record<string, unknown> | (() => Promise<never>)) {
  const params: unknown[] = [];
  const client: AnthropicClientLike = {
    beta: {
      messages: {
        stream: (p) => {
          params.push(p);
          return {
            finalMessage: async () => (typeof response === 'function' ? response() : (response as never)),
          };
        },
      },
    },
  };
  return { client, params };
}

const baseMessage = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'Looking at the data.', signature: 'sig' },
    { type: 'text', text: 'Let me read it.', citations: null },
    { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.csv' } },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 50,
    cache_creation_input_tokens: 10,
  },
};

describe('AnthropicProvider', () => {
  test('capabilities by model family', () => {
    expect(anthropicCapabilities('claude-opus-5-5')).toMatchObject({
      bindsThinkingToPrefix: true,
      adaptive: true,
      fallbacks: true,
      updates: true,
      contextWindow: 1_000_000,
    });
    expect(anthropicCapabilities('claude-haiku-5-5')).toMatchObject({
      bindsThinkingToPrefix: true,
      fallbacks: false,
    });
    expect(anthropicCapabilities('claude-opus-5')).toMatchObject({
      bindsThinkingToPrefix: false,
      fallbacks: true,
    });
    expect(anthropicCapabilities('claude-haiku-4-5')).toMatchObject({
      adaptive: false,
      contextWindow: 200_000,
    });
  });

  test('builds streaming params with adaptive thinking, effort, block binding, fallbacks and caching', () => {
    const p = new AnthropicProvider({ client: fakeClient(baseMessage).client });
    const params = p.buildParams({
      model: 'claude-opus-5-5',
      system: 'SYS',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ name: 'read_file', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      maxTokens: 64_000,
      effort: 'medium',
      purpose: 'agent',
    }) as unknown as Record<string, unknown>;
    expect(params).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 64_000,
      system: [{ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } }],
      cache_control: { type: 'ephemeral' },
      thinking: {
        type: 'adaptive',
        display: 'updates',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      },
      output_config: { effort: 'medium' },
      fallbacks: 'default',
      tools: [
        {
          name: 'read_file',
          description: 'd',
          input_schema: { type: 'object', properties: {} },
          eager_input_streaming: true,
        },
      ],
    });
    expect(params.betas).toEqual([
      'thinking-display-updates-2026-08-18',
      'thinking-binding-controls-2026-08-01',
      'server-side-fallback-2026-07-01',
    ]);
    expect(params).not.toHaveProperty('temperature');
    expect(params).not.toHaveProperty('tool_choice');
  });

  test('older models get no adaptive thinking and opt-outs are respected', () => {
    const p = new AnthropicProvider({
      client: fakeClient(baseMessage).client,
      fallbacks: false,
      thinkingDisplay: 'summarized',
      prefixMismatch: 'error',
    });
    const haiku = p.buildParams({
      model: 'claude-haiku-4-5',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 10,
      purpose: 'judge',
    }) as unknown as Record<string, unknown>;
    expect(haiku).not.toHaveProperty('thinking');
    expect(haiku).not.toHaveProperty('betas');
    expect(haiku).not.toHaveProperty('tools');
    const opus = p.buildParams({
      model: 'claude-opus-5-5',
      system: 's',
      messages: [],
      tools: [],
      maxTokens: 10,
      purpose: 'judge',
    }) as unknown as Record<string, unknown>;
    expect(opus.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'error' },
    });
    expect(opus).not.toHaveProperty('fallbacks');
  });

  test('replays assistant blocks verbatim and renders user blocks', () => {
    const content = fromAnthropicContent(baseMessage.content as never);
    expect(content.map((b) => b.type)).toEqual(['opaque', 'text', 'tool_call']);
    const history: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'task' },
          { type: 'text', text: '   ' },
        ],
      },
      { role: 'assistant', content },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'toolu_1', content: 'boom', isError: true },
          { type: 'tool_result', toolCallId: 'x', content: '' },
        ],
      },
      { role: 'user', content: [] },
    ];
    const out = toAnthropicMessages(history) as unknown as Array<{ role: string; content: unknown[] }>;
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'task' }]);
    expect(out[1]!.content).toEqual(baseMessage.content);
    expect(out[2]!.content).toEqual([
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'boom', is_error: true },
      { type: 'tool_result', tool_use_id: 'x', content: '(empty)' },
    ]);
    expect(out[3]!.content).toEqual([{ type: 'text', text: '(empty)' }]);
    const rebuilt = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'tool_call', id: 'a', name: 'b', input: undefined }] },
    ]) as unknown as Array<{ content: unknown[] }>;
    expect(rebuilt[0]!.content).toEqual([{ type: 'tool_use', id: 'a', name: 'b', input: {} }]);
  });

  test('complete() maps content, stop reason, usage, served model and notes', async () => {
    const { client, params } = fakeClient({
      ...baseMessage,
      model: 'claude-opus-5',
      input_transformations: [
        { type: 'thinking_dropped', reason: 'model_binding_mismatch', path: 'messages.1.content.0' },
      ],
    });
    const res = await new AnthropicProvider({ client }).complete({
      model: 'claude-opus-5-5',
      system: 's',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      maxTokens: 100,
      purpose: 'agent',
    });
    expect(params).toHaveLength(1);
    expect(res.stopReason).toBe('tool_use');
    expect(res.model).toBe('claude-opus-5');
    expect(res.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    });
    expect(res.notes).toEqual(['thinking_dropped: model_binding_mismatch messages.1.content.0']);
  });

  test('refusals carry stop details; unknown stop reasons map to other', async () => {
    const refusal = await new AnthropicProvider({
      client: fakeClient({
        ...baseMessage,
        stop_reason: 'refusal',
        content: [],
        stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' },
      }).client,
    }).complete({
      model: 'claude-opus-5-5',
      system: '',
      messages: [],
      tools: [],
      maxTokens: 1,
      purpose: 'agent',
    });
    expect(refusal).toMatchObject({
      stopReason: 'refusal',
      refusal: { category: 'cyber', explanation: 'no' },
    });
    const weird = await new AnthropicProvider({
      client: fakeClient({ ...baseMessage, stop_reason: 'model_context_window_exceeded' }).client,
    }).complete({ model: 'm', system: '', messages: [], tools: [], maxTokens: 1, purpose: 'agent' });
    expect(weird.stopReason).toBe('context_exceeded');
    const other = await new AnthropicProvider({
      client: fakeClient({ ...baseMessage, stop_reason: 'something_new' }).client,
    }).complete({ model: 'm', system: '', messages: [], tools: [], maxTokens: 1, purpose: 'agent' });
    expect(other.stopReason).toBe('other');
  });

  test('re-issues the turn when an eagerly streamed tool input is not valid JSON', async () => {
    let n = 0;
    const client: AnthropicClientLike = {
      beta: {
        messages: {
          stream: () => ({
            finalMessage: async () =>
              n++ === 0 ? Promise.reject(new SyntaxError('Unexpected end of JSON')) : (baseMessage as never),
          }),
        },
      },
    };
    const res = await new AnthropicProvider({ client }).complete({
      model: 'claude-opus-5-5',
      system: '',
      messages: [],
      tools: [],
      maxTokens: 1,
      purpose: 'agent',
    });
    expect(n).toBe(2);
    expect(res.stopReason).toBe('tool_use');
  });

  test('maps SDK errors to retryable or fatal provider errors', async () => {
    const gen = (status: number, message: string) =>
      Anthropic.APIError.generate(
        status,
        { type: 'error', error: { type: 'x', message } },
        message,
        new Headers(),
      );
    expect(mapAnthropicError(gen(429, 'slow down'))).toMatchObject({ retryable: true, kind: 'rate_limit' });
    expect(mapAnthropicError(gen(529, 'overloaded'))).toMatchObject({ retryable: true, kind: 'overloaded' });
    expect(mapAnthropicError(gen(401, 'bad key'))).toMatchObject({ retryable: false, kind: 'auth' });
    expect(
      mapAnthropicError(
        gen(
          400,
          'messages.5.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.',
        ),
      ),
    ).toMatchObject({ kind: 'thinking_binding' });
    expect(mapAnthropicError(gen(400, 'max_tokens too large'))).toMatchObject({
      kind: 'bad_request',
      retryable: false,
    });
    expect(mapAnthropicError(new Anthropic.APIConnectionError({ message: 'ECONNRESET' }))).toMatchObject({
      retryable: true,
      kind: 'network',
    });
    expect(mapAnthropicError(new Error('weird'))).toMatchObject({ retryable: false });
    const pe = new ProviderError('x', true);
    expect(mapAnthropicError(pe)).toBe(pe);
    const failing = new AnthropicProvider({
      client: fakeClient(() => Promise.reject(gen(500, 'boom'))).client,
    });
    await expect(
      failing.complete({ model: 'm', system: '', messages: [], tools: [], maxTokens: 1, purpose: 'agent' }),
    ).rejects.toMatchObject({ retryable: true });
  });
});

describe('ScriptedProvider and helpers', () => {
  test('follows a script, records snapshots and assigns call ids', async () => {
    const p = new ScriptedProvider([{ text: 'a', toolCalls: [{ name: 't', input: {} }] }, { text: 'b' }], {
      bindsThinkingToPrefix: true,
    });
    const msgs: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }];
    const r1 = await p.complete({
      model: 'm',
      system: 's',
      messages: msgs,
      tools: [],
      maxTokens: 1,
      purpose: 'agent',
    });
    msgs[0]!.content.push({ type: 'text', text: 'mutated later' });
    expect(p.requests[0]!.messages[0]!.content).toHaveLength(1);
    expect(r1.stopReason).toBe('tool_use');
    expect(r1.message.content[1]).toMatchObject({ type: 'tool_call', id: 'call_1' });
    expect(p.remaining).toBe(1);
    expect(p.capabilities().bindsThinkingToPrefix).toBe(true);
    await p.complete({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 1, purpose: 'agent' });
    expect(
      (await p.complete({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 1, purpose: 'agent' }))
        .message.content[0],
    ).toMatchObject({ text: '(script exhausted)' });
  });

  test('completeText and extractJson', async () => {
    const p = new ScriptedProvider([{ text: 'Here you go:\n```json\n{"score": 0.9}\n```' }]);
    const { text } = await completeText(p, {
      model: 'm',
      system: 's',
      prompt: 'grade',
      maxTokens: 10,
      purpose: 'judge',
    });
    expect(extractJson<{ score: number }>(text)?.score).toBe(0.9);
    expect(extractJson('prefix {"a": 1} suffix')).toEqual({ a: 1 });
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('{broken')).toBeUndefined();
  });
});

describe('PriceBook and SpendTracker', () => {
  test('prices usage per model, tolerating provider prefixes', () => {
    const book = new PriceBook({ custom: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
    expect(
      book.cost('claude-opus-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(4 + 20 + 0.2 + 5);
    expect(
      book.cost('anthropic.claude-sonnet-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBeCloseTo(2);
    expect(
      book.cost('unknown-model', {
        inputTokens: 5,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      }),
    ).toBe(0);
    expect(book.get('custom')).toBeDefined();
    // A cost the provider reports (a Claude plan bills nothing per token) wins over list price.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(book.costOf({ model: 'claude-opus-5-5', usage, costUsd: 0 })).toBe(0);
    expect(book.costOf({ model: 'claude-opus-5-5', usage })).toBeCloseTo(4);
  });

  test('enforces the daily cap and persists history', async () => {
    const file = path.join(await tmpDir(), 'spend.json');
    let now = new Date('2026-10-24T10:00:00Z');
    const spend = await new SpendTracker(1, file, () => now).load();
    expect(spend.exceeded()).toBeUndefined();
    spend.record(0.6);
    spend.record(-1);
    spend.record(0.5);
    expect(spend.today).toBeCloseTo(1.1);
    expect(spend.exceeded()).toMatch(/daily spend cap of \$1.00 reached/);
    await spend.flush();
    const reloaded = await new SpendTracker(1, file, () => now).load();
    expect(reloaded.today).toBeCloseTo(1.1);
    now = new Date('2026-10-25T00:00:01Z');
    expect(reloaded.exceeded()).toBeUndefined();
    expect(reloaded.history(7)).toEqual([{ date: '2026-10-24', usd: expect.closeTo(1.1) }]);
    expect(new SpendTracker(0).exceeded()).toBeUndefined();
  });
});
