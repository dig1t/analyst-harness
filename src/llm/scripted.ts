import type { ContentBlock, Message, StopReason, Usage } from '../core/types';
import type { CompletionRequest, CompletionResponse, LLMProvider, ProviderCapabilities } from './provider';

export interface ScriptedTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: unknown; id?: string }>;
  stopReason?: StopReason;
  usage?: Partial<Usage>;
  /** Extra provider blocks (for example simulated thinking) placed before the text. */
  opaque?: ContentBlock[];
}

export type ScriptedResponder = (req: CompletionRequest, index: number) => ScriptedTurn;

/**
 * Deterministic provider for tests and offline demos. Responses come from a list (consumed in
 * order) or from a function of the request. Every request is recorded for assertions.
 */
export class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted';
  readonly requests: CompletionRequest[] = [];
  private index = 0;
  private callSeq = 0;

  constructor(
    private readonly script: ScriptedTurn[] | ScriptedResponder,
    private readonly caps: Partial<ProviderCapabilities> = {},
  ) {}

  capabilities(): ProviderCapabilities {
    return { bindsThinkingToPrefix: false, contextWindow: 1_000_000, ...this.caps };
  }

  get remaining(): number {
    return Array.isArray(this.script) ? this.script.length - this.index : Infinity;
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Snapshot the request so later in-place history edits do not rewrite what was sent.
    this.requests.push({ ...req, messages: structuredClone(req.messages) as Message[] });
    const turn = Array.isArray(this.script)
      ? (this.script[this.index] ?? { text: '(script exhausted)' })
      : this.script(req, this.index);
    this.index++;
    const content: ContentBlock[] = [...(turn.opaque ?? [])];
    if (turn.text !== undefined) content.push({ type: 'text', text: turn.text });
    for (const call of turn.toolCalls ?? []) {
      content.push({
        type: 'tool_call',
        id: call.id ?? `call_${++this.callSeq}`,
        name: call.name,
        input: call.input,
      });
    }
    const hasCalls = (turn.toolCalls?.length ?? 0) > 0;
    const promptChars = JSON.stringify(req.messages).length + req.system.length;
    return {
      message: { role: 'assistant', content },
      stopReason: turn.stopReason ?? (hasCalls ? 'tool_use' : 'end_turn'),
      usage: {
        inputTokens: turn.usage?.inputTokens ?? Math.ceil(promptChars / 4),
        outputTokens: turn.usage?.outputTokens ?? Math.ceil(JSON.stringify(content).length / 4),
        cacheReadTokens: turn.usage?.cacheReadTokens ?? 0,
        cacheWriteTokens: turn.usage?.cacheWriteTokens ?? 0,
      },
      model: req.model,
    };
  }
}
