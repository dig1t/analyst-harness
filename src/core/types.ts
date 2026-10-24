/**
 * Provider-neutral conversation model used by the agent loop and context manager.
 *
 * Assistant blocks keep the provider's original JSON in `raw` so the provider adapter can
 * replay them byte for byte. Claude models with "preserved thinking" bind thinking blocks
 * to the exact conversation prefix, so the harness never rewrites earlier turns casually.
 */

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ReminderOrigin = 'plan_reminder' | 'stuck_reminder' | 'harness';

export interface TextBlock {
  type: 'text';
  text: string;
  /** Set on text the harness injected (reminders), so it can be identified and elided later. */
  origin?: ReminderOrigin;
  raw?: unknown;
}

export interface ToolCallBlock {
  type: 'tool_call';
  id: string;
  name: string;
  input: unknown;
  raw?: unknown;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolCallId: string;
  content: string;
  isError?: boolean;
  /** Harness event id used by recall_event and elision stubs. */
  eventId?: number;
  /** True once context management replaced the body with a stub. */
  elided?: boolean;
}

/** A provider-specific block (thinking, redacted thinking, fallback markers) replayed verbatim. */
export interface OpaqueBlock {
  type: 'opaque';
  provider: string;
  kind: string;
  data: unknown;
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock | OpaqueBlock;

export type MessageKind = 'preamble' | 'summary' | 'turn';

export interface Message {
  role: 'user' | 'assistant';
  content: ContentBlock[];
  kind?: MessageKind;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'pause_turn'
  | 'stop_sequence'
  | 'context_exceeded'
  | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const emptyUsage = (): Usage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

/** Total prompt-side tokens the model actually processed for one request. */
export function promptTokens(u: Usage): number {
  return u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
}

export function textOf(message: Message): string {
  return message.content
    .filter((b): b is TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export function toolCallsOf(message: Message): ToolCallBlock[] {
  return message.content.filter((b): b is ToolCallBlock => b.type === 'tool_call');
}
