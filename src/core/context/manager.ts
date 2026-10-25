import { elisionStub, summaryWrapper } from '../prompts';
import type { ContentBlock, Message, ToolResultBlock, ToolSchema } from '../types';
import { countLines, truncateMiddle } from '../../util/text';
import type { ExternalStore } from './external-store';
import { TokenEstimator } from './token-estimator';

/**
 * Context-management tiers from Table 2 of the paper:
 *   T0 none, T1 elision (M1), T2 elision + recall (M1+M2), T3 summarization (M3),
 *   T4 elision + recall at the soft threshold B1 and summarization at the hard threshold B2.
 * T1 to T3 have a single mechanism and act at B2; T4 stages cheap elision before LLM
 * summarization, which the paper found to be the most cost-efficient strategy.
 */
export type ContextTier = 0 | 1 | 2 | 3 | 4;

export const TIER_MECHANISMS: Record<ContextTier, { elide: boolean; recall: boolean; summarize: boolean }> = {
  0: { elide: false, recall: false, summarize: false },
  1: { elide: true, recall: false, summarize: false },
  2: { elide: true, recall: true, summarize: false },
  3: { elide: false, recall: false, summarize: true },
  4: { elide: true, recall: true, summarize: true },
};

export interface ContextConfig {
  tier: ContextTier;
  /** Context-window budget in tokens (the paper sweeps 32k, 64k, 96k and 128k). */
  windowTokens: number;
  /** Soft threshold B1 as a fraction of the window (paper: 0.6). */
  softRatio: number;
  /** Hard threshold B2 as a fraction of the window (paper: 0.85). */
  hardRatio: number;
  /** Verbatim recent window as a fraction of the window (paper: 0.3). */
  recentRatio: number;
  /** The recent window always keeps at least this many turns (paper: 2). */
  minRecentTurns: number;
  /** Observations shorter than this are not worth eliding. */
  bulkyMinChars: number;
  /**
   * True when the provider binds reasoning blocks to the exact conversation prefix (Claude
   * "preserved thinking"). After any history edit the manager strips every thinking block,
   * which removes a leading run of blocks and keeps later requests valid.
   */
  bindsThinking: boolean;
  /** Opaque block kinds that count as reasoning for `bindsThinking`. */
  thinkingKinds: string[];
}

export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  tier: 4,
  windowTokens: 128_000,
  softRatio: 0.6,
  hardRatio: 0.85,
  recentRatio: 0.3,
  minRecentTurns: 2,
  bulkyMinChars: 800,
  bindsThinking: false,
  thinkingKinds: ['thinking', 'redacted_thinking'],
};

export type Summarizer = (input: { previousSummary?: string; transcript: string }) => Promise<string>;

export interface ContextEvent {
  action: 'elide' | 'summarize' | 'strip_thinking' | 'overflow';
  tokensBefore: number;
  tokensAfter: number;
  count: number;
  emergency?: boolean;
}

export interface PrepareResult {
  events: ContextEvent[];
  overflow: boolean;
  tokens: number;
  edited: boolean;
}

interface TurnRange {
  start: number;
  end: number; // exclusive
}

export class ContextManager {
  private fixedChars = 0;
  private summaryCalls = 0;
  private elisions = 0;

  constructor(
    readonly config: ContextConfig,
    readonly estimator: TokenEstimator,
    private readonly store: ExternalStore,
    private readonly summarizer?: Summarizer,
  ) {
    if (config.softRatio >= config.hardRatio) throw new Error('softRatio must be below hardRatio');
  }

  get stats(): { summaryCalls: number; elisions: number } {
    return { summaryCalls: this.summaryCalls, elisions: this.elisions };
  }

  get mechanisms() {
    return TIER_MECHANISMS[this.config.tier];
  }

  get softLimit(): number {
    return Math.floor(this.config.windowTokens * this.config.softRatio);
  }

  get hardLimit(): number {
    return Math.floor(this.config.windowTokens * this.config.hardRatio);
  }

  setFixed(system: string, tools: readonly ToolSchema[]): void {
    this.fixedChars = TokenEstimator.fixedChars(system, tools);
  }

  /** Characters of a full request: system prompt and tools plus every message. */
  requestChars(history: readonly Message[]): number {
    return this.fixedChars + TokenEstimator.messagesChars(history);
  }

  tokens(history: readonly Message[]): number {
    return this.estimator.estimateChars(this.requestChars(history));
  }

  /** Apply Algorithm 1 to `history` in place. Call before every model request. */
  async prepare(history: Message[]): Promise<PrepareResult> {
    const events: ContextEvent[] = [];
    const mech = this.mechanisms;
    let edited = false;
    let tokens = this.tokens(history);

    const elideAt = this.config.tier === 4 ? this.softLimit : this.hardLimit;
    if (mech.elide && tokens >= elideAt) {
      const before = tokens;
      let count = this.elide(history, this.middleTurns(history), mech.recall);
      let emergency = false;
      tokens = this.tokens(history);
      if (tokens >= this.hardLimit && !mech.summarize) {
        // Nothing left in the middle region: elide inside the recent window too, keeping the newest turn.
        const extra = this.elide(history, this.allButNewestTurn(history), mech.recall);
        if (extra > 0) emergency = true;
        count += extra;
        tokens = this.tokens(history);
      }
      if (count > 0) {
        edited = true;
        this.elisions += count;
        events.push({ action: 'elide', tokensBefore: before, tokensAfter: tokens, count, emergency });
      }
    }

    if (mech.summarize && this.summarizer && tokens >= this.hardLimit) {
      const before = tokens;
      const summarized = await this.summarize(history, mech.recall);
      tokens = this.tokens(history);
      if (summarized > 0) {
        edited = true;
        events.push({ action: 'summarize', tokensBefore: before, tokensAfter: tokens, count: summarized });
      }
      if (tokens >= this.hardLimit) {
        const extra = this.elide(history, this.allButNewestTurn(history), mech.recall);
        if (extra > 0) {
          edited = true;
          const after = this.tokens(history);
          events.push({
            action: 'elide',
            tokensBefore: tokens,
            tokensAfter: after,
            count: extra,
            emergency: true,
          });
          tokens = after;
        }
      }
    }

    if (edited && this.config.bindsThinking) {
      const before = tokens;
      const stripped = this.stripThinking(history);
      tokens = this.tokens(history);
      if (stripped > 0)
        events.push({ action: 'strip_thinking', tokensBefore: before, tokensAfter: tokens, count: stripped });
    }

    const overflow = tokens > this.config.windowTokens;
    if (overflow) events.push({ action: 'overflow', tokensBefore: tokens, tokensAfter: tokens, count: 0 });
    return { events, overflow, tokens, edited };
  }

  /** Return the messages to send, with an optional ephemeral reminder on the last user message. */
  render(history: readonly Message[], ephemeralText?: string): Message[] {
    if (!ephemeralText) return [...history];
    const out = [...history];
    for (let i = out.length - 1; i >= 0; i--) {
      const m = out[i]!;
      if (m.role === 'user') {
        out[i] = {
          ...m,
          content: [...m.content, { type: 'text', text: ephemeralText, origin: 'plan_reminder' }],
        };
        return out;
      }
    }
    return out;
  }

  // ----- regions -----

  preambleEnd(history: readonly Message[]): number {
    let i = 0;
    while (i < history.length && (history[i]!.kind === 'preamble' || history[i]!.kind === 'summary')) i++;
    return i;
  }

  turns(history: readonly Message[]): TurnRange[] {
    const ranges: TurnRange[] = [];
    const start = this.preambleEnd(history);
    let current: TurnRange | undefined;
    for (let i = start; i < history.length; i++) {
      if (history[i]!.role === 'assistant') {
        if (current) ranges.push(current);
        current = { start: i, end: i + 1 };
      } else if (current) {
        current.end = i + 1;
      }
    }
    if (current) ranges.push(current);
    return ranges;
  }

  private turnTokens(history: readonly Message[], t: TurnRange): number {
    return this.estimator.estimateMessages(history.slice(t.start, t.end));
  }

  recentTurnCount(history: readonly Message[]): number {
    const turns = this.turns(history);
    const budget = this.config.windowTokens * this.config.recentRatio;
    let used = 0;
    let count = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = this.turnTokens(history, turns[i]!);
      if (count >= this.config.minRecentTurns && used + t > budget) break;
      used += t;
      count++;
    }
    return count;
  }

  middleTurns(history: readonly Message[]): TurnRange[] {
    const turns = this.turns(history);
    const recent = this.recentTurnCount(history);
    return turns.slice(0, Math.max(0, turns.length - recent));
  }

  private allButNewestTurn(history: readonly Message[]): TurnRange[] {
    return this.turns(history).slice(0, -1);
  }

  // ----- M1: elision -----

  /**
   * Replace bulky observations in `ranges` with stubs. Stale harness reminders in the same
   * range are dropped in the same pass, but only when at least one observation is elided, so
   * a quiet turn never causes a history edit (edits invalidate preserved thinking).
   */
  private elide(history: Message[], ranges: TurnRange[], withRecall: boolean): number {
    const isBulky = (b: ContentBlock): b is ToolResultBlock =>
      b.type === 'tool_result' && !b.elided && b.content.length >= this.config.bulkyMinChars;
    let candidates = 0;
    for (const range of ranges) {
      for (let i = range.start; i < range.end; i++) {
        const msg = history[i]!;
        if (msg.role === 'user') candidates += msg.content.filter(isBulky).length;
      }
    }
    if (candidates === 0) return 0;

    for (const range of ranges) {
      for (let i = range.start; i < range.end; i++) {
        const msg = history[i]!;
        if (msg.role !== 'user') continue;
        let changed = false;
        const content: ContentBlock[] = [];
        for (const block of msg.content) {
          if (
            block.type === 'text' &&
            (block.origin === 'plan_reminder' || block.origin === 'stuck_reminder')
          ) {
            changed = true;
            continue;
          }
          if (isBulky(block)) {
            const stub = elisionStub(
              countLines(block.content),
              block.content.length,
              block.eventId,
              withRecall,
            );
            content.push({ ...block, content: stub, elided: true });
            changed = true;
            continue;
          }
          content.push(block);
        }
        if (changed) history[i] = { ...msg, content };
      }
    }
    return candidates;
  }

  // ----- M3: summarization -----

  private async summarize(history: Message[], withRecall: boolean): Promise<number> {
    const middle = this.middleTurns(history);
    if (middle.length === 0 || !this.summarizer) return 0;

    // Summarize the smallest prefix of the middle region that brings the context under B1.
    const total = this.tokens(history);
    let removed = 0;
    let take = 0;
    for (const t of middle) {
      removed += this.turnTokens(history, t);
      take++;
      const estimatedSummary = Math.min(2_000, Math.ceil(removed * 0.1));
      if (total - removed + estimatedSummary <= this.softLimit) break;
    }
    const chosen = middle.slice(0, take);
    const first = chosen[0]!;
    const last = chosen[chosen.length - 1]!;

    const pre = this.preambleEnd(history);
    const existing = history.slice(0, pre).find((m) => m.kind === 'summary');
    const previousSummary = existing
      ? existing.content.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
      : undefined;
    const transcript = this.serialize(history.slice(first.start, last.end));
    this.summaryCalls++;
    const summary = await this.summarizer({ previousSummary, transcript });

    let lastEventId: number | undefined;
    for (const m of history.slice(first.start, last.end)) {
      for (const b of m.content)
        if (b.type === 'tool_result' && b.eventId !== undefined) lastEventId = b.eventId;
    }
    lastEventId ??= this.store.lastId || undefined;

    const summaryMsg: Message = {
      role: 'user',
      kind: 'summary',
      content: [{ type: 'text', text: summaryWrapper(summary, lastEventId, withRecall), origin: 'harness' }],
    };
    history.splice(first.start, last.end - first.start);
    const summaryIndex = history.findIndex((m) => m.kind === 'summary');
    if (summaryIndex >= 0) history[summaryIndex] = summaryMsg;
    else history.splice(this.preambleEnd(history), 0, summaryMsg);
    return chosen.length;
  }

  private serialize(messages: readonly Message[]): string {
    const lines: string[] = [];
    for (const m of messages) {
      for (const b of m.content) {
        if (b.type === 'text' && b.text.trim()) lines.push(`[${m.role}] ${truncateMiddle(b.text, 2_000)}`);
        if (b.type === 'tool_call')
          lines.push(`[tool_call ${b.name}] ${truncateMiddle(JSON.stringify(b.input), 1_500)}`);
        if (b.type === 'tool_result') {
          const tag = `[tool_result${b.eventId !== undefined ? ` #${b.eventId}` : ''}${b.isError ? ' error' : ''}]`;
          lines.push(`${tag} ${truncateMiddle(b.content, 2_000)}`);
        }
      }
    }
    return lines.join('\n');
  }

  // ----- preserved-thinking safety -----

  stripThinking(history: Message[]): number {
    let stripped = 0;
    const kinds = new Set(this.config.thinkingKinds);
    for (let i = 0; i < history.length; i++) {
      const m = history[i]!;
      if (m.role !== 'assistant') continue;
      const kept = m.content.filter((b) => !(b.type === 'opaque' && kinds.has(b.kind)));
      if (kept.length !== m.content.length) {
        stripped += m.content.length - kept.length;
        // An assistant message needs at least one non-empty block.
        history[i] = {
          ...m,
          content: kept.length > 0 ? kept : [{ type: 'text', text: '(reasoning omitted)' }],
        };
      }
    }
    return stripped;
  }
}
