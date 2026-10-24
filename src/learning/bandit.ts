import { readJson, writeJsonAtomic } from '../util/fs';

export interface ArmStats {
  alpha: number;
  beta: number;
  pulls: number;
  totalCostUsd: number;
  totalReward: number;
}

export interface BanditState {
  version: 1;
  contexts: Record<string, Record<string, ArmStats>>;
}

export interface BanditOptions {
  /** Weight of normalized cost in the utility (0 ignores cost). */
  costWeight: number;
  /** Cost (USD) treated as "expensive" when normalizing. */
  costScaleUsd: number;
  /** Pseudo-counts for profiles before any data, e.g. favour the paper's baseline. */
  priors: Record<string, { alpha: number; beta: number }>;
}

export const DEFAULT_BANDIT_OPTIONS: BanditOptions = {
  costWeight: 0.15,
  costScaleUsd: 1,
  priors: { 't4-plan-tools-128k': { alpha: 2, beta: 1 } },
};

/** Marsaglia-Tsang gamma sampler (shape >= 1, with the boost for shape < 1). */
function sampleGamma(shape: number, rand: () => number): number {
  if (shape < 1) return sampleGamma(shape + 1, rand) * Math.pow(rand() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller standard normal
      const u1 = rand() || 1e-12;
      const u2 = rand();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rand() || 1e-12;
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export function sampleBeta(alpha: number, beta: number, rand: () => number = Math.random): number {
  const x = sampleGamma(alpha, rand);
  const y = sampleGamma(beta, rand);
  return x / (x + y);
}

/** Small deterministic PRNG (mulberry32) for reproducible selection in tests. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Thompson-sampling bandit over harness profiles, keyed by (model, task type). The paper
 * shows the best planning/action-space/context setting depends on model capability, task
 * type and budget; this learns that mapping online from the harness's own runs. Rewards are
 * fractional successes in [0, 1] from the judge or from human feedback; cost enters the
 * utility as a penalty so cheaper profiles win ties.
 */
export class ProfileBandit {
  private state: BanditState = { version: 1, contexts: {} };
  private chain = Promise.resolve();

  constructor(
    private readonly file?: string,
    readonly options: BanditOptions = DEFAULT_BANDIT_OPTIONS,
  ) {}

  static contextKey(model: string, taskType: string): string {
    return `${model}|${taskType}`;
  }

  async load(): Promise<this> {
    if (this.file) this.state = await readJson<BanditState>(this.file, { version: 1, contexts: {} });
    return this;
  }

  private persist(): Promise<void> {
    if (!this.file) return Promise.resolve();
    const file = this.file;
    const snapshot = structuredClone(this.state);
    this.chain = this.chain.then(() => writeJsonAtomic(file, snapshot)).catch(() => undefined);
    return this.chain;
  }

  arm(context: string, profileId: string): ArmStats {
    const ctx = (this.state.contexts[context] ??= {});
    if (!ctx[profileId]) {
      const prior = this.options.priors[profileId] ?? { alpha: 1, beta: 1 };
      ctx[profileId] = { alpha: prior.alpha, beta: prior.beta, pulls: 0, totalCostUsd: 0, totalReward: 0 };
    }
    return ctx[profileId]!;
  }

  utility(stats: ArmStats, sampledSuccess: number): number {
    const avgCost = stats.pulls > 0 ? stats.totalCostUsd / stats.pulls : 0;
    return sampledSuccess - this.options.costWeight * Math.min(1, avgCost / this.options.costScaleUsd);
  }

  select(
    context: string,
    candidates: string[],
    rand: () => number = Math.random,
  ): { profileId: string; samples: Record<string, number> } {
    if (candidates.length === 0) throw new Error('no candidate profiles');
    const samples: Record<string, number> = {};
    let best = candidates[0]!;
    let bestUtility = -Infinity;
    for (const id of candidates) {
      const stats = this.arm(context, id);
      const u = this.utility(stats, sampleBeta(stats.alpha, stats.beta, rand));
      samples[id] = u;
      if (u > bestUtility) {
        bestUtility = u;
        best = id;
      }
    }
    return { profileId: best, samples };
  }

  async update(
    context: string,
    profileId: string,
    reward: number,
    costUsd: number,
    weight = 1,
  ): Promise<ArmStats> {
    const r = Math.min(1, Math.max(0, reward));
    const stats = this.arm(context, profileId);
    stats.alpha += r * weight;
    stats.beta += (1 - r) * weight;
    stats.pulls += 1;
    stats.totalCostUsd += Math.max(0, costUsd);
    stats.totalReward += r;
    await this.persist();
    return stats;
  }

  /** Human feedback: a strong extra observation without counting another pull or cost. */
  async feedback(context: string, profileId: string, positive: boolean, weight = 2): Promise<ArmStats> {
    const stats = this.arm(context, profileId);
    if (positive) stats.alpha += weight;
    else stats.beta += weight;
    await this.persist();
    return stats;
  }

  summary(
    context?: string,
  ): Array<{ context: string; profileId: string; mean: number; pulls: number; avgCostUsd: number }> {
    const rows = [];
    for (const [ctx, arms] of Object.entries(this.state.contexts)) {
      if (context && ctx !== context) continue;
      for (const [profileId, s] of Object.entries(arms)) {
        rows.push({
          context: ctx,
          profileId,
          mean: s.alpha / (s.alpha + s.beta),
          pulls: s.pulls,
          avgCostUsd: s.pulls ? s.totalCostUsd / s.pulls : 0,
        });
      }
    }
    return rows.sort((a, b) => a.context.localeCompare(b.context) || b.mean - a.mean);
  }

  get snapshot(): BanditState {
    return structuredClone(this.state);
  }

  async flush(): Promise<void> {
    await this.chain;
  }
}
