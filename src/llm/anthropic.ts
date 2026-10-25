import Anthropic from '@anthropic-ai/sdk';
import type { ContentBlock, Message, StopReason, Usage } from '../core/types';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import {
  ProviderError,
  type CompletionRequest,
  type CompletionResponse,
  type LLMProvider,
  type ProviderCapabilities,
} from './provider';

type BetaMessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type BetaContentBlock = Anthropic.Beta.Messages.BetaContentBlock;
type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type StreamParams = Anthropic.Beta.Messages.MessageCreateParams;

/** The slice of the SDK client this provider uses; tests pass a fake. */
export interface AnthropicClientLike {
  beta: {
    messages: {
      stream(
        params: StreamParams,
        options?: { signal?: AbortSignal },
      ): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

export interface AnthropicProviderOptions {
  client?: AnthropicClientLike;
  apiKey?: string;
  /** What to do when a replayed thinking block fails the conversation check. */
  prefixMismatch?: 'drop_block' | 'error';
  /** Server-side refusal fallback ("default" routes by refusal category). */
  fallbacks?: boolean;
  /** Thinking display: progress updates give readable notes between tool calls. */
  thinkingDisplay?: 'omitted' | 'summarized' | 'updates';
  logger?: Logger;
}

const ADAPTIVE_RE =
  /claude-(fable|mythos)-5|claude-opus-5|claude-opus-4-[678]|claude-sonnet-5|claude-sonnet-4-6|claude-haiku-5-5/;
const PRESERVED_RE = /claude-(fable|mythos)-5-1|claude-opus-5-5|claude-sonnet-5-5|claude-haiku-5-5/;
const FALLBACK_RE = /claude-fable-5(-1)?$|claude-opus-5(-5)?$|claude-sonnet-5-5$/;
const UPDATES_RE = /claude-(fable|mythos)-5|claude-opus-5-5|claude-sonnet-5-5/;

export function anthropicCapabilities(
  model: string,
): ProviderCapabilities & { adaptive: boolean; fallbacks: boolean; updates: boolean } {
  return {
    bindsThinkingToPrefix: PRESERVED_RE.test(model),
    contextWindow: /haiku-4-5/.test(model) ? 200_000 : 1_000_000,
    adaptive: ADAPTIVE_RE.test(model),
    fallbacks: FALLBACK_RE.test(model),
    updates: UPDATES_RE.test(model),
  };
}

/** Neutral history to Messages API params. Assistant blocks replay their original JSON. */
export function toAnthropicMessages(messages: Message[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  for (const m of messages) {
    const content: unknown[] = [];
    for (const b of m.content) {
      switch (b.type) {
        case 'text':
          if (b.text.trim().length === 0) break;
          content.push(m.role === 'assistant' && b.raw ? b.raw : { type: 'text', text: b.text });
          break;
        case 'tool_call':
          content.push(b.raw ?? { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
          break;
        case 'tool_result':
          content.push({
            type: 'tool_result',
            tool_use_id: b.toolCallId,
            content: b.content || '(empty)',
            ...(b.isError ? { is_error: true } : {}),
          });
          break;
        case 'opaque':
          if (b.provider === 'anthropic') content.push(b.data);
          break;
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: '(empty)' });
    out.push({ role: m.role, content } as BetaMessageParam);
  }
  return out;
}

export function fromAnthropicContent(blocks: BetaContentBlock[]): ContentBlock[] {
  return blocks.map((block): ContentBlock => {
    if (block.type === 'text') return { type: 'text', text: block.text, raw: block };
    if (block.type === 'tool_use')
      return { type: 'tool_call', id: block.id, name: block.name, input: block.input, raw: block };
    return { type: 'opaque', provider: 'anthropic', kind: block.type, data: block };
  });
}

function mapStop(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'pause_turn':
    case 'refusal':
      return reason;
    case 'model_context_window_exceeded':
      return 'context_exceeded';
    default:
      return 'other';
  }
}

function mapUsage(u: BetaMessage['usage'] | undefined): Usage {
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: u?.output_tokens ?? 0,
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
  };
}

export function mapAnthropicError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  if (err instanceof Anthropic.RateLimitError) return new ProviderError(err.message, true, 429, 'rate_limit');
  if (err instanceof Anthropic.APIConnectionError)
    return new ProviderError(err.message, true, undefined, 'network');
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(err.message, false, err.status, 'auth');
  }
  if (err instanceof Anthropic.BadRequestError) {
    const binding = /signature|bound to a different conversation/i.test(err.message);
    return new ProviderError(err.message, false, 400, binding ? 'thinking_binding' : 'bad_request');
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryable = status !== undefined && (status >= 500 || status === 408 || status === 409);
    return new ProviderError(
      err.message,
      retryable,
      status,
      status !== undefined && status >= 500 ? 'overloaded' : 'other',
    );
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), false);
}

/**
 * Claude via the official SDK. Every request streams (long agent turns would otherwise hit
 * HTTP timeouts) and uses adaptive thinking with an explicit effort level. Preserved-thinking
 * models get `prefix_mismatch_behavior` set explicitly; the context manager keeps the history
 * append-only between compaction boundaries and strips thinking at each boundary, so drops are
 * a safety net rather than the steady state.
 */
export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: AnthropicClientLike;
  private readonly logger: Logger;

  constructor(private readonly opts: AnthropicProviderOptions = {}) {
    this.client =
      opts.client ??
      (new Anthropic({ apiKey: opts.apiKey, maxRetries: 3 }) as unknown as AnthropicClientLike);
    this.logger = opts.logger ?? silentLogger;
  }

  capabilities(model: string): ProviderCapabilities {
    const c = anthropicCapabilities(model);
    return { bindsThinkingToPrefix: c.bindsThinkingToPrefix, contextWindow: c.contextWindow };
  }

  buildParams(req: CompletionRequest): StreamParams {
    const caps = anthropicCapabilities(req.model);
    const betas: string[] = [];
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: toAnthropicMessages(req.messages),
      cache_control: { type: 'ephemeral' },
    };
    if (req.tools.length > 0) {
      params.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        eager_input_streaming: true,
      }));
    }
    if (caps.adaptive) {
      const thinking: Record<string, unknown> = { type: 'adaptive' };
      const display = this.opts.thinkingDisplay ?? 'updates';
      if (display === 'updates' && caps.updates) {
        thinking.display = 'updates';
        betas.push('thinking-display-updates-2026-08-18');
      } else if (display === 'summarized') {
        thinking.display = 'summarized';
      }
      if (caps.bindsThinkingToPrefix) {
        thinking.block_binding = { prefix_mismatch_behavior: this.opts.prefixMismatch ?? 'drop_block' };
        betas.push('thinking-binding-controls-2026-08-01');
      }
      params.thinking = thinking;
      if (req.effort) params.output_config = { effort: req.effort };
    }
    if ((this.opts.fallbacks ?? true) && caps.fallbacks) {
      params.fallbacks = 'default';
      betas.push('server-side-fallback-2026-07-01');
    }
    if (betas.length > 0) params.betas = betas;
    return params as unknown as StreamParams;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const params = this.buildParams(req);
    let message: BetaMessage | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        message = await this.client.beta.messages.stream(params, { signal: req.signal }).finalMessage();
        break;
      } catch (err) {
        // With eager input streaming the SDK rejects when a tool input is not parseable JSON.
        // Only that case is re-issued here; API errors are mapped and handled by the caller.
        if (!(err instanceof Anthropic.APIError) && err instanceof SyntaxError && attempt < 2) {
          this.logger.warn('tool input was not parseable JSON; re-issuing the turn', { attempt });
          continue;
        }
        throw mapAnthropicError(err);
      }
    }
    const notes: string[] = [];
    const transformations = (
      message as unknown as {
        input_transformations?: Array<{ type?: string; reason?: string; path?: string }>;
      }
    ).input_transformations;
    for (const t of transformations ?? [])
      notes.push(`${t.type ?? 'transformation'}: ${t.reason ?? ''} ${t.path ?? ''}`.trim());
    if (notes.length) this.logger.warn('provider transformed input', { notes });
    const stopDetails = (
      message as unknown as {
        stop_details?: { category?: string | null; explanation?: string | null } | null;
      }
    ).stop_details;
    return {
      message: { role: 'assistant', content: fromAnthropicContent(message.content) },
      stopReason: mapStop(message.stop_reason),
      usage: mapUsage(message.usage),
      model: message.model ?? req.model,
      refusal:
        message.stop_reason === 'refusal'
          ? { category: stopDetails?.category ?? null, explanation: stopDetails?.explanation ?? null }
          : undefined,
      notes,
    };
  }
}
