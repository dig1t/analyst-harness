import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AgentEvent, RunResult } from '../core/agent-loop';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../util/fs';

export interface JudgeVerdict {
  score: number;
  verdict: 'success' | 'partial' | 'failure';
  failureStage?: string;
  reason: string;
  judgedBy: 'llm' | 'heuristic';
}

export interface RunMeta {
  result: RunResult;
  taskType: string;
  source: string;
  requestedBy?: string;
  profileSelectedBy: 'bandit' | 'agent' | 'request' | 'default';
  phases?: string;
  judge?: JudgeVerdict;
  feedback?: { value: 'up' | 'down'; by?: string; at: string };
  learned?: { at: string; lessons: string[]; banditReward?: number; skillProposal?: string };
}

/**
 * Trajectory store: one folder per run with the event stream (events.jsonl), the M2 external
 * store (store.jsonl) and run metadata (meta.json), plus an append-only index of finished
 * runs. Trajectories are the raw material for the judge, the bandit and reflection.
 */
export class RunStore {
  constructor(readonly dir: string) {}

  runDir(runId: string): string {
    if (!/^[\w.-]+$/.test(runId)) throw new Error(`invalid run id ${runId}`);
    return path.join(this.dir, runId);
  }

  eventsFile(runId: string): string {
    return path.join(this.runDir(runId), 'events.jsonl');
  }

  storeFile(runId: string): string {
    return path.join(this.runDir(runId), 'store.jsonl');
  }

  /** Event handler that appends every agent event (with a timestamp) to the run's log. */
  recorder(runId: string): (e: AgentEvent) => Promise<void> {
    const file = this.eventsFile(runId);
    let chain = Promise.resolve();
    return (e: AgentEvent) => {
      const record =
        e.type === 'run_end'
          ? { type: 'run_end', at: new Date().toISOString() }
          : { ...e, at: new Date().toISOString() };
      chain = chain.then(() => appendJsonl(file, record)).catch(() => undefined);
      return chain;
    };
  }

  async events(runId: string): Promise<Array<AgentEvent & { at: string }>> {
    return readJsonl(this.eventsFile(runId));
  }

  async saveMeta(meta: RunMeta): Promise<void> {
    await writeJsonAtomic(path.join(this.runDir(meta.result.runId), 'meta.json'), meta);
  }

  async finish(meta: RunMeta): Promise<void> {
    await this.saveMeta(meta);
    const r = meta.result;
    await appendJsonl(path.join(this.dir, 'index.jsonl'), {
      runId: r.runId,
      agent: r.agent,
      model: r.model,
      profileId: r.profileId,
      taskType: meta.taskType,
      outcome: r.outcome,
      costUsd: r.costUsd,
      steps: r.steps,
      endedAt: r.endedAt,
      task: r.task.slice(0, 200),
    });
  }

  async getMeta(runId: string): Promise<RunMeta | undefined> {
    return readJson<RunMeta | undefined>(path.join(this.runDir(runId), 'meta.json'), undefined);
  }

  async updateMeta(runId: string, patch: (meta: RunMeta) => RunMeta): Promise<RunMeta | undefined> {
    const meta = await this.getMeta(runId);
    if (!meta) return undefined;
    const next = patch(meta);
    await this.saveMeta(next);
    return next;
  }

  async list(limit = 20): Promise<Array<Record<string, unknown> & { runId: string }>> {
    const rows = await readJsonl<Record<string, unknown> & { runId: string }>(
      path.join(this.dir, 'index.jsonl'),
    );
    return rows.slice(-limit).reverse();
  }

  /** Finished runs that have not been processed by the learning loop yet. */
  async unlearned(limit = 50): Promise<RunMeta[]> {
    const rows = await this.list(1_000);
    const out: RunMeta[] = [];
    for (const row of rows) {
      const meta = await this.getMeta(row.runId);
      if (meta && !meta.learned) out.push(meta);
      if (out.length >= limit) break;
    }
    return out;
  }

  async exists(runId: string): Promise<boolean> {
    return fsp
      .access(path.join(this.runDir(runId), 'meta.json'))
      .then(() => true)
      .catch(() => false);
  }
}
