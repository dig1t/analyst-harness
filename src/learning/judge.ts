import type { AgentEvent, RunResult } from '../core/agent-loop';
import { completeText, extractJson, type LLMProvider } from '../llm/provider';
import type { PriceBook } from '../llm/pricing';
import { truncateMiddle } from '../util/text';
import type { JudgeVerdict } from './run-store';
import { FAILURE_STAGES, type Phase } from './taxonomy';

export const JUDGE_PROMPT = `You are grading a data analyst agent's run. Decide whether the final answer correctly and fully completes the task, using only the evidence in the trajectory digest. Judge by what the tools actually returned, not by what the agent claims.

Score from 0.0 to 1.0:
- 1.0: the task is fully done, every reported number is backed by tool output, and the result was verified.
- 0.5: partially done, done without any verification, or done with minor errors.
- 0.0: not done, wrong, or containing figures that no tool output supports (fabrication).

If the score is below 0.8, also pick the SINGLE EARLIEST stage where the run went wrong, in this order:
data_acquisition -> data_understanding -> analysis_implementation -> verification -> reporting
- data_acquisition: never obtained the needed data (wrong source, failed fetch or scrape, wrong file).
- data_understanding: had the data but misread its structure (wrong columns, units, types, joins, filters).
- analysis_implementation: computed the wrong thing, or computed it incorrectly.
- verification: likely correct but never checked, or misread a check.
- reporting: correct work, but the final answer misstates, omits or invents results.

Respond with ONLY a JSON object (no preamble, no code fence):
{"score": <0.0-1.0>, "verdict": "success" | "partial" | "failure", "failure_stage": "<stage>" | null, "reason": "<one or two sentences>"}`;

export function trajectoryDigest(events: AgentEvent[], maxChars = 12_000): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === 'llm_response') {
      if (e.text.trim()) lines.push(`[step ${e.step} assistant] ${truncateMiddle(e.text.trim(), 400)}`);
      for (const c of e.toolCalls)
        lines.push(`[step ${e.step} call ${c.name}] ${truncateMiddle(JSON.stringify(c.input), 200)}`);
    } else if (e.type === 'tool_result') {
      lines.push(
        `[step ${e.step} result ${e.name}${e.isError ? ' ERROR' : ''}] ${truncateMiddle(e.preview.replace(/\s+/g, ' '), 240)}`,
      );
    } else if (e.type === 'context') {
      lines.push(
        `[step ${e.step} context ${e.event.action}] ${e.event.tokensBefore} -> ${e.event.tokensAfter} tokens`,
      );
    } else if (e.type === 'stuck') {
      lines.push(`[step ${e.step} stuck ${e.kind}] ${e.tool} x${e.count}`);
    }
  }
  return truncateMiddle(lines.join('\n'), maxChars, 0.5);
}

export function heuristicVerdict(result: RunResult, phases: Phase[]): JudgeVerdict {
  if (result.outcome !== 'completed') {
    const score = result.outcome === 'max_steps' || result.outcome === 'budget_exceeded' ? 0.1 : 0;
    const stage =
      result.toolCalls === 0
        ? 'data_acquisition'
        : phases.includes('M')
          ? 'verification'
          : 'analysis_implementation';
    return {
      score,
      verdict: 'failure',
      failureStage: stage,
      reason: `run ended with outcome ${result.outcome}`,
      judgedBy: 'heuristic',
    };
  }
  if (!result.finalText.trim())
    return {
      score: 0.2,
      verdict: 'failure',
      failureStage: 'reporting',
      reason: 'completed without a final answer',
      judgedBy: 'heuristic',
    };
  const verified = phases.includes('V');
  const score = verified ? 0.7 : 0.55;
  return {
    score,
    verdict: 'partial',
    failureStage: verified ? undefined : 'verification',
    reason: verified
      ? 'completed with a verification step (unjudged)'
      : 'completed without an explicit verification step (unjudged)',
    judgedBy: 'heuristic',
  };
}

export interface JudgeOptions {
  provider: LLMProvider;
  model: string;
  priceBook?: PriceBook;
}

/** LLM judge for run outcomes and failure-stage attribution, with a heuristic fallback. */
export class RunJudge {
  constructor(private readonly opts: JudgeOptions) {}

  async judge(
    result: RunResult,
    events: AgentEvent[],
    phases: Phase[],
  ): Promise<{ verdict: JudgeVerdict; costUsd: number }> {
    const prompt = `<task>\n${result.task}\n</task>\n\n<outcome>${result.outcome}${result.error ? `: ${result.error}` : ''}</outcome>\n<phases>${phases.join('')}</phases>\n\n<trajectory_digest>\n${trajectoryDigest(events)}\n</trajectory_digest>\n\n<final_answer>\n${truncateMiddle(result.finalText, 6_000)}\n</final_answer>`;
    try {
      const { text, response } = await completeText(this.opts.provider, {
        model: this.opts.model,
        system: JUDGE_PROMPT,
        prompt,
        maxTokens: 4_000,
        effort: 'low',
        purpose: 'judge',
      });
      const costUsd = this.opts.priceBook?.costOf(response) ?? 0;
      const parsed = extractJson<{
        score?: unknown;
        verdict?: unknown;
        failure_stage?: unknown;
        reason?: unknown;
      }>(text);
      const score = typeof parsed?.score === 'number' ? Math.min(1, Math.max(0, parsed.score)) : undefined;
      if (score === undefined) return { verdict: heuristicVerdict(result, phases), costUsd };
      const verdict =
        parsed?.verdict === 'success' || parsed?.verdict === 'partial' || parsed?.verdict === 'failure'
          ? parsed.verdict
          : score >= 0.8
            ? 'success'
            : score >= 0.4
              ? 'partial'
              : 'failure';
      const stage =
        typeof parsed?.failure_stage === 'string' &&
        (FAILURE_STAGES as readonly string[]).includes(parsed.failure_stage)
          ? parsed.failure_stage
          : undefined;
      return {
        verdict: {
          score,
          verdict,
          failureStage: score < 0.8 ? stage : undefined,
          reason: typeof parsed?.reason === 'string' ? parsed.reason : '',
          judgedBy: 'llm',
        },
        costUsd,
      };
    } catch {
      return { verdict: heuristicVerdict(result, phases), costUsd: 0 };
    }
  }
}
