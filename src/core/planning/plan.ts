import { z } from 'zod';

export const PlanItemSchema = z.object({
  content: z.string().min(1).describe("Imperative description, e.g. 'Load the sales CSV'"),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().min(1).describe("Present-continuous form, e.g. 'Loading the sales CSV'"),
});

export type PlanItem = z.infer<typeof PlanItemSchema>;

export interface PlanValidation {
  ok: boolean;
  error?: string;
}

/** In-memory plan for one run (the update_plan tool touches no files). */
export class PlanState {
  private items: PlanItem[] = [];
  private updates = 0;

  get current(): readonly PlanItem[] {
    return this.items;
  }

  get exists(): boolean {
    return this.items.length > 0;
  }

  get updateCount(): number {
    return this.updates;
  }

  static validate(items: PlanItem[]): PlanValidation {
    if (items.length === 0) return { ok: false, error: 'The plan must contain at least one item.' };
    const active = items.filter((i) => i.status === 'in_progress').length;
    if (active > 1) {
      return {
        ok: false,
        error: `Exactly ONE task may be in_progress at a time, but ${active} are. Re-send the COMPLETE list with a single in_progress task.`,
      };
    }
    return { ok: true };
  }

  /** Replace the whole plan (the protocol requires the complete list on every call). */
  replace(items: PlanItem[]): PlanValidation {
    const v = PlanState.validate(items);
    if (!v.ok) return v;
    this.items = items.map((i) => ({ ...i }));
    this.updates++;
    return v;
  }

  render(): string {
    if (this.items.length === 0) return '(no plan)';
    const mark = { pending: '[ ]', in_progress: '[>]', completed: '[x]' } as const;
    return this.items.map((i, n) => `${n + 1}. ${mark[i.status]} ${i.content}`).join('\n');
  }

  progress(): { done: number; total: number } {
    return { done: this.items.filter((i) => i.status === 'completed').length, total: this.items.length };
  }
}
