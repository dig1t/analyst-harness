import type { Effort, Message, StopReason, ToolSchema, Usage } from '../core/types';

export type CallPurpose =
  'agent' | 'summarize' | 'judge' | 'reflect' | 'classify' | 'extract' | 'synthesize' | 'digest';

export interface CompletionRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  effort?: Effort;
  purpose: CallPurpose;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  message: Message;
  stopReason: StopReason;
  usage: Usage;
  /** Model that actually served the request (differs after a server-side fallback). */
  model: string;
  refusal?: { category?: string | null; explanation?: string | null };
  /** Provider notes such as dropped thinking blocks, surfaced for logging. */
  notes?: string[];
}

export interface ProviderCapabilities {
  /** Reasoning blocks are bound to the exact conversation prefix (Claude preserved thinking). */
  bindsThinkingToPrefix: boolean;
  /** Context window of the model, in tokens. */
  contextWindow: number;
}

export interface LLMProvider {
  readonly name: string;
  capabilities(model: string): ProviderCapabilities;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

/** Errors a caller may retry after waiting (rate limits, overload, network). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly kind:
      | 'rate_limit'
      | 'overloaded'
      | 'network'
      | 'bad_request'
      | 'auth'
      | 'thinking_binding'
      | 'other' = 'other',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Run a single text-only completion and return its text. */
export async function completeText(
  provider: LLMProvider,
  req: Omit<CompletionRequest, 'tools' | 'messages'> & { prompt: string },
): Promise<{ text: string; response: CompletionResponse }> {
  const response = await provider.complete({
    ...req,
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: req.prompt }] }],
  });
  const text = response.message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n')
    .trim();
  return { text, response };
}

/** Pull the first JSON object out of model text (tolerates code fences and preambles). */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1)) as T;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}
