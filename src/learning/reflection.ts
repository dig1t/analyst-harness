import type { AgentEvent, RunResult } from '../core/agent-loop';
import type { KnowledgeVault } from '../knowledge/vault';
import { completeText, extractJson, type LLMProvider } from '../llm/provider';
import type { PriceBook } from '../llm/pricing';
import { tokenize } from '../knowledge/bm25';
import { truncateMiddle } from '../util/text';
import { trajectoryDigest } from './judge';
import type { JudgeVerdict } from './run-store';

export const REFLECTION_PROMPT = `You are the reflection step of a self-learning data analyst harness. Read one finished run and write down what future runs should do differently or keep doing. Lessons are stored in a knowledge vault and retrieved for similar tasks later.

Write 0 to 3 lessons. A good lesson is:
- specific and reusable (a site's pagination parameter, a dataset's quirk, a query pattern that worked, a tool misuse to avoid);
- grounded in this run (cite the step or the tool output that shows it);
- not generic advice (never "verify your work" or "read the docs").
Write no lesson if the run teaches nothing new.

Respond with ONLY a JSON object (no preamble, no code fence):
{"lessons": [{"title": "<imperative, under 80 chars>", "context": "<when this applies>", "lesson": "<what to do>", "evidence": "<what in this run shows it>", "tags": ["<topic>", "..."]}]}`;

export interface ReflectedLesson {
  title: string;
  context: string;
  lesson: string;
  evidence: string;
  tags: string[];
}

function jaccard(a: string, b: string): number {
  const x = new Set(tokenize(a));
  const y = new Set(tokenize(b));
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/**
 * Reflection turns trajectories into lessons (experiential memory) in the vault's lessons
 * topic, following the LLM-wiki pattern: the LLM writes and maintains, humans read. Near
 * duplicate titles reinforce the existing lesson instead of creating a new page.
 */
export class Reflector {
  constructor(
    private readonly provider: LLMProvider,
    private readonly model: string,
    private readonly vault: KnowledgeVault,
    private readonly priceBook?: PriceBook,
  ) {}

  async reflect(
    result: RunResult,
    events: AgentEvent[],
    verdict?: JudgeVerdict,
  ): Promise<{ lessons: string[]; costUsd: number }> {
    const prompt = `<task>\n${result.task}\n</task>\n<outcome>${result.outcome}; judge: ${verdict ? `${verdict.verdict} (${verdict.score.toFixed(2)})${verdict.failureStage ? `, failed at ${verdict.failureStage}` : ''}: ${verdict.reason}` : 'not judged'}</outcome>\n<profile>${result.profileId} on ${result.model}</profile>\n\n<trajectory_digest>\n${trajectoryDigest(events, 10_000)}\n</trajectory_digest>\n\n<final_answer>\n${truncateMiddle(result.finalText, 3_000)}\n</final_answer>`;
    let costUsd = 0;
    let parsed: { lessons?: Array<Partial<ReflectedLesson>> } | undefined;
    try {
      const { text, response } = await completeText(this.provider, {
        model: this.model,
        system: REFLECTION_PROMPT,
        prompt,
        maxTokens: 4_000,
        effort: 'low',
        purpose: 'reflect',
      });
      costUsd = this.priceBook?.cost(response.model, response.usage) ?? 0;
      parsed = extractJson(text);
    } catch {
      return { lessons: [], costUsd };
    }
    const lessons = (parsed?.lessons ?? [])
      .filter(
        (l): l is ReflectedLesson =>
          typeof l?.title === 'string' && typeof l.lesson === 'string' && l.title.trim().length > 3,
      )
      .slice(0, 3);
    const existing = (await this.vault.articles()).filter((a) => a.topic === 'lessons');
    const written: string[] = [];
    for (const l of lessons) {
      const duplicate = existing.find((a) => jaccard(a.title.replace(/^Lesson:\s*/i, ''), l.title) >= 0.6);
      const title = duplicate ? duplicate.title.replace(/^Lesson:\s*/i, '') : l.title;
      const res = await this.vault.writeLesson({
        title,
        context: l.context ?? '',
        lesson: l.lesson,
        evidence: l.evidence ?? '',
        tags: Array.isArray(l.tags) ? l.tags.map(String) : [],
        runId: result.runId,
      });
      written.push(res.path);
      const rel = res.path.replace(/^wiki\//, '');
      await this.vault.upsertIndexRow(
        'lessons',
        rel,
        `Lesson: ${title}`,
        l.lesson.split(/(?<=[.!?])\s/)[0] ?? l.lesson,
        new Date().toISOString().slice(0, 10),
      );
    }
    if (written.length)
      await this.vault.appendLog(
        `lessons | ${written.length} lesson${written.length === 1 ? '' : 's'} from run ${result.runId}`,
        written,
      );
    return { lessons: written, costUsd };
  }

  /** Lessons relevant to a new task, formatted as a system-prompt block. */
  async relevantLessons(task: string, limit = 3): Promise<string> {
    const hits = await this.vault.search(task, { topic: 'lessons', limit });
    if (hits.length === 0) return '';
    return `# Lessons from past runs\n\nThese were learned by this harness on similar tasks. Apply them when they fit; they are advisory.\n\n${hits.map((h) => `- ${h.title} (${h.path}): ${h.snippet}`).join('\n')}`;
  }
}
