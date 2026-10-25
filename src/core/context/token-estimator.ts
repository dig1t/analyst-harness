import type { ContentBlock, Message, ToolSchema } from '../types';

/**
 * Cheap token estimation with online calibration. The harness compares its character-based
 * estimate with the provider's reported prompt tokens after every request and keeps an
 * exponential moving average of the ratio, so thresholds track the real tokenizer.
 */
export class TokenEstimator {
  private tokensPerChar: number;

  constructor(
    initialTokensPerChar = 0.27,
    private readonly smoothing = 0.3,
  ) {
    this.tokensPerChar = initialTokensPerChar;
  }

  get ratio(): number {
    return this.tokensPerChar;
  }

  static blockChars(block: ContentBlock): number {
    switch (block.type) {
      case 'text':
        return block.text.length;
      case 'tool_call':
        return block.name.length + JSON.stringify(block.input ?? null).length;
      case 'tool_result':
        return block.content.length + 16;
      case 'opaque':
        return JSON.stringify(block.data ?? null).length;
    }
  }

  static messageChars(message: Message): number {
    let n = 8;
    for (const block of message.content) n += TokenEstimator.blockChars(block);
    return n;
  }

  static messagesChars(messages: readonly Message[]): number {
    let n = 0;
    for (const m of messages) n += TokenEstimator.messageChars(m);
    return n;
  }

  static fixedChars(system: string, tools: readonly ToolSchema[]): number {
    let n = system.length;
    for (const t of tools) n += t.name.length + t.description.length + JSON.stringify(t.inputSchema).length;
    return n;
  }

  estimateChars(chars: number): number {
    return Math.ceil(chars * this.tokensPerChar);
  }

  estimateMessages(messages: readonly Message[]): number {
    return this.estimateChars(TokenEstimator.messagesChars(messages));
  }

  estimateText(text: string): number {
    return this.estimateChars(text.length);
  }

  /** Feed the actual prompt token count for a request whose size was `chars` characters. */
  calibrate(chars: number, actualTokens: number): void {
    if (chars <= 0 || actualTokens <= 0) return;
    const observed = actualTokens / chars;
    if (!Number.isFinite(observed)) return;
    const clamped = Math.min(1.5, Math.max(0.05, observed));
    this.tokensPerChar = this.tokensPerChar * (1 - this.smoothing) + clamped * this.smoothing;
  }
}
