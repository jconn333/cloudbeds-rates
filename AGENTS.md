# Agent Workflow Guide (Repo-Local)

This file defines preferred working conventions for this repository.

## Scope And Precedence

1. Runtime system/developer instructions always take precedence over this file.
2. If runtime mode is `Default`, do not require `Plan` mode steps.
3. If a rule here conflicts with enforced runtime behavior, follow runtime behavior and continue.

## Workflow Orchestration

### 1. Planning (When Applicable)

- For non-trivial tasks (about 3+ meaningful steps, cross-file changes, or architectural decisions), write a short plan before editing.
- If execution reveals new constraints or failures, stop and re-plan before continuing.
- Include verification in the plan, not just implementation.
- Keep plans concrete and checkable.

### 2. Parallelism Strategy

- Use parallel exploration where tooling supports it to reduce turnaround time.
- Keep each exploration thread focused on a single question.
- Summarize findings back into one concise execution path.

### 3. Continuous Improvement

- After user corrections, capture the lesson so the same issue is less likely to recur.
- Prefer specific, behavior-level lessons over generic reminders.

### 4. Verification Before Completion

- Do not mark work complete without evidence.
- Run relevant tests/lint/type checks when available.
- Validate behavior changes directly (logs, outputs, or reproducible checks).
- When relevant, compare expected behavior before/after the change.

### 5. Design Quality (Balanced)

- Prefer simple solutions with minimal surface area.
- For non-trivial changes, check whether there is a cleaner design.
- Avoid over-engineering for straightforward fixes.

### 6. Bug-Fix Execution

- For clear bug reports, move directly to reproduction, diagnosis, and fix.
- Ground fixes in observable evidence (errors, failing tests, logs).
- Minimize user back-and-forth when required context is already in repo.

## Task Tracking In This Repo

Use `tasks/` for lightweight task tracking.

- Plan file: `tasks/todo.md`
- Lessons file: `tasks/lessons.md`

Workflow:

1. Write or update a short checklist in `tasks/todo.md` for non-trivial work.
2. Mark items complete as work progresses.
3. Add a brief verification/results section at the end of the task entry.
4. After meaningful corrections, add a concise lesson in `tasks/lessons.md`.

If `tasks/` does not exist, create it when task tracking is needed.

## Core Principles

- Simplicity first: solve the problem with the least necessary complexity.
- Root-cause focus: prefer durable fixes over temporary patches.
- Minimal impact: touch only the code required for the change.
- Clarity: leave artifacts (plan, checks, notes) that make review straightforward.

## Cloudbeds API Safety Notes

- Treat `tasks/lessons.md` as the repo-local memory for Cloudbeds API behavior.
- Before changing write behavior, review the write payload, polling, and verification notes there.
- Keep live writes gated by environment flags, draft hashes, small batch limits, backups, and readback verification.
