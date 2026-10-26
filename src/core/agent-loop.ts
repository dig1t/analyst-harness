import type { AgentDefinition } from '../agents/definition';
import { completeText, ProviderError, type CompletionResponse, type LLMProvider } from '../llm/provider';
import type { PriceBook } from '../llm/pricing';
import type { PermissionManager } from '../safety/permissions';
import type { Workspace } from '../safety/workspace';
import { bashOnlyTool } from '../tools/bash-tool';
import { executeToolCalls } from '../tools/executor';
import { ToolRegistry } from '../tools/registry';
import type { ToolContext, ToolDefinition, ToolRuntimeConfig, ToolServices } from '../tools/types';
import { errorMessage } from '../util/errors';
import type { Logger } from '../util/logger';
import { retry } from '../util/retry';
import { ExternalStore } from './context/external-store';
import { ContextManager, TIER_MECHANISMS, type ContextEvent } from './context/manager';
import { TokenEstimator } from './context/token-estimator';
import { PlanState } from './planning/plan';
import type { HarnessProfile } from './profiles';
import {
  BASE_PROMPT_BASH,
  BASE_PROMPT_TOOLS,
  BASH_ONLY_BLOCK,
  PLANNING_PROMPT,
  PLAN_MISSING_REMINDER,
  SUMMARIZER_PROMPT,
  planReminder,
} from './prompts';
import { StuckDetector } from './stuck-detector';
import {
  addUsage,
  emptyUsage,
  promptTokens,
  textOf,
  toolCallsOf,
  type ContentBlock,
  type Effort,
  type Message,
  type Usage,
} from './types';

export type RunOutcome =
  | 'completed'
  | 'max_steps'
  | 'stuck'
  | 'context_overflow'
  | 'budget_exceeded'
  | 'refusal'
  | 'aborted'
  | 'provider_error';

export type AgentEvent =
  | {
      type: 'run_start';
      runId: string;
      task: string;
      agent: string;
      profile: string;
      model: string;
      depth: number;
    }
  | {
      type: 'llm_response';
      step: number;
      stopReason: string;
      usage: Usage;
      costUsd: number;
      model: string;
      text: string;
      toolCalls: Array<{ id: string; name: string; input: unknown }>;
      progress: string[];
    }
  | {
      type: 'tool_result';
      step: number;
      toolCallId: string;
      name: string;
      input: unknown;
      isError: boolean;
      permissionDenied: boolean;
      durationMs: number;
      eventId: number;
      preview: string;
      outputChars: number;
    }
  | { type: 'context'; step: number; event: ContextEvent }
  | { type: 'plan'; step: number; plan: string; done: number; total: number }
  | { type: 'stuck'; step: number; kind: string; tool: string; count: number }
  | { type: 'error'; step: number; message: string }
  | { type: 'run_end'; result: RunResult };

export interface BudgetGuard {
  /** Return a reason string when no further model calls should be made. */
  exceeded(runCostUsd: number): string | undefined;
  record(costUsd: number): void;
}

export interface AgentRunConfig {
  runId: string;
  task: string;
  agent: AgentDefinition;
  profile: HarnessProfile;
  model: string;
  effort?: Effort;
  provider: LLMProvider;
  registry: ToolRegistry;
  workspace: Workspace;
  permissions: PermissionManager;
  services: ToolServices;
  toolRuntime: ToolRuntimeConfig;
  priceBook: PriceBook;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
  budget?: BudgetGuard;
  runBudgetUsd?: number;
  onEvent?: (e: AgentEvent) => void | Promise<void>;
  signal?: AbortSignal;
  depth?: number;
  /** Extra system blocks: skills index, knowledge note, retrieved lessons, environment. */
  systemExtras?: string[];
  storeFile?: string;
  maxTokensPerTurn?: number;
  summarizerModel?: string;
  retrySleep?: (ms: number) => Promise<void>;
}

export interface RunResult {
  runId: string;
  agent: string;
  profileId: string;
  model: string;
  task: string;
  outcome: RunOutcome;
  finalText: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  usage: Usage;
  costUsd: number;
  plan: string;
  changedFiles: string[];
  contextEvents: number;
  summaryCalls: number;
  recallCalls: number;
  stuckReminders: number;
  error?: string;
  startedAt: string;
  endedAt: string;
}

export function buildSystemPrompt(
  agent: AgentDefinition,
  profile: HarnessProfile,
  registry: ToolRegistry,
  extras: string[] = [],
): string {
  const blocks = [profile.actionSpace === 'bash' ? BASE_PROMPT_BASH : BASE_PROMPT_TOOLS];
  if (agent.systemPrompt.trim()) blocks.push(`# Role: ${agent.name}\n\n${agent.systemPrompt.trim()}`);
  if (profile.actionSpace === 'bash') blocks.push(BASH_ONLY_BLOCK);
  blocks.push(registry.usageRules());
  if (profile.planning) blocks.push(PLANNING_PROMPT);
  for (const extra of extras) if (extra.trim()) blocks.push(extra.trim());
  return blocks.join('\n\n');
}

function progressNotes(message: Message): string[] {
  const notes: string[] = [];
  for (const b of message.content) {
    if (b.type === 'opaque' && b.kind === 'thinking') {
      const text = (b.data as { thinking?: string } | undefined)?.thinking;
      if (text && text.trim()) notes.push(text.trim());
    }
  }
  return notes;
}

/**
 * The ReAct loop (paper section 2): each turn assembles the model input, executes the
 * emitted tool calls and appends the observations. Planning enters through the injected
 * plan, the action space through the exposed tools, and context management through the
 * history the model sees. Tool failures become observations; the loop never crashes on them.
 */
export async function runAgent(cfg: AgentRunConfig): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const depth = cfg.depth ?? 0;
  const { profile, provider, logger } = cfg;
  const mech = TIER_MECHANISMS[profile.contextTier];

  let registry = cfg.registry.select({
    actionSpace: profile.actionSpace,
    planning: profile.planning,
    recall: mech.recall,
    allow: cfg.agent.tools,
  });
  if (profile.actionSpace === 'bash' && registry.has('bash')) {
    const swapped = registry.list().map((d) => (d.name === 'bash' ? bashOnlyTool : d)) as Array<
      ToolDefinition<never>
    >;
    registry = new ToolRegistry(swapped);
  }
  const tools = registry.schemas();
  const system = buildSystemPrompt(cfg.agent, profile, registry, cfg.systemExtras);
  const caps = provider.capabilities(cfg.model);

  const store = cfg.storeFile ? await ExternalStore.load(cfg.storeFile) : new ExternalStore();
  const estimator = new TokenEstimator();
  let usage = emptyUsage();
  let costUsd = 0;
  const account = (res: CompletionResponse) => {
    usage = addUsage(usage, res.usage);
    const c = cfg.priceBook.costOf(res);
    costUsd += c;
    cfg.budget?.record(c);
    return c;
  };

  const summarizer = async ({
    previousSummary,
    transcript,
  }: {
    previousSummary?: string;
    transcript: string;
  }) => {
    const prompt = `${previousSummary ? `Previous summary to update:\n${previousSummary}\n\n` : ''}Oldest transcript events:\n${transcript}`;
    const { text, response } = await completeText(provider, {
      model: cfg.summarizerModel ?? cfg.model,
      system: SUMMARIZER_PROMPT,
      prompt,
      maxTokens: 8_000,
      effort: 'low',
      purpose: 'summarize',
      signal: cfg.signal,
    });
    account(response);
    return text || '(summary unavailable)';
  };

  const ctx = new ContextManager(
    {
      tier: profile.contextTier,
      windowTokens: profile.windowTokens,
      softRatio: profile.softRatio,
      hardRatio: profile.hardRatio,
      recentRatio: profile.recentRatio,
      minRecentTurns: profile.minRecentTurns,
      bulkyMinChars: 800,
      bindsThinking: caps.bindsThinkingToPrefix,
      thinkingKinds: ['thinking', 'redacted_thinking'],
    },
    estimator,
    store,
    summarizer,
  );
  ctx.setFixed(system, tools);

  const plan = new PlanState();
  const stuck = new StuckDetector(profile.stuck);
  // Claude preserved thinking needs an append-only history, so reminders are appended (and
  // left in place) instead of being injected and removed every turn as in the paper.
  const appendReminders = caps.bindsThinkingToPrefix;
  const history: Message[] = [
    { role: 'user', kind: 'preamble', content: [{ type: 'text', text: cfg.task }] },
  ];
  const changed = new Set<string>();
  const toolCtx: ToolContext = {
    runId: cfg.runId,
    agent: cfg.agent.name,
    step: 0,
    depth,
    workspace: cfg.workspace,
    permissions: cfg.permissions,
    plan,
    store,
    services: cfg.services,
    logger: logger.child({ runId: cfg.runId }),
    signal: cfg.signal,
    env: cfg.env ?? process.env,
    config: cfg.toolRuntime,
  };

  const emit = async (e: AgentEvent) => {
    try {
      await cfg.onEvent?.(e);
    } catch (err) {
      logger.warn('event handler failed', { err, type: e.type });
    }
  };

  await emit({
    type: 'run_start',
    runId: cfg.runId,
    task: cfg.task,
    agent: cfg.agent.name,
    profile: profile.id,
    model: cfg.model,
    depth,
  });

  let outcome: RunOutcome = 'max_steps';
  let finalText = '';
  let error: string | undefined;
  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  let contextEvents = 0;
  let stuckReminders = 0;
  let bindingRetried = false;
  let truncationContinues = 0;
  const maxSteps = cfg.agent.maxSteps ?? profile.maxSteps;

  for (let step = 1; step <= maxSteps; step++) {
    steps = step;
    toolCtx.step = step;
    if (cfg.signal?.aborted) {
      outcome = 'aborted';
      break;
    }
    const overBudget =
      (cfg.runBudgetUsd !== undefined && costUsd >= cfg.runBudgetUsd
        ? `run budget of $${cfg.runBudgetUsd} reached`
        : undefined) ?? cfg.budget?.exceeded(costUsd);
    if (overBudget) {
      outcome = 'budget_exceeded';
      error = overBudget;
      break;
    }

    let ephemeral: string | undefined;
    if (profile.planning) {
      const reminder = plan.exists ? planReminder(plan.render()) : PLAN_MISSING_REMINDER;
      if (appendReminders) {
        const last = history[history.length - 1]!;
        history[history.length - 1] = {
          ...last,
          content: [...last.content, { type: 'text', text: reminder, origin: 'plan_reminder' }],
        };
      } else {
        ephemeral = reminder;
      }
    }

    let prepared;
    try {
      prepared = await ctx.prepare(history);
    } catch (err) {
      outcome = 'provider_error';
      error = `context management failed: ${errorMessage(err)}`;
      break;
    }
    for (const event of prepared.events) {
      contextEvents++;
      await emit({ type: 'context', step, event });
    }
    if (prepared.overflow) {
      outcome = 'context_overflow';
      error = `context of ~${prepared.tokens} tokens exceeds the ${profile.windowTokens}-token window`;
      break;
    }

    const messages = ctx.render(history, ephemeral);
    const requestChars = ctx.requestChars(messages);
    let response: CompletionResponse;
    try {
      response = await retry(
        () =>
          provider.complete({
            model: cfg.model,
            system,
            messages,
            tools,
            maxTokens: cfg.maxTokensPerTurn ?? 64_000,
            effort: cfg.effort,
            purpose: 'agent',
            signal: cfg.signal,
          }),
        {
          retries: 4,
          baseMs: 2_000,
          maxMs: 60_000,
          shouldRetry: (err) => err instanceof ProviderError && err.retryable && !cfg.signal?.aborted,
          onRetry: (err, attempt, delay) => logger.warn('provider error, retrying', { err, attempt, delay }),
          sleep: cfg.retrySleep,
        },
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'thinking_binding' && !bindingRetried) {
        // One-time recovery: strip every thinking block and re-send.
        bindingRetried = true;
        ctx.stripThinking(history);
        await emit({
          type: 'error',
          step,
          message: `thinking blocks rejected, stripped and retrying: ${err.message}`,
        });
        step--;
        continue;
      }
      outcome = cfg.signal?.aborted ? 'aborted' : 'provider_error';
      error = errorMessage(err);
      await emit({ type: 'error', step, message: error });
      break;
    }

    estimator.calibrate(requestChars, promptTokens(response.usage));
    const stepCost = account(response);
    history.push({ ...response.message, kind: 'turn' });
    const calls = toolCallsOf(response.message);
    const text = textOf(response.message);
    await emit({
      type: 'llm_response',
      step,
      stopReason: response.stopReason,
      usage: response.usage,
      costUsd: stepCost,
      model: response.model,
      text,
      toolCalls: calls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
      progress: progressNotes(response.message),
    });

    if (response.stopReason === 'refusal') {
      outcome = 'refusal';
      finalText =
        text ||
        `The model declined this request${response.refusal?.category ? ` (${response.refusal.category})` : ''}.`;
      break;
    }
    if (response.stopReason === 'context_exceeded') {
      outcome = 'context_overflow';
      error = 'the model reported that the context window was exceeded';
      break;
    }

    if (calls.length === 0) {
      if (response.stopReason === 'max_tokens' && truncationContinues < 2) {
        truncationContinues++;
        history.push({
          role: 'user',
          kind: 'turn',
          content: [
            {
              type: 'text',
              text: 'Your previous response hit the output limit and was cut off. Continue exactly where you stopped.',
              origin: 'harness',
            },
          ],
        });
        continue;
      }
      outcome = 'completed';
      finalText = text;
      break;
    }

    const results: ContentBlock[] = [];
    if (response.stopReason === 'max_tokens') {
      // A tool input cut off at max_tokens can parse as a valid partial object: never run it.
      for (const call of calls) {
        const eventId = store.allocateId();
        const content =
          'This tool call was cut off at the output token limit, so it was NOT run. Re-issue it with smaller content (for example, write large files in parts).';
        await store.put({
          id: eventId,
          toolName: call.name,
          toolCallId: call.id,
          input: call.input,
          content,
          isError: true,
          step,
        });
        results.push({ type: 'tool_result', toolCallId: call.id, content, isError: true, eventId });
      }
      history.push({ role: 'user', kind: 'turn', content: results });
      continue;
    }

    const planUpdatesBefore = plan.updateCount;
    const executions = await executeToolCalls(calls, registry, toolCtx, {
      maxResultChars: profile.toolResultMaxChars,
      maxParallelReadOnly: profile.maxParallelReadOnly,
    });
    let terminate: { tool: string; count: number } | undefined;
    const reminders: string[] = [];
    for (const exec of executions) {
      toolCalls++;
      if (exec.isError) toolErrors++;
      for (const f of exec.changedFiles) changed.add(f);
      const eventId = store.allocateId();
      await store.put({
        id: eventId,
        toolName: exec.call.name,
        toolCallId: exec.call.id,
        input: exec.call.input,
        content: exec.content,
        isError: exec.isError,
        step,
      });
      results.push({
        type: 'tool_result',
        toolCallId: exec.call.id,
        content: exec.content,
        ...(exec.isError ? { isError: true } : {}),
        eventId,
      });
      await emit({
        type: 'tool_result',
        step,
        toolCallId: exec.call.id,
        name: exec.call.name,
        input: exec.call.input,
        isError: exec.isError,
        permissionDenied: exec.permissionDenied,
        durationMs: exec.durationMs,
        eventId,
        preview: exec.content.slice(0, 500),
        outputChars: exec.content.length,
      });
      const signal = stuck.observe(exec.call, {
        isError: exec.isError,
        content: exec.content,
        permissionDenied: exec.permissionDenied,
      });
      if (signal) {
        await emit({ type: 'stuck', step, kind: signal.kind, tool: signal.tool, count: signal.count });
        if (signal.kind === 'terminate') terminate = { tool: signal.tool, count: signal.count };
        else {
          reminders.push(signal.text);
          stuckReminders++;
        }
      }
    }
    for (const r of reminders) results.push({ type: 'text', text: r, origin: 'stuck_reminder' });
    history.push({ role: 'user', kind: 'turn', content: results });
    if (plan.updateCount !== planUpdatesBefore) {
      const p = plan.progress();
      await emit({ type: 'plan', step, plan: plan.render(), done: p.done, total: p.total });
    }
    if (terminate) {
      outcome = 'stuck';
      error = `identical failing calls to ${terminate.tool} repeated ${terminate.count} times`;
      break;
    }
  }

  if (outcome !== 'completed' && !finalText) {
    const lastAssistant = [...history].reverse().find((m) => m.role === 'assistant');
    finalText = lastAssistant ? textOf(lastAssistant) : '';
  }

  const result: RunResult = {
    runId: cfg.runId,
    agent: cfg.agent.name,
    profileId: profile.id,
    model: cfg.model,
    task: cfg.task,
    outcome,
    finalText,
    steps,
    toolCalls,
    toolErrors,
    usage,
    costUsd,
    plan: plan.render(),
    changedFiles: [
      ...changed,
      ...cfg.workspace.fileState.changedFiles.map((abs) => cfg.workspace.display(abs)),
    ].filter((v, i, a) => a.indexOf(v) === i),
    contextEvents,
    summaryCalls: ctx.stats.summaryCalls,
    recallCalls: store.recallCount,
    stuckReminders,
    error,
    startedAt,
    endedAt: new Date().toISOString(),
  };
  await emit({ type: 'run_end', result });
  return result;
}
