---
name: build-feature
description: Orchestrate a non-trivial change to the rate-limiter: plan, implement in slices, run lint/test/build, get parallel independent reviews from software-reviewer and security-reviewer, triage findings, then have tech-writer update docs. Use for new features and meaningful refactors. Skip for typo fixes or one-line changes.
argument-hint: <task description>
---

# build-feature

You are the orchestrator, running in the main session. You do the implementation yourself (you hold the design context); specialist agents provide independent review and documentation. Subagents cannot spawn subagents, so you delegate directly.

Task: $ARGUMENTS

If the task is empty or ambiguous, ask the user before starting.

## 1. Plan
- Restate the task in 2–3 lines with acceptance criteria.
- Read the relevant sections of `docs/architecture/high-level-design.md` and `docs/architecture/tech-stack-plan.md`, plus `CLAUDE.md` invariants.
- For non-trivial design, use the built-in `Plan` agent. Do not contradict approved HLD/tech-stack decisions; if the task requires it, stop and ask the user.
- Break the work into small slices (one port/adapter/route per slice).

## 2. Implement (per slice)
- Write code and tests together. Tests use the fake `Clock`, not Jest fake timers.
- Keep `consume()` and the eviction sweep synchronous. Add no runtime dependencies beyond zod and pino.
- After each slice run the gate: `pnpm lint && pnpm test && pnpm build`. Fix failures before continuing. If `package.json` does not exist yet, skip the gate and say so.

## 3. Review (parallel, independent)
Once all slices pass the gate, launch **`software-reviewer` and `security-reviewer` in a single message** (parallel Agent calls). They start cold, so each prompt must include:
- the task summary and acceptance criteria,
- the explicit list of changed/new file paths (use `git diff --name-only` if this is a git repo; otherwise list them yourself),
- the specific invariants touched (e.g. sync `consume`, fail-closed, body cap),
- a reminder that they are read-only and must use their output format.

Quick mode (small change, no new endpoints or input handling): run only `software-reviewer`.

## 4. Triage
- Fix every CRITICAL and HIGH finding. Re-run the gate.
- For MEDIUM/LOW: fix if cheap and clearly right; otherwise defer with a one-line reason.
- Disagree with a finding only with evidence from the code or HLD; note it in the report.
- If you changed anything significant, run a second review round with the relevant reviewer only. **Maximum 2 review rounds**; escalate anything still open to the user instead of looping.

## 5. Document
Launch `tech-writer` with: the change summary, final file list, new/changed endpoints, config or command changes, and any benchmark results. Read its report; resolve or forward its "Drift / questions" items to the user. It may write only `README.md` and `docs/**`.

## 6. Final gate and report
- Re-run `pnpm lint && pnpm test && pnpm build`. If the hot path (request handling, `consume`, validation) changed, also run `pnpm bench` and record results.
- Report to the user: what was built, files changed, review findings (fixed / deferred with reasons / disputed), docs touched, gate and bench results, and open questions.
- Do not commit unless the user asks.
