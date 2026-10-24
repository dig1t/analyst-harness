---
name: karpathy-practice-environments
description: 'Build practice environments and evaluation gyms where agents can try, fail, and learn from feedback. Use this skill when the user wants to set up automated evaluation for an agent, needs a sandbox for testing LLM capabilities, wants to build a practice gym for skills, needs an RL-style environment for agent improvement, or says "eval environment", "practice gym", "agent sandbox", "automated testing for agents", "RL environment", "agent eval loop". Based on Karpathy LLM Textbook and environments posts.'
disable-model-invocation: false
user-invocable: true
related_skills:
  - karpathy-education-first
  - karpathy-understanding-first
  - karpathy-meta-reflection
  - karpathy-autoresearch
---

# Skill 14: LLM Textbook + Practice Environments（LLM教科书 + 练习环境）

> Source: https://x.com/karpathy/status/1885026028428681698 | https://x.com/karpathy/status/1960803117689397543
> "Take LLMs to school" | "Environments for RL" posts

## Core Principle

**LLMs learn like students. Give them textbooks, worked problems, and practice gyms.**

Karpathy's insight: the missing ingredient in LLM training isn't more parameters — it's **practice environments** where agents can try → fail → see feedback → try again. Like a student who reads theory but also needs problem sets.

Apply this to your agents: build environments where they can practice a skill with automatic scoring, not just generate output into the void.

## The Three Training Data Types

Every good learning environment needs all three:

```
1. EXPOSITION (pretrain equivalent)
   → Background knowledge, concepts, context
   → The "textbook chapter" the agent reads before practicing
   
2. WORKED EXAMPLES (SFT equivalent)
   → Complete input-output pairs with reasoning shown
   → "Here's a solved problem — learn the pattern"
   
3. PRACTICE PROBLEMS with feedback (RL equivalent)
   → Problems with verifiable correct answers
   → Automatic scoring so agent knows how it did
   → Enough variety that memorization doesn't work
```

## Building a Practice Gym (General Template)

For any skill you want an agent to get better at:

```python
#!/usr/bin/env python3
"""
Practice Gym for: [SKILL_NAME]
Karpathy-style RL environment for agent skill development
"""

import json
import random
from typing import Callable

class PracticeGym:
    """
    A practice environment where an agent can repeatedly attempt
    a task and receive automatic feedback.
    """
    
    def __init__(self, task_generator: Callable, scorer: Callable):
        self.task_generator = task_generator  # generates new practice problems
        self.scorer = scorer                   # returns 0.0-1.0 score for an attempt
        self.history = []
    
    def sample_task(self):
        """Generate a new practice problem."""
        return self.task_generator()
    
    def evaluate(self, task, attempt):
        """Score an agent's attempt. Returns dict with score + feedback."""
        score = self.scorer(task, attempt)
        result = {
            "task": task,
            "attempt": attempt,
            "score": score,
            "passed": score >= 0.8,
        }
        self.history.append(result)
        return result
    
    def summary(self):
        """Summarize performance across all attempts."""
        if not self.history:
            return "No attempts yet."
        scores = [r["score"] for r in self.history]
        return {
            "total_attempts": len(scores),
            "avg_score": sum(scores) / len(scores),
            "pass_rate": sum(1 for s in scores if s >= 0.8) / len(scores),
            "recent_trend": "improving" if scores[-1] > scores[0] else "declining"
        }
```

## Practice Environment Design Prompt

Build a practice gym for any skill:

```
Design a practice environment for training an LLM agent to [SKILL].

Skill description: [WHAT THE AGENT SHOULD GET BETTER AT]
Current performance: [HOW WELL IT DOES NOW]
Target performance: [WHAT GOOD LOOKS LIKE]

Design the gym with:

1. TASK GENERATOR
   - Input format: [what the task looks like]
   - Variation parameters: [what changes between tasks]
   - Difficulty levels: [easy / medium / hard criteria]
   - Example task: [concrete example]

2. SCORER  
   - What makes an attempt correct? (exact match / rubric / functional test)
   - Score breakdown: [what earns partial credit]
   - Automatic vs human evaluation: [which parts can be automated]
   - Example: good attempt vs bad attempt with scores

3. CURRICULUM
   - Start: [simplest tasks to build confidence]
   - Progress: [how to increase difficulty as performance improves]
   - Mastery criterion: [when is the skill "learned"?]

4. FEEDBACK FORMAT
   What should the agent receive after each attempt?
   - Score (0-1)
   - Specific error: [what went wrong]
   - Hint for next attempt: [one actionable tip]
```

## Quick Eval Loop Prompt

For rapidly testing an agent on a set of practice problems:

```
Run an evaluation loop on this agent capability.

Agent task: [WHAT THE AGENT IS SUPPOSED TO DO]

Test cases:
1. Input: [test input 1]
   Expected output: [expected 1]
   
2. Input: [test input 2]
   Expected output: [expected 2]
   
3. Input: [test input 3]
   Expected output: [expected 3]

For each test case:
1. Attempt the task
2. Compare to expected output
3. Score: PASS / PARTIAL / FAIL
4. Explain the error (if any) in one sentence

Final report:
- Pass rate: N/3
- Most common failure mode: [pattern in errors]
- Suggested improvement: [one specific fix]
```

## The Curriculum Design Template

Build a structured learning progression:

```
Design a learning curriculum for an agent to master [SKILL].

Like Karpathy's "take LLMs to school" approach — structure it as:

WEEK 1 — Foundations (exposition):
- Core concepts to internalize
- 3-5 worked examples with full reasoning traces
- Quiz: 5 basic problems with answers

WEEK 2 — Pattern Recognition (practice):
- 20 practice problems, graduated difficulty
- Automatic scoring criteria
- Common error analysis

WEEK 3 — Generalization (RL-style):
- Novel problems the agent hasn't seen
- Real-world variants
- Adversarial examples (edge cases designed to fail)

Mastery test: [describe the final eval that confirms the skill is learned]
```

## Scoring Rubrics for Common Skills

### Code Generation
```
Score 1.0: Correct output, handles edge cases, clean style
Score 0.8: Correct output, misses 1 edge case
Score 0.5: Core logic correct, fails on some inputs
Score 0.2: Wrong approach but partially useful
Score 0.0: Doesn't compile or clearly wrong
```

### Reasoning/Analysis
```
Score 1.0: Correct conclusion + correct reasoning chain + appropriate confidence
Score 0.8: Correct conclusion, minor reasoning gap
Score 0.5: Correct conclusion, wrong reasoning
Score 0.2: Wrong conclusion but shows relevant knowledge
Score 0.0: Wrong conclusion, no relevant reasoning
```

### Following Instructions
```
Score 1.0: All instructions followed, output matches spec exactly
Score 0.8: Minor deviation from spec, intent preserved
Score 0.5: Core task done, 1-2 instructions ignored
Score 0.2: Significant departure from instructions
Score 0.0: Instructions ignored entirely
```

## Environment-in-a-Gist

Karpathy's pattern: publish the environment spec (not the implementation) so anyone can build their gym:

```
Write a Gist-style environment spec for [SKILL_GYM].

Format:
# [GYM_NAME] — Practice Environment Spec
## What this trains
## Task format
## Scoring criteria  
## Sample task + ideal response
## Curriculum (3 stages)
## How to evaluate mastery

This is a spec, not code. Anyone with an LLM should be able to implement it.
```

## Workflow

**属于工作流：月度体检（第3步）**

| 位置 | 上游 | 下游 |
|------|------|------|
| 第3步（练习） | karpathy-understanding-first（识别盲区后） | karpathy-education-first（把练习成果教学化） |

完整链路：meta-reflection → understanding-first → practice-environments → education-first

## Prompt Contract

```text
Build a practice environment for <SKILL_OR_CAPABILITY>. Include: 1) Exposition — what this skill is and why it matters (3-5 sentences), 2) Worked examples — 2-3 complete input→output demonstrations, 3) Practice tasks — 5 exercises with increasing difficulty, 4) Automatic grading — for each task define pass/fail criteria that can be checked without human judgment, 5) Retry loop — if failed, what feedback to give and how to adjust difficulty.
```

## Verification Checklist

- [ ] 练习环境有明确的技能定义（不是模糊的「变强」）
- [ ] Worked examples 覆盖了典型和边界情况
- [ ] 评分标准不需要人工判断（自动化）
- [ ] 失败时有具体反馈（不只是「错了」）
- [ ] 难度有递进（不是一步到位）
- [ ] Agent 可以自主重试直到通过
