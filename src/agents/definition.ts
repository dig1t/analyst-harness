import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { parseFrontmatter } from '../util/frontmatter';
import { ConfigError } from '../util/errors';

export const AgentFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'lowercase letters, digits and hyphens'),
  description: z.string().min(1).max(1024),
  model: z.string().optional(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  /** Tool allow-list; omit for every tool. */
  tools: z.array(z.string()).optional(),
  /** Profile id, or "auto" to let the profile bandit choose. */
  profile: z.string().optional(),
  max_steps: z.number().int().min(1).max(1000).optional(),
  budget_usd: z.number().positive().optional(),
  /** Access to the knowledge vault and skills library inside the workspace. */
  knowledge: z.enum(['ro', 'rw', 'none']).optional(),
  skills: z.enum(['ro', 'rw', 'none']).optional(),
  /** Access to the scraper spec folder (config/scrapers), mounted as `scrapers/`. */
  scrapers: z.enum(['ro', 'rw', 'none']).optional(),
  /** Skills to list in the system prompt; omit for all. */
  skill_filter: z.array(z.string()).optional(),
});

export interface AgentDefinition {
  name: string;
  description: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  tools?: string[];
  profile?: string;
  maxSteps?: number;
  budgetUsd?: number;
  knowledge: 'ro' | 'rw' | 'none';
  skills: 'ro' | 'rw' | 'none';
  scrapers: 'ro' | 'rw' | 'none';
  skillFilter?: string[];
  systemPrompt: string;
  source?: string;
}

export function parseAgentDefinition(text: string, source?: string): AgentDefinition {
  let doc;
  try {
    doc = parseFrontmatter(text);
  } catch (err) {
    throw new ConfigError(
      `Invalid YAML frontmatter in ${source ?? 'agent definition'}: ${(err as Error).message}`,
    );
  }
  const parsed = AgentFrontmatterSchema.safeParse(doc.data);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid agent definition ${source ?? ''}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  const fm = parsed.data;
  return {
    name: fm.name,
    description: fm.description,
    model: fm.model,
    effort: fm.effort,
    tools: fm.tools,
    profile: fm.profile,
    maxSteps: fm.max_steps,
    budgetUsd: fm.budget_usd,
    knowledge: fm.knowledge ?? 'ro',
    skills: fm.skills ?? 'ro',
    scrapers: fm.scrapers ?? 'ro',
    skillFilter: fm.skill_filter,
    systemPrompt: doc.body.trim(),
    source,
  };
}

/** Load every `*.md` agent definition in a directory. */
export async function loadAgents(dir: string): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir))
      .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
      .sort();
  } catch {
    return agents;
  }
  for (const file of entries) {
    const full = path.join(dir, file);
    const def = parseAgentDefinition(await fsp.readFile(full, 'utf8'), full);
    if (agents.has(def.name)) throw new ConfigError(`Duplicate agent name "${def.name}" in ${full}`);
    agents.set(def.name, def);
  }
  return agents;
}

/** Minimal built-in analyst used when no agents directory exists. */
export const FALLBACK_AGENT: AgentDefinition = {
  name: 'analyst',
  description: 'General data analyst agent.',
  knowledge: 'ro',
  skills: 'ro',
  scrapers: 'ro',
  systemPrompt: 'You answer data questions with evidence from tools.',
};
