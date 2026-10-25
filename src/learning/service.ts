import type { Logger } from '../util/logger';
import { silentLogger } from '../util/logger';
import { ProfileBandit } from './bandit';
import { heuristicVerdict, type RunJudge } from './judge';
import type { Reflector } from './reflection';
import type { RunMeta, RunStore } from './run-store';
import type { SkillSynthesizer } from './skill-synthesis';
import { labelTrajectory, phaseHistogram } from './taxonomy';
import type { BudgetGuard } from '../core/agent-loop';

export interface LearningConfig {
  /** Grade runs with the LLM judge; otherwise a heuristic grade is used. */
  judge: boolean;
  reflect: 'always' | 'failures' | 'never';
  proposeSkills: boolean;
  minStepsForSkill: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  judge: true,
  reflect: 'failures',
  proposeSkills: true,
  minStepsForSkill: 6,
};

export interface LearningDeps {
  runs: RunStore;
  bandit: ProfileBandit;
  judge?: RunJudge;
  reflector?: Reflector;
  synthesizer?: SkillSynthesizer;
  config?: LearningConfig;
  budget?: BudgetGuard;
  logger?: Logger;
}

/**
 * The self-learning loop that runs after each agent run (or nightly for stragglers):
 * 1. label the trajectory with phases (rule-based, as in the paper's trajectory analysis);
 * 2. grade the outcome and attribute the earliest failed stage (LLM judge or heuristic);
 * 3. update the profile bandit with reward and cost, so profile choice adapts per model and task type;
 * 4. reflect into lessons in the knowledge vault, retrieved for similar future tasks;
 * 5. propose a reusable skill from successful multi-step runs, pending human approval.
 */
export class LearningService {
  private readonly config: LearningConfig;
  private readonly logger: Logger;

  constructor(private readonly deps: LearningDeps) {
    this.config = deps.config ?? DEFAULT_LEARNING_CONFIG;
    this.logger = deps.logger ?? silentLogger;
  }

  get bandit(): ProfileBandit {
    return this.deps.bandit;
  }

  private affordable(): boolean {
    return !this.deps.budget?.exceeded(0);
  }

  async process(meta: RunMeta): Promise<RunMeta> {
    const { runs, bandit } = this.deps;
    const result = meta.result;
    const events = await runs.events(result.runId);
    const phases = labelTrajectory(events);
    let verdict = heuristicVerdict(result, phases);
    if (this.config.judge && this.deps.judge && this.affordable() && result.outcome !== 'aborted') {
      const judged = await this.deps.judge.judge(result, events, phases);
      verdict = judged.verdict;
      this.deps.budget?.record(judged.costUsd);
    }
    const reward = meta.feedback ? (meta.feedback.value === 'up' ? 1 : 0) : verdict.score;
    const context = ProfileBandit.contextKey(result.model, meta.taskType);
    if (result.outcome !== 'aborted') await bandit.update(context, result.profileId, reward, result.costUsd);

    let lessons: string[] = [];
    const shouldReflect =
      this.config.reflect === 'always' || (this.config.reflect === 'failures' && verdict.score < 0.8);
    if (shouldReflect && this.deps.reflector && this.affordable() && result.outcome !== 'aborted') {
      try {
        const r = await this.deps.reflector.reflect(result, events, verdict);
        lessons = r.lessons;
        this.deps.budget?.record(r.costUsd);
      } catch (err) {
        this.logger.warn('reflection failed', { err, runId: result.runId });
      }
    }

    let skillProposal: string | undefined;
    if (
      this.config.proposeSkills &&
      this.deps.synthesizer &&
      verdict.verdict === 'success' &&
      result.steps >= this.config.minStepsForSkill &&
      this.affordable()
    ) {
      try {
        const s = await this.deps.synthesizer.propose(result, events);
        this.deps.budget?.record(s.costUsd);
        skillProposal = s.proposal?.name;
        if (s.error) this.logger.info('no skill proposed', { reason: s.error, runId: result.runId });
      } catch (err) {
        this.logger.warn('skill synthesis failed', { err, runId: result.runId });
      }
    }

    const hist = phaseHistogram(phases);
    this.logger.info('learned from run', {
      runId: result.runId,
      verdict: verdict.verdict,
      score: verdict.score,
      phases: phases.join(''),
      hist,
      lessons: lessons.length,
      skillProposal,
    });
    const next: RunMeta = {
      ...meta,
      phases: phases.join(''),
      judge: verdict,
      learned: { at: new Date().toISOString(), lessons, banditReward: reward, skillProposal },
    };
    await runs.saveMeta(next);
    return next;
  }

  async feedback(runId: string, value: 'up' | 'down', by?: string): Promise<RunMeta | undefined> {
    const meta = await this.deps.runs.updateMeta(runId, (m) => ({
      ...m,
      feedback: { value, by, at: new Date().toISOString() },
    }));
    if (!meta) return undefined;
    await this.deps.bandit.feedback(
      ProfileBandit.contextKey(meta.result.model, meta.taskType),
      meta.result.profileId,
      value === 'up',
    );
    return meta;
  }

  async processPending(limit = 20): Promise<number> {
    const pending = await this.deps.runs.unlearned(limit);
    for (const meta of pending) {
      try {
        await this.process(meta);
      } catch (err) {
        this.logger.warn('learning failed', { err, runId: meta.result.runId });
      }
    }
    return pending.length;
  }
}
