import type { AgentEvent, RunResult } from '../core/agent-loop';
import { formatUsd, truncateMiddle } from '../util/text';
import { DISCORD_CONTENT_LIMIT } from './notifier';

export interface CommandReply {
  content: string;
  file?: { name: string; content: string };
  ephemeral?: boolean;
  /** Attach good/bad feedback buttons for this run id. */
  feedbackRunId?: string;
}

const OUTCOME_LABEL: Record<string, string> = {
  completed: 'completed',
  max_steps: 'stopped at the step limit',
  stuck: 'stopped (stuck in a loop)',
  context_overflow: 'stopped (context overflow)',
  budget_exceeded: 'stopped (budget reached)',
  refusal: 'declined by the model',
  aborted: 'stopped by request',
  provider_error: 'failed (provider error)',
};

/** Fit an answer into one Discord message, attaching the full text when it is long. */
export function fitMessage(
  header: string,
  body: string,
  fileName: string,
  limit = DISCORD_CONTENT_LIMIT,
): CommandReply {
  const full = `${header}\n\n${body}`.trim();
  if (full.length <= limit) return { content: full };
  const room = limit - header.length - 60;
  return {
    content: `${header}\n\n${truncateMiddle(body, Math.max(200, room), 0)}\n\n(full text attached)`.slice(
      0,
      limit,
    ),
    file: { name: fileName, content: `${header}\n\n${body}\n` },
  };
}

export function formatRunResult(r: RunResult): CommandReply {
  const header = `**Run** \`${r.runId}\` ${OUTCOME_LABEL[r.outcome] ?? r.outcome} in ${r.steps} step${r.steps === 1 ? '' : 's'}, ${r.toolCalls} tool call${r.toolCalls === 1 ? '' : 's'}, ${formatUsd(r.costUsd)} (profile \`${r.profileId}\`, ${r.model})`;
  const body = [
    r.finalText.trim() || '(no answer text)',
    r.error ? `\nReason: ${r.error}` : '',
    r.changedFiles.length ? `\nFiles: ${r.changedFiles.slice(0, 10).join(', ')}` : '',
  ].join('');
  return {
    ...fitMessage(header, body, `${r.runId}.md`),
    feedbackRunId: r.outcome === 'completed' ? r.runId : undefined,
  };
}

export function codeTable(rows: string[][]): string {
  if (rows.length === 0) return '(none)';
  const widths = rows[0]!.map((_, i) => Math.min(40, Math.max(...rows.map((r) => (r[i] ?? '').length))));
  const lines = rows.map((r) =>
    r
      .map((c, i) => (c ?? '').slice(0, 40).padEnd(widths[i]!))
      .join('  ')
      .trimEnd(),
  );
  return '```\n' + lines.join('\n') + '\n```';
}

/** Turns agent events into a compact, throttled progress line for a deferred reply. */
export class ProgressTracker {
  private step = 0;
  private lastTool = '';
  private plan = '';
  private note = '';
  private cost = 0;
  private lastSent = 0;

  constructor(
    private readonly send: (text: string) => Promise<void>,
    private readonly minIntervalMs = 3_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  render(): string {
    const parts = [`Working... step ${this.step}`];
    if (this.lastTool) parts.push(`last action: ${this.lastTool}`);
    if (this.plan) parts.push(`plan ${this.plan}`);
    parts.push(formatUsd(this.cost));
    return parts.join(' | ') + (this.note ? `\n> ${this.note.slice(0, 300)}` : '');
  }

  async onEvent(e: AgentEvent): Promise<void> {
    switch (e.type) {
      case 'llm_response':
        this.step = e.step;
        this.cost += e.costUsd;
        if (e.progress.length) this.note = e.progress[e.progress.length - 1]!;
        else if (e.text && e.toolCalls.length) this.note = e.text;
        if (e.toolCalls.length) this.lastTool = e.toolCalls.map((c) => c.name).join(', ');
        break;
      case 'plan':
        this.plan = `${e.done}/${e.total}`;
        break;
      default:
        return;
    }
    if (this.now() - this.lastSent >= this.minIntervalMs) {
      this.lastSent = this.now();
      await this.send(this.render());
    }
  }
}
