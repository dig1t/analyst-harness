import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SkillInfo, SkillService } from '../tools/types';
import { walkFiles } from '../util/fs';
import { parseFrontmatter } from '../util/frontmatter';
import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';

/** Agent Skills frontmatter (name and description are required; other keys pass through). */
export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, 'name must be lowercase letters, digits and hyphens (max 64)'),
    description: z.string().min(1).max(1024),
  })
  .passthrough();

export interface Skill extends SkillInfo {
  dir: string;
  /** Path of the skill folder relative to the skills root. */
  relDir: string;
  frontmatter: Record<string, unknown>;
  learned: boolean;
}

export interface SkillLoadIssue {
  file: string;
  message: string;
}

/**
 * Loads SKILL.md folders (the Agent Skills layout also used by Claude Code). Only names and
 * descriptions go into the system prompt; the body loads on demand through load_skill
 * (progressive disclosure). Folders under `proposed/` are drafts awaiting human approval.
 */
export class SkillRegistry implements SkillService {
  private readonly skills = new Map<string, Skill>();
  readonly issues: SkillLoadIssue[] = [];

  constructor(
    readonly root: string,
    /** Workspace alias under which the skills folder is mounted (for bundled file paths). */
    readonly mountAlias = 'skills',
    private readonly logger: Logger = silentLogger,
    /** Extra roots, such as a writable data folder holding learned skills, each with its alias. */
    readonly extraRoots: Array<{ dir: string; alias: string }> = [],
  ) {}

  static async load(
    root: string,
    mountAlias = 'skills',
    logger?: Logger,
    extraRoots: Array<{ dir: string; alias: string }> = [],
  ): Promise<SkillRegistry> {
    const reg = new SkillRegistry(root, mountAlias, logger, extraRoots);
    await reg.reload();
    return reg;
  }

  async reload(): Promise<void> {
    this.skills.clear();
    this.issues.length = 0;
    const roots = [
      { dir: this.root, alias: this.mountAlias, extra: false },
      ...this.extraRoots.map((r) => ({ ...r, extra: true })),
    ];
    for (const root of roots) await this.loadRoot(root.dir, root.alias, root.extra);
    for (const issue of this.issues) this.logger.warn('skill skipped', { ...issue });
  }

  private async loadRoot(rootDir: string, alias: string, extra: boolean): Promise<void> {
    const skip = (rel: string) =>
      rel.split('/').some((s) => s === 'proposed' || s === 'node_modules' || s.startsWith('.'));
    const files = await walkFiles(rootDir, skip);
    for (const rel of files.filter((f) => path.posix.basename(f) === 'SKILL.md')) {
      const abs = path.join(rootDir, rel);
      const label = extra ? `${alias}/${rel}` : rel;
      try {
        const doc = parseFrontmatter(await fsp.readFile(abs, 'utf8'));
        const parsed = SkillFrontmatterSchema.safeParse(doc.data);
        if (!parsed.success) {
          this.issues.push({ file: label, message: parsed.error.issues.map((i) => i.message).join('; ') });
          continue;
        }
        const relDir = path.posix.dirname(rel);
        if (this.skills.has(parsed.data.name)) {
          this.issues.push({
            file: label,
            message: `duplicate skill name "${parsed.data.name}" (kept ${this.skills.get(parsed.data.name)!.relDir})`,
          });
          continue;
        }
        const dir = path.join(rootDir, relDir);
        const bundled = (await walkFiles(dir)).filter((f) => f !== 'SKILL.md' && !f.startsWith('.'));
        this.skills.set(parsed.data.name, {
          name: parsed.data.name,
          description: parsed.data.description,
          body: doc.body,
          files: bundled.map((f) => `${alias}/${relDir}/${f}`),
          dir,
          relDir,
          frontmatter: doc.data,
          learned: extra || relDir.split('/')[0] === 'learned',
        });
      } catch (err) {
        this.issues.push({ file: label, message: (err as Error).message });
      }
    }
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  list(): Array<{ name: string; description: string }> {
    return [...this.skills.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ name: s.name, description: s.description }));
  }

  all(): Skill[] {
    return [...this.skills.values()];
  }

  /** The system-prompt block listing available skills. */
  indexBlock(filter?: string[]): string {
    const entries = this.list().filter((s) => !filter || filter.includes(s.name));
    if (entries.length === 0) return '';
    const lines = entries.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}`);
    return `# Skills\n\nSkills are packaged procedures. When a task matches a skill's description, call load_skill with its name before acting, then follow it. Bundled files live under ${this.mountAlias}/.\n\n${lines.join('\n')}`;
  }
}
