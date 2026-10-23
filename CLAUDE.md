# Rate Limiter

Rate-limiter service per `docs/requirements/Rate-Limiter-Coding-Exercise.md`.
Design: `docs/architecture/high-level-design.md` (HLD). Stack: `docs/architecture/tech-stack-plan.md`.
Design docs were updated to HLD Draft v5 (auth, client cap, protected `/metrics`, no-refund reconfiguration).
Behaviour reference: `docs/functional-spec.md`; API: `docs/api/openapi.yaml`; load testing: `docs/load-testing.md`.

## Stack
Node 24 LTS, TypeScript 6.0.3 (`strict`), pnpm 12 (via Corepack), `node:http` (no framework), zod 4, pino 10.
Tests: jest + ts-jest, autocannon for load. Lint/format: eslint + typescript-eslint (strict type-checked), prettier.
Runtime dependencies are kept to two (zod, pino) — do not add libraries without discussion.
pnpm blocks dependency build scripts; the allowed ones (esbuild, unrs-resolver) are in `pnpm-workspace.yaml`.

## Commands
- `pnpm lint` (eslint + prettier check) / `pnpm typecheck` / `pnpm test` (jest with coverage) / `pnpm build` — must all pass before review
- `pnpm test` enforces **100%** statement/branch/function/line coverage over `src/**` and `bench/lib/**` (`src/main.ts` excluded). New code needs tests for every branch; avoid unreachable fallbacks (`?? default`, `?.`) instead of ignoring coverage.
- `pnpm bench` (latency, pass/fail), `pnpm bench:capacity`, `pnpm bench:hot` — autocannon runs; needed when the hot path changes. Spawns `dist/main.js` (run `pnpm build` first) or use `--url`. Do not run full-length load tests unprompted; use `pnpm bench --duration 3 --warmup 1 --out <tmp dir>` for smoke checks.
- `pnpm dev` — tsx watch; `pnpm start` — `node dist/main.js`. Both need `ADMIN_API_KEYS` (SHA-256 hex digest of an admin key) in the environment; `pnpm gen-key` prints a new key and its digest.
- `/configure` and `/metrics` need the header `X-API-Key: <key>`. The bench harness mints an ephemeral key when it spawns the server; with `--url` set the `BENCH_API_KEY` environment variable (there is deliberately no `--api-key` flag: it would show up in `ps`).

## Layout
```
src/domain/         pure model + sliding-window math (no I/O)
src/application/    use cases (CheckRateLimit, ConfigureLimit, GetMetrics) and ports/
src/adapters/in/    schemas.ts (shared zod schemas), http/ (server, router, handlers, body-reader, http-errors)
src/adapters/out/   in-memory config repo + counter store, metrics, clock, pino logger, runtime info, sha256-api-key-verifier (also `createApiKeyPair`)
tools/              gen-api-key.ts (`pnpm gen-key`), serve-api-docs.ts (`pnpm docs:api`: builds `dist-docs/`, serves the OpenAPI page and opens a browser); excluded from coverage
src/bootstrap/      env.ts, seed-loader.ts, app.ts (composition root; startApp), startup-error.ts
src/main.ts         3-line entry; keep logic out of it
bench/lib/          pure, unit-tested harness logic; bench/harness/ impure (spawn, autocannon, sampler); bench/run.ts
test/               mirrors src/; helpers/ has FakeClock, RecordingLogger, startTestApp (real server on port 0 with a generated admin key; `send`/`postJson` attach it automatically for `/configure` and `/metrics`, pass `apiKey: null` to test unauthenticated calls)
config/clients.json sample seed file (illustrative clients)
```
Env vars (`src/bootstrap/env.ts`): `ADMIN_API_KEYS` (required, 1–10 comma-separated SHA-256 hex digests; startup fails without it), `PORT` (3000), `HOST` (0.0.0.0), `SEED_FILE` (config/clients.json), `LOG_LEVEL` (info), `SWEEP_INTERVAL_MS` (30000), `SHUTDOWN_GRACE_MS` (5000; in-flight requests get this long on SIGINT/SIGTERM before connections are cut), `MAX_CLIENTS` (100000; `/configure` beyond it → 409, seed file larger than it → startup fails).

## Invariants (HLD refs)
- Hexagonal architecture: core (domain + application) depends on ports only; adapters live at the edge; wiring only in `bootstrap/app.ts`.
- `CounterStore.consume()` is atomic because its in-memory body is **synchronous** (no `await`, no I/O inside). The port is async; the single `await` is outside the critical section (§5.1, §5.2).
- No `cluster` / `worker_threads` for request handling (state would split across isolates).
- Configs are never evicted, so the client count is capped (`MAX_CLIENTS`, enforced in `InMemoryConfigRepository`; `ClientLimitReachedError` is not a fail-closed case); counters are idle-evicted (`> 2×W`) by a `setInterval(...).unref()` sweep that runs in synchronous slices of 5000 counters (continued via `setImmediate`), so a pass never stalls the loop (§5.3). A config snapshot older than the counter state's `configVersion` never rebases it.
- Fail-closed on internal failure (§7): the only mapping of unexpected errors to policy is the use-case seam (`ServiceUnavailableError` → 503); the HTTP layer catches anything else as 503 too. Never return 200 on an error.
- Admin auth (HLD §6.5): `/configure` and `/metrics` require `X-API-Key`; the check happens **before** `Content-Type`/body handling and after 404/405 routing; failures are a uniform 401. Keys exist in the service only as SHA-256 digests compared with `timingSafeEqual` against every digest; never log, echo or put keys (or full digests) in metrics, errors or bench reports — only the 8-char `keyId`/`actor`. `/ratelimit` stays open by design.
- Reconfiguration never refunds usage: a window change goes through `rebase()` (usage moves into a legacy amount that keeps its old decay schedule; merged changes keep the later deadlines; `retry_after` is found by bisection while it is active; the sweep does not evict state with active legacy usage); a limit-only change keeps counters. Tested with a big→tiny→wait→big sequence. Do not reintroduce counter resets on config changes.
- Bounded body reader (413, 1 KB), `Content-Type: application/json` check (415), explicit server timeouts with `connectionsCheckingInterval` 1 s, `maxConnections`.
- One zod schema module (`adapters/in/schemas.ts`) serves both HTTP endpoints and the seed file; messages state field + min/max. Bounds live in `domain/config.ts`.
- Metrics recording is O(1) and allocation-free on the hot path; route labels are low-cardinality (unknown paths → `UNMATCHED`).
- No per-decision info logging; log config changes (old→new), fail-closed events, startup errors, and shutdown (start, forced close, done).
- Tests inject a fake `Clock`; do not use Jest fake timers.

## Known design notes
- 401/404/405/415 rejections send `Connection: close` because the body is left unread.
- `ADMIN_API_KEYS` entries are validated as 64-hex SHA-256 digests; the digest of the empty string is refused, and the verifier never authenticates an absent/empty key.
- `GET /metrics` is an approved addition (HLD §10.1 #17), protected by the admin key. HLD and tech-stack were deliberately updated for the auth/cap/metrics/no-refund decisions (Draft v5).
- Key revocation requires a restart; failed authentication is counted (`errors.unauthorized`) but neither logged nor throttled. Documented limits, not bugs.
- The sliding-window counter is an approximation and is stricter than "N per W" at small limits (e.g. N=1 admits roughly one request per 2W). This is documented in `docs/functional-spec.md`.

## Docs
Documentation lives only in `README.md` and `docs/`. Design docs (HLD, tech-stack) are changed deliberately, not as a side effect.

## Workflow
Use `/build-feature <task>` for non-trivial work: plan → implement → parallel `software-reviewer` + `security-reviewer` → triage → `tech-writer` → final gate. Agents are defined in `.claude/agents/`.
