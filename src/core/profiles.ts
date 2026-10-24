import type { ContextTier } from './context/manager';
import { DEFAULT_STUCK_CONFIG, type StuckConfig } from './stuck-detector';

/**
 * A harness profile fixes the three components the paper ablates (planning, action space,
 * context management) plus the budgets the loop runs under. The paper's conclusion is that
 * each component "should be selected for the target model, task type, and resource budget
 * rather than adopted as a default", which is what the profile bandit in src/learning does.
 */
export interface HarnessProfile {
  id: string;
  planning: boolean;
  actionSpace: 'tools' | 'bash';
  contextTier: ContextTier;
  windowTokens: number;
  softRatio: number;
  hardRatio: number;
  recentRatio: number;
  minRecentTurns: number;
  maxSteps: number;
  toolResultMaxChars: number;
  maxParallelReadOnly: number;
  stuck: StuckConfig;
}

/** The paper's baseline: T4 at a 128k budget, planning on, predefined tool set. */
export const BASELINE_PROFILE: HarnessProfile = {
  id: 't4-plan-tools-128k',
  planning: true,
  actionSpace: 'tools',
  contextTier: 4,
  windowTokens: 128_000,
  softRatio: 0.6,
  hardRatio: 0.85,
  recentRatio: 0.3,
  minRecentTurns: 2,
  maxSteps: 300,
  toolResultMaxChars: 24_000,
  maxParallelReadOnly: 8,
  stuck: DEFAULT_STUCK_CONFIG,
};

const ID_RE = /^t([0-4])-(plan|noplan)-(tools|bash)-(\d+)k$/;

export function profileId(
  p: Pick<HarnessProfile, 'contextTier' | 'planning' | 'actionSpace' | 'windowTokens'>,
): string {
  return `t${p.contextTier}-${p.planning ? 'plan' : 'noplan'}-${p.actionSpace}-${Math.round(p.windowTokens / 1000)}k`;
}

/** Build a profile from an id such as `t4-noplan-bash-64k`, on top of the baseline defaults. */
export function parseProfileId(id: string, base: HarnessProfile = BASELINE_PROFILE): HarnessProfile {
  const m = ID_RE.exec(id);
  if (!m) throw new Error(`Invalid profile id "${id}". Expected t<0-4>-<plan|noplan>-<tools|bash>-<N>k.`);
  return {
    ...base,
    id,
    contextTier: Number(m[1]) as ContextTier,
    planning: m[2] === 'plan',
    actionSpace: m[3] as 'tools' | 'bash',
    windowTokens: Number(m[4]) * 1000,
  };
}

/**
 * Default candidate set for the bandit: the paper's baseline and its single-component
 * ablations, plus tighter budgets (where context management matters most).
 */
export const DEFAULT_CANDIDATES = [
  't4-plan-tools-128k',
  't4-noplan-tools-128k',
  't4-plan-bash-128k',
  't4-noplan-bash-128k',
  't4-plan-tools-64k',
  't1-plan-tools-128k',
];

export function resolveProfile(
  idOrProfile: string | Partial<HarnessProfile> | undefined,
  overrides: Partial<HarnessProfile> = {},
): HarnessProfile {
  if (!idOrProfile) return { ...BASELINE_PROFILE, ...overrides };
  if (typeof idOrProfile === 'string') return { ...parseProfileId(idOrProfile), ...overrides };
  const merged = { ...BASELINE_PROFILE, ...idOrProfile, ...overrides };
  return { ...merged, id: idOrProfile.id ?? profileId(merged) };
}
