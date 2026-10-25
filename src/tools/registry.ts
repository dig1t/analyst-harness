import { z } from 'zod';
import { TOOL_RULES_FOOTER, TOOL_RULES_HEADER } from '../core/prompts';
import type { ToolSchema } from '../core/types';
import type { ToolDefinition } from './types';

export interface ToolSelection {
  actionSpace: 'tools' | 'bash';
  planning: boolean;
  recall: boolean;
  /** Optional allow-list from the agent definition. */
  allow?: string[];
}

/** JSON Schema for a tool input, in the shape the Messages API expects for `input_schema`. */
export function toInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object')
    throw new Error('Tool input schemas must be zod objects (the Messages API requires an object schema).');
  return json;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition<unknown>>();

  constructor(defs: Array<ToolDefinition<never>> = []) {
    for (const d of defs) this.register(d);
  }

  register<I>(def: ToolDefinition<I>): this {
    if (this.tools.has(def.name)) throw new Error(`Duplicate tool name: ${def.name}`);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(def.name)) throw new Error(`Invalid tool name: ${def.name}`);
    this.tools.set(def.name, def as unknown as ToolDefinition<unknown>);
    return this;
  }

  get(name: string): ToolDefinition<unknown> | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolDefinition<unknown>[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * The active registry for one run. The bash-only action space keeps `bash` plus the
   * auxiliary tools of the enabled components (update_plan with planning, recall_event with
   * recall), exactly as in the paper's action-space ablation.
   */
  select(sel: ToolSelection): ToolRegistry {
    const out = new ToolRegistry();
    for (const def of this.tools.values()) {
      if (sel.allow && !sel.allow.includes(def.name)) continue;
      if (def.name === 'update_plan' && !sel.planning) continue;
      if (def.name === 'recall_event' && !sel.recall) continue;
      if (sel.actionSpace === 'bash' && def.category === 'workspace') continue;
      out.register(def);
    }
    return out;
  }

  schemas(): ToolSchema[] {
    // Deterministic order keeps the prompt-cache prefix stable across requests.
    return [...this.tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ name: d.name, description: d.description, inputSchema: toInputSchema(d.schema) }));
  }

  /** The "Tool Usage Rules" block, generated from the active registry (paper, Figures 13 and 14). */
  usageRules(): string {
    const rules = [...this.tools.values()]
      .filter((d) => d.usageRule)
      .map((d) => `- ${d.name}: ${d.usageRule}`);
    const readOnly = [...this.tools.values()].filter((d) => d.readOnly).map((d) => d.name);
    const parallel =
      readOnly.length > 1
        ? [
            `- Read-only tools (${readOnly.join(', ')}) can be called in PARALLEL: issue multiple in a single response when exploring.`,
          ]
        : [];
    return [TOOL_RULES_HEADER, '', ...parallel, ...rules, '', TOOL_RULES_FOOTER].join('\n');
  }
}
