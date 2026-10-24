import type { AgentEvent } from '../core/agent-loop';

/**
 * Data-analysis adaptation of the paper's trajectory encodings (Appendix C, Tables 8 and 9):
 * every turn gets one primary phase.
 */
export const PHASES = {
  A: 'Acquire: fetch, scrape, download or load data',
  E: 'Explore: inspect files, schemas, samples, docs and knowledge',
  T: 'Transform: write or edit code and data (cleaning, reshaping)',
  M: 'Model/Analyze: run queries, compute statistics, build results',
  V: 'Verify: sanity checks, cross-checks, tests, re-runs',
  R: 'Report: write the findings or the final answer',
  O: 'Other: planning, delegation, setup and bookkeeping',
} as const;

export type Phase = keyof typeof PHASES;

/** Failure stages, in pipeline order (adapted from Figure 41). The earliest failed stage wins. */
export const FAILURE_STAGES = [
  'data_acquisition',
  'data_understanding',
  'analysis_implementation',
  'verification',
  'reporting',
] as const;
export type FailureStage = (typeof FAILURE_STAGES)[number];

/** When a turn has several actions, the highest-priority phase labels it (as in Figure 40). */
const PRIORITY: Phase[] = ['T', 'M', 'V', 'A', 'E', 'R', 'O'];

const VERIFY_RE =
  /\b(pytest|unittest|jest|assert|diff|cmp|md5sum|sha256sum|wc -l|count\(\*\)|--check|validate|verify)\b/i;
const ACQUIRE_RE = /\b(curl|wget|scrapy|playwright|requests\.get|httpx)\b/i;
const EXPLORE_RE = /^\s*(ls|cat|head|tail|less|file|stat|find|rg|grep|jq|du|pwd|tree)\b/;
const ANALYZE_RE = /\b(python3?|node|duckdb|sqlite3|Rscript)\b/;

export function phaseOfCall(name: string, input: unknown): Phase {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'web_fetch':
    case 'run_scraper':
      return 'A';
    case 'read_file':
    case 'list_files':
    case 'glob_files':
    case 'grep_text':
    case 'search_knowledge':
    case 'load_skill':
    case 'recall_event':
      return 'E';
    case 'write_file':
    case 'edit_file': {
      const p = String(args.path ?? '');
      if (/(^|\/)reports?\//.test(p) || /\.(md|html)$/.test(p)) return 'R';
      if (/(^|\/)(tests?|checks?)\//.test(p) || /test_|_test\./.test(p)) return 'V';
      return 'T';
    }
    case 'sql_query': {
      const q = String(args.query ?? '');
      return /\b(summarize|describe)\b/i.test(q) && !/\bgroup by\b/i.test(q) ? 'E' : 'M';
    }
    case 'bash': {
      const cmd = String(args.command ?? '');
      if (VERIFY_RE.test(cmd)) return 'V';
      if (ACQUIRE_RE.test(cmd)) return 'A';
      if (EXPLORE_RE.test(cmd)) return 'E';
      if (ANALYZE_RE.test(cmd)) return 'M';
      return 'O';
    }
    default:
      return 'O';
  }
}

/** Rule-based per-turn phase string, for example "OEEAMMVR". Cheap, deterministic, no LLM. */
export function labelTrajectory(events: AgentEvent[]): Phase[] {
  const phases: Phase[] = [];
  for (const e of events) {
    if (e.type !== 'llm_response') continue;
    if (e.toolCalls.length === 0) {
      phases.push(e.text.trim() ? 'R' : 'O');
      continue;
    }
    const turn = e.toolCalls.map((c) => phaseOfCall(c.name, c.input));
    phases.push(PRIORITY.find((p) => turn.includes(p)) ?? 'O');
  }
  return phases;
}

export function phaseHistogram(phases: Phase[]): Record<Phase, number> {
  const h = { A: 0, E: 0, T: 0, M: 0, V: 0, R: 0, O: 0 } as Record<Phase, number>;
  for (const p of phases) h[p]++;
  return h;
}
