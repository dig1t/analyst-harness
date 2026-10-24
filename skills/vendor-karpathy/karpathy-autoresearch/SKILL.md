---
name: karpathy-autoresearch
description: 'Set up an autonomous research loop where an agent iterates on experiments, hypotheses, and code on git branches. Use this skill when the user wants to automate ML experiments, set up a research agent that self-improves, needs to run many variations of an experiment without manual intervention, or says "automate experiments", "agent research loop", "self-improving agent", "run hyperparameter search", "autoresearch". Based on Karpathy 28k-like AutoResearch post.'
disable-model-invocation: false
user-invocable: true
related_skills:
  - karpathy-llm-wiki
  - karpathy-output-evolution
  - karpathy-education-first
  - karpathy-system-prompt-learning
---

# Skill 6: AutoResearch（自主研究循环）

> Source: https://x.com/karpathy/status/2030371219518931079
> "Autoresearch project — agent self-iterates training code" — 28k likes

## Core Principle

**You change the prompt. The agent changes everything else.**

The loop: agent reads current state → runs experiment → analyzes results → proposes next iteration → you approve the prompt change → repeat.

You stay in the hypothesis space. Agent stays in the implementation + execution space.

## The AutoResearch Architecture

```
Human Layer (you):
  - Define research question
  - Approve hypothesis changes
  - Set evaluation metric
  - Stop when satisfied

Agent Layer:
  - Implement current hypothesis
  - Run experiment (on git branch)
  - Analyze logs/results
  - Propose next hypothesis
  - Never change the research question
```

## Setup Prompt (One-Time)

```
You are AutoResearcher for this project.

Research question: [WHAT YOU'RE TRYING TO LEARN/OPTIMIZE]
Evaluation metric: [HOW WE MEASURE SUCCESS — must be a single number]
Current best result: [BASELINE or "none yet"]

Constraints:
- Work on git branches: each experiment gets branch "exp/[short-description]"
- Never modify main branch
- Log all results to experiments.jsonl in format: {"id": N, "hypothesis": "...", "metric": value, "notes": "..."}
- Each iteration: implement → run → log → propose next

Starting hypothesis: [YOUR FIRST HYPOTHESIS TO TEST]

Begin iteration 1. Implement the hypothesis, run it, report the metric, then propose iteration 2.
```

## Per-Iteration Loop Prompt

```
AutoResearcher: Iteration [N]

Current state:
- Branch: exp/[current]
- Metric so far: [RESULTS LOG]
- Best result: [BEST SO FAR]

Completed last iteration: [WHAT HAPPENED]
Metric result: [VALUE]

Your tasks this iteration:
1. Analyze: what does the result tell us about the hypothesis?
2. Propose: what's the next hypothesis? (one variable change at a time)
3. Implement: write the code change for this hypothesis
4. Run: execute and report the metric
5. Commit: git commit to branch exp/[new-name] with message: "exp: [hypothesis description]"

Constraint: change ONE variable at a time. If last experiment failed, back off to simpler hypothesis.
```

## Experiment Log Format

```jsonl
{"id": 1, "branch": "exp/baseline", "hypothesis": "default hyperparams", "metric": 0.423, "runtime_s": 45, "notes": "starting point"}
{"id": 2, "branch": "exp/lr-0.001", "hypothesis": "lower learning rate 0.01→0.001", "metric": 0.451, "runtime_s": 47, "notes": "small improvement, keep lowering?"}
{"id": 3, "branch": "exp/lr-0.0001", "hypothesis": "lower learning rate 0.001→0.0001", "metric": 0.438, "runtime_s": 46, "notes": "worse than id=2, sweet spot was 0.001"}
```

## Research Summary Prompt (run after N iterations)

```
Summarize this research session.

Experiment log:
[PASTE experiments.jsonl]

Produce:
1. Best configuration found (all hyperparameters/settings)
2. What we learned (2-3 bullet points about the search space)
3. What we should try next (top 3 unexplored directions)
4. A clear hypothesis about WHY the best configuration works
5. Confidence level: how sure are we this is near-optimal?
```

## Applying AutoResearch Beyond ML

This pattern works for any iterative optimization:

| Domain | Research Question | Metric |
|--------|------------------|--------|
| ML training | Best architecture/hyperparams | Validation loss |
| Prompt engineering | Best system prompt | Task success rate |
| Code optimization | Fastest implementation | Runtime (ms) |
| Content creation | Most engaging format | Click/read rate |
| Product design | Best UX flow | Task completion rate |

## Safety Rails

```
AutoResearcher rules (always include):
- NEVER delete data or commits from previous experiments
- NEVER modify any file outside the current experiment's scope
- NEVER run experiments that cost > [COST_LIMIT] without checking
- ALWAYS commit before starting the next iteration
- ALWAYS report the metric before proposing the next hypothesis
- If metric degrades 3 iterations in a row, STOP and ask for guidance
```

## Workflow

**属于工作流：研究到发布（内容创作者/研究者）**

| 位置 | 上游 | 下游 |
|------|------|------|
| 入口 | 用户有研究问题时直接触发 | karpathy-llm-wiki（把实验结果沉淀为知识页） |

完整链路：autoresearch → llm-wiki → output-evolution → education-first

## Prompt Contract

```text
You are AutoResearcher. Research question: <QUESTION>. Evaluation metric: <SINGLE_NUMBER_METRIC>. Current baseline: <VALUE or "none">. Starting hypothesis: <FIRST_HYPOTHESIS>. Work on git branches (exp/<name>). Each iteration: implement → run → log result to experiments.jsonl → analyze → propose next hypothesis (one variable change). Never modify main. Stop and ask if metric degrades 3 iterations in a row.
```

## Verification Checklist

- [ ] 研究问题有明确的单一评估指标
- [ ] 每轮实验只改一个变量
- [ ] 所有结果都记录到 experiments.jsonl
- [ ] 每轮在独立 git branch 上工作
- [ ] 人类在方向性变更前被征求意见
- [ ] 有明确的停止条件（指标连续恶化/达到目标）
