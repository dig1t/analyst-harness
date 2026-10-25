import { sha256, stableStringify } from '../util/hash';
import { stuckFailingReminder, stuckRepeatReminder } from './prompts';

export interface StuckConfig {
  /** Reminder once a streak reaches this many identical calls of any status (paper: 5). */
  repeatThreshold: number;
  /** Reminder once a streak reaches this many identical failing calls (paper: 5). */
  failThreshold: number;
  /** Terminate when the identical failing streak reaches this length (paper: 8). */
  terminateThreshold: number;
}

export const DEFAULT_STUCK_CONFIG: StuckConfig = {
  repeatThreshold: 5,
  failThreshold: 5,
  terminateThreshold: 8,
};

export interface CallOutcome {
  isError: boolean;
  content: string;
  /** Permission denials do not count as failures (paper, Appendix A.4). */
  permissionDenied?: boolean;
}

export type StuckSignal =
  | { kind: 'repeat_reminder' | 'failing_reminder'; tool: string; count: number; text: string }
  | { kind: 'terminate'; tool: string; count: number };

/**
 * Detects streaks of identical tool calls: same tool name and byte-identical arguments.
 * A call with different arguments (for example a paginated read at a new offset) ends the
 * streak. One reminder is injected per streak; a growing identical *failing* streak ends
 * the run early instead of grinding to the step budget.
 */
export class StuckDetector {
  private lastKey: string | undefined;
  private streak = 0;
  private failStreak = 0;
  private lastErrorHash: string | undefined;
  private reminded = false;

  constructor(private readonly config: StuckConfig = DEFAULT_STUCK_CONFIG) {}

  observe(call: { name: string; input: unknown }, outcome: CallOutcome): StuckSignal | null {
    const key = `${call.name}\u0000${stableStringify(call.input ?? null)}`;
    if (key === this.lastKey) {
      this.streak++;
    } else {
      this.lastKey = key;
      this.streak = 1;
      this.failStreak = 0;
      this.lastErrorHash = undefined;
      this.reminded = false;
    }

    if (outcome.isError && !outcome.permissionDenied) {
      const errHash = sha256(outcome.content);
      // "Keeps failing the same way": a different error message restarts the failing count.
      this.failStreak = this.failStreak > 0 && errHash === this.lastErrorHash ? this.failStreak + 1 : 1;
      this.lastErrorHash = errHash;
    } else if (!outcome.permissionDenied) {
      this.failStreak = 0;
      this.lastErrorHash = undefined;
    }

    if (this.failStreak >= this.config.terminateThreshold) {
      return { kind: 'terminate', tool: call.name, count: this.failStreak };
    }
    if (!this.reminded) {
      if (this.failStreak >= this.config.failThreshold) {
        this.reminded = true;
        return {
          kind: 'failing_reminder',
          tool: call.name,
          count: this.streak,
          text: stuckFailingReminder(call.name, this.streak),
        };
      }
      if (this.streak >= this.config.repeatThreshold) {
        this.reminded = true;
        return {
          kind: 'repeat_reminder',
          tool: call.name,
          count: this.streak,
          text: stuckRepeatReminder(call.name, this.streak),
        };
      }
    }
    return null;
  }

  get state(): { streak: number; failStreak: number } {
    return { streak: this.streak, failStreak: this.failStreak };
  }
}
