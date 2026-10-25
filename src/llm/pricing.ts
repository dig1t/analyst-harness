import type { Usage } from '../core/types';

export interface ModelPrice {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Anthropic first-party list prices (USD per MTok) as of 2026-10. Cache writes use the
 * 5-minute TTL rate. Override or extend through `pricing` in config/harness.yaml.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  scripted: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

export class PriceBook {
  private readonly prices: Record<string, ModelPrice>;

  constructor(overrides: Record<string, ModelPrice> = {}) {
    this.prices = { ...DEFAULT_PRICING, ...overrides };
  }

  get(model: string): ModelPrice | undefined {
    if (this.prices[model]) return this.prices[model];
    // Tolerate provider prefixes such as "anthropic.claude-opus-5-5" and dated variants.
    const key = Object.keys(this.prices)
      .sort((a, b) => b.length - a.length)
      .find((k) => model.includes(k));
    return key ? this.prices[key] : undefined;
  }

  cost(model: string, usage: Usage): number {
    const p = this.get(model);
    if (!p) return 0;
    return (
      (usage.inputTokens * p.input +
        usage.outputTokens * p.output +
        usage.cacheReadTokens * p.cacheRead +
        usage.cacheWriteTokens * p.cacheWrite) /
      1_000_000
    );
  }
}
