# Rate Limiter

Rate-limiter service per `docs/requirements/Rate-Limiter-Coding-Exercise.md`.
Design: `docs/architecture/high-level-design.md` (HLD). Stack: `docs/architecture/tech-stack-plan.md`.

## Stack
Node 24 LTS, TypeScript 6.0.3 (`strict`), pnpm, `node:http` (no framework), zod 4, pino 10.
Tests: jest + ts-jest, autocannon for load. Lint/format: eslint + typescript-eslint, prettier.
Runtime dependencies are kept to two (zod, pino) — do not add libraries without discussion.

## Commands
- `pnpm lint` / `pnpm test` / `pnpm build` — must all pass before review
- `pnpm bench` — autocannon latency/capacity run (needed when the hot path changes)
- `pnpm dev` — tsx watch

## Invariants (HLD refs)
- Hexagonal architecture: core depends on ports only; adapters live at the edge.
- `CounterStore.consume()` is atomic because its in-memory body is **synchronous** (no `await`, no I/O inside). The port is async; the single `await` is outside the critical section (§5.1, §5.2).
- No `cluster` / `worker_threads` for request handling (state would split across isolates).
- Configs are never evicted; counters are idle-evicted (`> 2×W`) by a synchronous `setInterval(...).unref()` sweep (§5.3).
- Fail-closed on internal failure (§7).
- Bounded body reader (413), `Content-Type: application/json` check, explicit server timeouts.
- No per-decision info logging; log config changes (old→new), fail-closed events, startup errors.
- Tests inject a fake `Clock`; do not use Jest fake timers.

## Docs
Documentation lives only in `README.md` and `docs/`. Design docs (HLD, tech-stack) are changed deliberately, not as a side effect.

## Workflow
Use `/build-feature <task>` for non-trivial work: plan → implement → parallel `software-reviewer` + `security-reviewer` → triage → `tech-writer` → final gate. Agents are defined in `.claude/agents/`.
