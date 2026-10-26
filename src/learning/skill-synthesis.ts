import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, RunResult } from '../core/agent-loop';
import { completeText, type LLMProvider } from '../llm/provider';
import type { PriceBook } from '../llm/pricing';
import { SkillFrontmatterSchema } from '../skills/registry';
import { ensureDir, readJson, writeJsonAtomic } from '../util/fs';
import { parseFrontmatter } from '../util/frontmatter';
import { truncateMiddle } from '../util/text';
import { trajectoryDigest } from './judge';

export const SYNTHESIS_PROMPT = `You turn a successful data analyst agent run into a reusable skill: a SKILL.md file in the Agent Skills format that another agent can follow to do the same kind of task faster next time.

Requirements:
- Start with YAML frontmatter containing exactly two keys: name (lowercase letters, digits and hyphens, at most 64 characters) and description (one or two sentences that say what the skill does AND when to use it, so an agent can decide to load it).
- Then a Markdown body with: a one-paragraph overview, numbered steps (concrete commands, queries, file paths and checks taken from the run), a "Verification" section and a "Pitfalls" section with what went wrong in the run and how it was fixed.
- Generalize away one-off details (specific dates, ids) unless they are the point of the skill.
- Never use the em dash character.

Respond with ONLY the SKILL.md content.`;

export interface SkillProposal {
  name: string;
  runId: string;
  createdAt: string;
  description: string;
  dir: string;
}

/**
 * Drafts new skills from successful runs into skills/proposed/<name>/. Proposals never load
 * automatically: a human approves them (Discord `/skills approve`), which moves them to
 * skills/learned/ where the skill registry picks them up.
 */
export class SkillSynthesizer {
  constructor(
    readonly skillsRoot: string,
    private readonly provider?: LLMProvider,
    private readonly model?: string,
    private readonly priceBook?: PriceBook,
  ) {}

  get proposedDir(): string {
    return path.join(this.skillsRoot, 'proposed');
  }

  get learnedDir(): string {
    return path.join(this.skillsRoot, 'learned');
  }

  async propose(
    result: RunResult,
    events: AgentEvent[],
  ): Promise<{ proposal?: SkillProposal; costUsd: number; error?: string }> {
    if (!this.provider || !this.model)
      return { costUsd: 0, error: 'no model configured for skill synthesis' };
    const prompt = `<task>\n${result.task}\n</task>\n<plan>\n${result.plan}\n</plan>\n<trajectory_digest>\n${trajectoryDigest(events, 12_000)}\n</trajectory_digest>\n<final_answer>\n${truncateMiddle(result.finalText, 3_000)}\n</final_answer>`;
    const { text, response } = await completeText(this.provider, {
      model: this.model,
      system: SYNTHESIS_PROMPT,
      prompt,
      maxTokens: 8_000,
      effort: 'medium',
      purpose: 'synthesize',
    });
    const costUsd = this.priceBook?.costOf(response) ?? 0;
    const content = text
      .replace(/^```(?:markdown|md)?\s*\n/, '')
      .replace(/\n```\s*$/, '')
      .replace(/\u2014/g, ', ');
    let doc;
    try {
      doc = parseFrontmatter(content);
    } catch (err) {
      return { costUsd, error: `invalid frontmatter: ${(err as Error).message}` };
    }
    const fm = SkillFrontmatterSchema.safeParse(doc.data);
    if (!fm.success)
      return {
        costUsd,
        error: `invalid skill frontmatter: ${fm.error.issues.map((i) => i.message).join('; ')}`,
      };
    const name = fm.data.name;
    if (await this.exists(name)) return { costUsd, error: `a skill named ${name} already exists` };
    const dir = path.join(this.proposedDir, name);
    await ensureDir(dir);
    await fsp.writeFile(
      path.join(dir, 'SKILL.md'),
      content.endsWith('\n') ? content : content + '\n',
      'utf8',
    );
    const proposal: SkillProposal = {
      name,
      runId: result.runId,
      createdAt: new Date().toISOString(),
      description: fm.data.description,
      dir,
    };
    await writeJsonAtomic(path.join(dir, 'PROPOSAL.json'), proposal);
    return { proposal, costUsd };
  }

  private async exists(name: string): Promise<boolean> {
    for (const base of [this.proposedDir, this.learnedDir]) {
      if (
        await fsp.access(path.join(base, name)).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    return false;
  }

  async list(): Promise<SkillProposal[]> {
    let names: string[];
    try {
      names = await fsp.readdir(this.proposedDir);
    } catch {
      return [];
    }
    const out: SkillProposal[] = [];
    for (const n of names.sort()) {
      const p = await readJson<SkillProposal | undefined>(
        path.join(this.proposedDir, n, 'PROPOSAL.json'),
        undefined,
      );
      if (p) out.push(p);
    }
    return out;
  }

  private checkName(name: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(name)) throw new Error(`invalid skill name ${name}`);
  }

  async approve(name: string): Promise<string> {
    this.checkName(name);
    const from = path.join(this.proposedDir, name);
    const to = path.join(this.learnedDir, name);
    await fsp.access(path.join(from, 'SKILL.md'));
    await ensureDir(this.learnedDir);
    await fsp.rename(from, to);
    return to;
  }

  async reject(name: string): Promise<void> {
    this.checkName(name);
    await fsp.rm(path.join(this.proposedDir, name), { recursive: true, force: true });
  }
}
