import { promises as fsp } from 'node:fs';
import path from 'node:path';
import {
  ClaudeCodeProvider,
  claudeCodeLogin,
  renderTranscript,
  type ClaudeCliCall,
  type ClaudeCliOutput,
  type ClaudeCliRunner,
} from '../../src/llm/claude-code';
import { PriceBook } from '../../src/llm/pricing';
import { completeText, ProviderError, type CompletionRequest } from '../../src/llm/provider';
import type { Message, ToolSchema } from '../../src/core/types';
import { createLogger } from '../../src/util/logger';
import { tmpDir } from '../helpers';

const readFile: ToolSchema = {
  name: 'read_file',
  description: 'Read a workspace file.',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
};

const init = (apiKeySource = 'none') => ({
  type: 'system',
  subtype: 'init',
  model: 'claude-opus-5-5',
  apiKeySource,
});

const result = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  stop_reason: 'tool_use',
  result: '',
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
  },
  modelUsage: { 'claude-opus-5-5': { outputTokens: 20 } },
  ...over,
});

/** A CLI stand-in that prints the given stream-json events and records each call. */
function fakeCli(events: unknown[], extra: Partial<ClaudeCliOutput> = {}) {
  const calls: Array<ClaudeCliCall & { system: string }> = [];
  const run: ClaudeCliRunner = async (call) => {
    const file = call.args[call.args.indexOf('--system-prompt-file') + 1]!;
    calls.push({ ...call, system: await fsp.readFile(file, 'utf8') });
    const stdout = events.map((e) => JSON.stringify(e)).join('\n');
    return { code: 0, signal: null, stdout: `stray line\n${stdout}\n`, stderr: '', ...extra };
  };
  return { run, calls };
}

const agentRequest = (messages: Message[]): CompletionRequest => ({
  model: 'claude-opus-5-5',
  system: 'You are a data analyst.',
  messages,
  tools: [readFile],
  maxTokens: 64_000,
  effort: 'medium',
  purpose: 'agent',
});

const task: Message = { role: 'user', content: [{ type: 'text', text: 'Count the rows in a.csv' }] };

const flag = (call: ClaudeCliCall, name: string) => call.args[call.args.indexOf(name) + 1];

describe('ClaudeCodeProvider', () => {
  test('runs an isolated claude -p without API keys and reads tool calls back', async () => {
    const { run, calls } = fakeCli([
      init(),
      result({
        structured_output: {
          text: 'Reading it.',
          tool_calls: [{ name: 'read_file', input: { path: 'a.csv' } }],
        },
      }),
    ]);
    const cwd = path.join(await tmpDir(), 'claude-code');
    const provider = new ClaudeCodeProvider({
      run,
      cwd,
      tag: 'h1',
      env: {
        PATH: '/usr/bin',
        ANTHROPIC_API_KEY: 'sk-ant-test',
        ANTHROPIC_AUTH_TOKEN: 'bearer',
        CLAUDECODE: '1',
        CLAUDE_CODE_SESSION_ID: 'parent-session',
        CLAUDE_CODE_OAUTH_TOKEN: 'oat-test',
      },
    });
    const res = await provider.complete(agentRequest([task]));

    const call = calls[0]!;
    expect(call.command).toBe('claude');
    expect(call.cwd).toBe(cwd);
    expect(call.args).toEqual(
      expect.arrayContaining([
        '-p',
        '--safe-mode',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
      ]),
    );
    expect(call.args).not.toContain('--bare');
    expect(flag(call, '--tools')).toBe('');
    expect(flag(call, '--setting-sources')).toBe('');
    expect(flag(call, '--max-turns')).toBe('1');
    expect(flag(call, '--model')).toBe('claude-opus-5-5');
    expect(flag(call, '--effort')).toBe('medium');
    const schema = JSON.parse(flag(call, '--json-schema')!) as {
      properties: { tool_calls: { items: { properties: { name: { enum: string[] } } } } };
    };
    expect(schema.properties.tool_calls.items.properties.name.enum).toEqual(['read_file']);
    expect(call.env).toMatchObject({
      PATH: '/usr/bin',
      CLAUDE_CODE_OAUTH_TOKEN: 'oat-test',
      HARNESS_AUTOSTART: '0',
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    });
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_SESSION_ID'])
      expect(call.env).not.toHaveProperty(key);
    expect(call.system).toContain('You are a data analyst.');
    expect(call.system).toContain('only tool you can call is StructuredOutput');
    expect(call.system).toContain('## read_file\n\nRead a workspace file.');
    expect(JSON.parse(call.stdin)).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: '<h1:user>\nCount the rows in a.csv\n</h1:user>' }],
      },
    });
    // The system prompt file only lives for the call.
    expect(await fsp.readdir(cwd)).toEqual([]);

    expect(res.stopReason).toBe('tool_use');
    expect(res.message.content[0]).toEqual({ type: 'text', text: 'Reading it.' });
    expect(res.message.content[1]).toMatchObject({
      type: 'tool_call',
      name: 'read_file',
      input: { path: 'a.csv' },
    });
    expect(res.usage).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 300,
      cacheWriteTokens: 40,
    });
    expect(res.model).toBe('claude-opus-5-5');
    expect(res.costUsd).toBe(0);
    expect(new PriceBook().costOf(res)).toBe(0);
    expect(provider.capabilities('claude-opus-5-5')).toEqual({
      bindsThinkingToPrefix: false,
      contextWindow: 1_000_000,
    });
  });

  test('a turn without tool calls is the final answer', async () => {
    const { run } = fakeCli([
      init(),
      result({ structured_output: { text: 'There are 42 rows.', tool_calls: [] } }),
    ]);
    const res = await new ClaudeCodeProvider({ run, cwd: await tmpDir() }).complete(agentRequest([task]));
    expect(res.stopReason).toBe('end_turn');
    expect(res.message.content).toEqual([{ type: 'text', text: 'There are 42 rows.' }]);
  });

  test('a response cut short by the turn limit still yields its calls', async () => {
    const cutShort = result({ subtype: 'error_max_turns', is_error: true, structured_output: null });
    delete (cutShort as { result?: string }).result;
    const assistant = (content: unknown[]) => ({ type: 'assistant', message: { content } });
    const provider = (events: unknown[]) =>
      tmpDir().then((cwd) => new ClaudeCodeProvider({ run: fakeCli(events).run, cwd }));

    // A harness tool called by name, which Claude Code does not have.
    const byName = await (
      await provider([
        init(),
        assistant([
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'Reading the file.' },
          { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.csv' } },
        ]),
        cutShort,
      ])
    ).complete(agentRequest([task]));
    expect(byName.stopReason).toBe('tool_use');
    expect(byName.message.content).toEqual([
      { type: 'text', text: 'Reading the file.' },
      expect.objectContaining({ type: 'tool_call', name: 'read_file', input: { path: 'a.csv' } }),
    ]);

    // A StructuredOutput that failed validation: the harness checks the tool input itself.
    const invalid = await (
      await provider([
        init(),
        assistant([
          {
            type: 'tool_use',
            name: 'StructuredOutput',
            input: { tool_calls: [{ name: 'read_file', input: 'a.csv' }] },
          },
        ]),
        cutShort,
      ])
    ).complete(agentRequest([task]));
    expect(invalid.message.content).toEqual([
      expect.objectContaining({ type: 'tool_call', name: 'read_file', input: 'a.csv' }),
    ]);

    await expect((await provider([init(), cutShort])).complete(agentRequest([task]))).rejects.toMatchObject({
      retryable: true,
      message: 'Claude Code ended the turn without an answer',
    });
  });

  test('a run that ends without structured output keeps its text', async () => {
    const { run } = fakeCli([init(), result({ stop_reason: 'max_tokens', result: 'Partial answer' })]);
    const res = await new ClaudeCodeProvider({ run, cwd: await tmpDir() }).complete(agentRequest([task]));
    expect(res.stopReason).toBe('max_tokens');
    expect(res.message.content).toEqual([{ type: 'text', text: 'Partial answer' }]);
  });

  test('text completions send the prompt as it is', async () => {
    const { run, calls } = fakeCli([init(), result({ stop_reason: 'end_turn', result: '{"score": 0.9}' })]);
    const provider = new ClaudeCodeProvider({ run, cwd: await tmpDir() });
    const { text, response } = await completeText(provider, {
      model: 'claude-sonnet-5-5',
      system: 'Judge the run.',
      prompt: '<task>Count rows</task>',
      maxTokens: 4_000,
      effort: 'low',
      purpose: 'judge',
    });
    expect(text).toBe('{"score": 0.9}');
    expect(response.stopReason).toBe('end_turn');
    const call = calls[0]!;
    expect(call.args).not.toContain('--json-schema');
    expect(call.system).toBe('Judge the run.');
    expect(JSON.parse(call.stdin).message.content).toEqual([
      { type: 'text', text: '<task>Count rows</task>' },
    ]);
  });

  test('replays earlier turns as tagged blocks, one per message', () => {
    const history: Message[] = [
      task,
      {
        role: 'assistant',
        content: [
          { type: 'opaque', provider: 'anthropic', kind: 'thinking', data: { thinking: 'hidden' } },
          { type: 'text', text: 'Reading both.' },
          { type: 'tool_call', id: 'call_1', name: 'read_file', input: { path: 'a.csv' } },
          { type: 'tool_call', id: 'call_2', name: 'read_file', input: { path: 'b.csv' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolCallId: 'call_1', content: 'x\n1\n2' },
          { type: 'tool_result', toolCallId: 'call_2', content: 'no such file', isError: true },
          { type: 'tool_result', toolCallId: 'call_9', content: '' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: '  ' }] },
    ];
    const blocks = renderTranscript(history, 'h1');
    expect(blocks).toHaveLength(3);
    expect(blocks[1]!.text).toBe(
      [
        '<h1:assistant>',
        'Reading both.',
        '<h1:tool_call id="call_1" name="read_file">\n{"path":"a.csv"}\n</h1:tool_call>',
        '<h1:tool_call id="call_2" name="read_file">\n{"path":"b.csv"}\n</h1:tool_call>',
        '</h1:assistant>',
      ].join('\n'),
    );
    expect(blocks[2]!.text).toBe(
      [
        '<h1:tool_result id="call_1" name="read_file">\nx\n1\n2\n</h1:tool_result>',
        '<h1:tool_result id="call_2" name="read_file" error="true">\nno such file\n</h1:tool_result>',
        '<h1:tool_result id="call_9" name="unknown">\n(empty)\n</h1:tool_result>',
      ].join('\n'),
    );
    expect(JSON.stringify(blocks)).not.toContain('hidden');
  });

  test('refusals and context overflow come back as stop reasons', async () => {
    const refused = fakeCli([
      init(),
      {
        type: 'assistant',
        message: { stop_details: { type: 'refusal', category: 'cyber', explanation: null } },
      },
      result({ is_error: true, stop_reason: 'refusal', result: "API Error: Opus 5.5 can't help with this." }),
    ]);
    const res = await new ClaudeCodeProvider({ run: refused.run, cwd: await tmpDir() }).complete(
      agentRequest([task]),
    );
    expect(res).toMatchObject({ stopReason: 'refusal', refusal: { category: 'cyber', explanation: null } });
    expect(res.message.content).toEqual([]);

    const long = fakeCli([init(), result({ is_error: true, result: 'Prompt is too long' })]);
    const overflow = await new ClaudeCodeProvider({ run: long.run, cwd: await tmpDir() }).complete(
      agentRequest([task]),
    );
    expect(overflow.stopReason).toBe('context_exceeded');
  });

  test('failures map to retryable and fatal provider errors', async () => {
    const attempt = async (events: unknown[], extra: Partial<ClaudeCliOutput> = {}) => {
      const { run } = fakeCli(events, extra);
      const err = await new ClaudeCodeProvider({ run, cwd: await tmpDir() })
        .complete(agentRequest([task]))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderError);
      return err as ProviderError;
    };

    const limit = await attempt([
      init(),
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1793102400 },
      },
      result({ is_error: true, result: "You've hit your session limit" }),
    ]);
    expect(limit).toMatchObject({ kind: 'rate_limit', retryable: false });
    expect(limit.message).toMatch(/usage limit reached \(five_hour, resets 2026-10-27T12:00:00.000Z\)/);

    const textLimit = await attempt([
      init(),
      result({ is_error: true, result: "You've hit your weekly limit" }),
    ]);
    expect(textLimit).toMatchObject({ kind: 'rate_limit', retryable: false });

    const busy = await attempt([
      init(),
      result({ is_error: true, result: 'API Error: Repeated 529 Overloaded errors.', api_error_status: 529 }),
    ]);
    expect(busy).toMatchObject({ kind: 'overloaded', retryable: true, status: 529 });

    const throttled = await attempt([
      init(),
      result({ is_error: true, result: 'API Error: 429 rate limited' }),
    ]);
    expect(throttled).toMatchObject({ kind: 'rate_limit', retryable: true });

    const offline = await attempt([
      init(),
      result({ is_error: true, result: 'API Error: Connection error.' }),
    ]);
    expect(offline).toMatchObject({ kind: 'network', retryable: true });

    const loggedOut = await attempt([
      init(),
      result({ is_error: true, result: 'Not logged in · Please run /login' }),
    ]);
    expect(loggedOut).toMatchObject({ kind: 'auth', retryable: false });
    expect(loggedOut.message).toContain('claude setup-token');

    const badModel = await attempt([
      init(),
      result({
        is_error: true,
        result: 'Model claude-x is not a recognized model id',
        api_error_status: 400,
      }),
    ]);
    expect(badModel).toMatchObject({ kind: 'bad_request', retryable: false });

    const invalid = await attempt([
      init(),
      result({ subtype: 'error_max_structured_output_retries', is_error: true }),
    ]);
    expect(invalid).toMatchObject({ retryable: false });
    expect(invalid.message).toMatch(/structured output retries/);

    const old = await attempt([], { code: 1, stdout: '', stderr: "error: unknown option '--safe-mode'" });
    expect(old.message).toContain('claude update');

    const empty = await attempt([], { code: 2, stdout: '' });
    expect(empty.message).toBe('claude exited with code 2');

    const killed = await attempt([], { code: null, signal: 'SIGTERM', stdout: '' });
    expect(killed).toMatchObject({ kind: 'network', retryable: true });

    const missing = new ClaudeCodeProvider({
      command: '/opt/none/claude',
      cwd: await tmpDir(),
      run: async () => {
        throw Object.assign(new Error('spawn /opt/none/claude ENOENT'), { code: 'ENOENT' });
      },
    });
    await expect(missing.complete(agentRequest([task]))).rejects.toThrow(
      /Claude Code was not found \(`\/opt\/none\/claude`\).*claudeCode\.command/,
    );
  });

  test('API key billing is priced and plan warnings are logged once per window', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'warn', sink: (l) => lines.push(l) });
    const warning = {
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'allowed_warning',
        rateLimitType: 'seven_day',
        resetsAt: 1793102400,
        utilization: 0.81,
      },
    };
    const { run } = fakeCli([
      init('/login managed key'),
      warning,
      result({ structured_output: { text: 'ok', tool_calls: [] } }),
    ]);
    const provider = new ClaudeCodeProvider({ run, cwd: await tmpDir(), logger });
    const first = await provider.complete(agentRequest([task]));
    await provider.complete(agentRequest([task]));
    expect(first.costUsd).toBeUndefined();
    expect(new PriceBook().costOf(first)).toBeGreaterThan(0);
    expect(lines.filter((l) => l.includes('billing an API key'))).toHaveLength(1);
    const limits = lines.filter((l) => l.includes('close to a limit'));
    expect(limits).toHaveLength(1);
    expect(limits[0]).toContain('"utilization":0.81');
  });

  test('the default runner spawns the CLI with stdin, a cleaned environment and a timeout', async () => {
    const dir = await tmpDir();
    const script = path.join(dir, 'fake-claude.js');
    await fsp.writeFile(
      script,
      `#!/usr/bin/env node
if (process.argv.includes('--model') && process.argv[process.argv.indexOf('--model') + 1] === 'slow') {
  setTimeout(() => undefined, 10000);
} else {
  let input = '';
  process.stdin.on('data', (c) => (input += c)).on('end', () => {
    const text = JSON.parse(input).message.content[0].text;
    const key = process.env.ANTHROPIC_API_KEY ?? 'no key';
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text + ' / ' + key }) + '\\n');
  });
}
`,
      { mode: 0o755 },
    );
    const provider = new ClaudeCodeProvider({
      command: script,
      cwd: path.join(dir, 'cwd'),
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-test' },
      timeoutMs: 1_000,
    });
    const { text } = await completeText(provider, {
      model: 'claude-opus-5-5',
      system: 'Echo.',
      prompt: 'hello',
      maxTokens: 1_000,
      purpose: 'summarize',
    });
    expect(text).toBe('hello / no key');
    await expect(
      completeText(provider, {
        model: 'slow',
        system: 'Echo.',
        prompt: 'hi',
        maxTokens: 1_000,
        purpose: 'summarize',
      }),
    ).rejects.toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('claudeCodeLogin', () => {
  const status =
    (stdout: string, code = 0): ClaudeCliRunner =>
    async () => ({ code, signal: null, stdout, stderr: '' });

  test('reports whether runs use the Claude plan', async () => {
    const calls: ClaudeCliCall[] = [];
    const run: ClaudeCliRunner = async (call) => {
      calls.push(call);
      return { code: 0, signal: null, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' };
    };
    await expect(claudeCodeLogin({ run, env: { ANTHROPIC_API_KEY: 'sk-ant-test' } })).resolves.toEqual({
      ok: true,
      note: 'logged in (claude.ai): runs use your Claude plan',
    });
    expect(calls[0]!.args).toEqual(['auth', 'status', '--json']);
    expect(calls[0]!.env).not.toHaveProperty('ANTHROPIC_API_KEY');

    await expect(
      claudeCodeLogin({ run: status('{"loggedIn": true, "authMethod": "oauth_token"}') }),
    ).resolves.toMatchObject({
      ok: true,
    });
    const out = await claudeCodeLogin({ run: status('{"loggedIn": false, "authMethod": "none"}', 1) });
    expect(out).toMatchObject({ ok: false });
    expect(out.note).toMatch(/^not logged in/);
    const helper = await claudeCodeLogin({
      run: status('{"loggedIn": true, "authMethod": "api_key_helper"}'),
    });
    expect(helper).toEqual({
      ok: false,
      note: 'Claude Code signs in with api_key_helper, which bills per token, not your plan',
    });
    const broken = await claudeCodeLogin({ run: status('Segmentation fault', 139) });
    expect(broken.note).toBe('`claude auth status` failed: Segmentation fault');
    const missing = await claudeCodeLogin({
      run: async () => {
        throw Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(missing).toMatchObject({ ok: false });
    expect(missing.note).toMatch(/^Claude Code was not found/);
  });
});
