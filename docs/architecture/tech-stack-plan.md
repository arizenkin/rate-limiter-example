# Rate Limiter — Tech Stack Decision

Status: **Approved v1** (2026-10-21). Companion to [high-level-design.md](./high-level-design.md) (Draft v4), which intentionally selected no tech stack.

## Context
This document settles every language, tool and library so implementation can start. For runtime choices the priority is **performance and low memory over developer convenience**. Every version below was checked against the npm registry, Docker Hub or the official nodejs/Release `schedule.json` on 2026-10-21. Benchmarks are third-party and treated as directional only; our own load test is the evidence.

## Runtime / language
| Item | Choice | Rationale / verification |
|---|---|---|
| Runtime | **Node.js 24 LTS** (pin `24.22.x`, `engines: ">=24.22 <25"`) | Architect decision. Installed locally (v24.22.0). Official schedule: Maintenance since 2026-10-20, EOL 2028-04-30. Node 26 (LTS 2026-10-28, EOL 2029-04-30) is a later upgrade path. |
| Language | **TypeScript 6.0.3** (not 7.x) | `latest` on npm is 7.0.2, but verified peer ranges exclude it: `typescript-eslint@8.72.0` needs `<6.1.0` and `ts-jest@29.4.15` needs `<7`. Revisit once they support 7. `strict: true`. Build with `tsc` to `dist/`; production runs plain `node dist/...` with no runtime transpiler. |
| Package manager | **pnpm** (latest 12.14.0; pin via `packageManager` + Corepack) | Already decided. Not installed locally yet; enable with `corepack enable` before work starts. |

## Runtime dependencies (kept to 2)
| Need | Choice | Why |
|---|---|---|
| HTTP server | **`node:http` built-in**, no framework | fastify/benchmarks (2026-10-19, Node 24.22, 4 vCPU, hello-world GET): bare node-http 89.3k req/s vs Fastify 91.5k, polka 90.2k, 0http 96.6k. The framework doesn't decide throughput; dependency count and memory do. Two routes = a `switch` on method+URL. We write: a bounded body reader (413 above a small cap, e.g. 1 KB), a `Content-Type: application/json` check, `JSON.parse`, then 404/405 handling. Set `server.keepAliveTimeout` / `headersTimeout` / `requestTimeout` explicitly. |
| Validation | **zod 4** (`zod@4.6.7`) | Schemas are tiny. `z.int().min().max()` produces the HLD §6.2 field/min/max messages, and types are inferred. One schema module is shared by `/ratelimit`, `/configure` and the startup seed-file loader (HLD §11). Use `safeParse` (no exceptions on the hot path), defined once at module load. Published speed comparisons vs Ajv/TypeBox are unverified secondary numbers, so the load test confirms it fits the budget. |
| Logging | **pino 10** (`pino@10.4.0`) | Structured JSON logs for config changes (old→new), fail-closed events and startup errors (HLD §6.4, §7, §11). Info level is **not** logged per decision on the hot path. `pino-pretty@13.2.0` is a devDependency for local readability only. |

### Uncommon alternatives considered
- **uWebSockets.js**: older third-party benchmarks show it faster than node:http. Rejected because it is not on the npm registry (installed from a GitHub tag), ships a native binary (Alpine/musl support not verified), and has a callback-based streaming body API.
- **Fastify 5**: throughput close to node:http, but brings Ajv, avvio, find-my-way, light-my-request and more, none of which a 2-route service needs.

## No extra libraries needed

### Caching rate limits / configs: none
Use native `Map<string, …>`.
- **Config store**: `Map<clientId, Readonly<Config>>`. Replacing the frozen object reference is the HLD §6.1 atomic publish with a version number. Configs must never be evicted (HLD §5.3), which rules out LRU caches like `lru-cache`; they evict by size or recency.
- **Counter store**: `Map<clientId, CounterState>`. Idle eviction (`> 2×W`, HLD §5.3) runs as a periodic sweep on a `setInterval(...).unref()`.

### Atomic updates: none
JavaScript on Node runs on a single thread, and a synchronous function runs to completion without interleaving. So `CounterStore.consume()` is atomic as long as it is **synchronous (no `await`, no I/O inside)**. That gives HLD §5.1's per-key critical section with no locks. Constraints for implementation:
- **Port shape**: the `consume` port is **async** (so a future Redis adapter fits without changing the core). The in-memory implementation does all its work synchronously and returns a resolved value; the single `await` sits outside the critical section.
- **No `cluster` / `worker_threads`** for request handling. They would split state across isolates and break correctness. One process scales vertically; the benchmark above suggests 1000 RPS is far below one core's capacity, to be confirmed by load test.
- **The eviction sweep** also runs synchronously on the event loop, so it cannot race `consume` (satisfies HLD §5.3).

### Other built-ins instead of libraries
- **Monotonic clock**: `performance.now()` (global in Node 24) behind the `Clock` port. Tests inject a fake clock instead of using Jest fake timers.
- **JSON**: built-in `JSON.parse` / `JSON.stringify`. zod strips unknown keys, so no `secure-json-parse` is needed.
- **Config seed file**: JSON (HLD §11), read with `node:fs` and validated by the same zod schema. No YAML library.
- **Metrics**: behind the HLD Metrics port with an in-memory/no-op adapter, no endpoint. No `prom-client`.

## Dev tooling
| Need | Choice | Notes |
|---|---|---|
| Unit/integration tests | **jest 30.5.2 + ts-jest 29.4.15** | Versions verified compatible with each other and with TS 6. Integration tests start the real server on port 0 and call it with Node's global `fetch`, so no `supertest`. |
| Concurrency tests | jest + `Promise.all` bursts of `fetch` against a live server | Asserts the HLD §5.2 invariant (admitted ≤ N + bound) and config-change-during-load. |
| Load / latency test | **autocannon 8.0.0** (devDependency, `pnpm bench`) | Proves ≥1000 RPS and p99 < 10 ms. Last published 2024-10, but it is the tool fastify/benchmarks uses. Alternative if needed: k6 via Docker image. |
| Lint | **eslint 10.13.0 + typescript-eslint 8.72.0** (flat config, type-checked rules), `@eslint/js` 10.0.1 | Peer ranges verified (`eslint ^10`, `typescript <6.1`). |
| Format | **prettier 3.9.10 + eslint-config-prettier 10.1.8** | Added: removes formatting debate; eslint stays focused on correctness rules. |
| Dev run | **tsx 4.23.15** (`pnpm dev` watch) | Dev only; production uses compiled JS. |
| Types | **`@types/node@24.x`** (not `latest` 26.x) | Avoids typing APIs that aren't in our runtime. |
| Source control | **git** | Repo not yet initialised: `git init`, `.gitignore`, `.dockerignore` are first steps. |

## Container
- Multi-stage `Dockerfile`:
  - **Build stage** on `node:24.22.0-alpine` (tag verified on Docker Hub): Corepack pnpm, `pnpm install --frozen-lockfile`, `tsc`, `pnpm prune --prod`.
  - **Runtime stage** on the same base: non-root `node` user, `CMD ["node","dist/main.js"]`, seed config file supplied via volume or `COPY`.
- Optional `docker compose` with an app service and a test target, so `docker compose run test` runs lint + jest + bench in-container.

## Known risks / items to verify at implementation
1. **TypeScript 7 incompatibility** with lint/test tooling: pinned to 6.0.3; revisit later.
2. **Zod hot-path cost**: measure in the bench; fallback is hand-written validation behind the same function signature.
3. **Node 24 is in Maintenance**: upgrading to 26 after 2026-10-28 is a one-line change (engines + base image).

## Verification (once implementation begins)
- `corepack enable && pnpm install` succeeds with no peer-dependency warnings for TS/eslint/jest.
- `pnpm lint`, `pnpm test` and `pnpm build` pass locally and in `docker build`.
- `pnpm bench` runs autocannon against `POST /api/v1/ratelimit` in two modes; record the results in the write-up.
  - **Latency mode** (the pass/fail check): fixed overall rate of about 1000–2000 req/s, a moderate number of connections, **no pipelining**. Passes if p99 latency is < 10 ms. Pipelining and saturation are avoided on purpose: they measure queueing, not decision cost (the fastify benchmark, 100 connections × 10 pipelined, shows ~10 ms even for bare `node:http`).
  - **Capacity mode** (informational): unthrottled, to measure headroom. Only requests/s is reported; it must be ≥ 1000.
  - autocannon's flag for a fixed overall rate and its POST-body options are **not yet verified**; confirm against its docs when writing the script.
  - **Traffic mix**, for both modes:
    - Clients are seeded or configured before the run, so requests never hit the unknown-client 404 path.
    - Requests are spread across many `client_id`s, plus a separate single-hot-client run to exercise per-key contention (HLD §5.1).
    - Both `allowed: true` and `allowed: false` responses occur (limits are capped at 500 per window).
    - `POST /api/v1/configure` calls are interleaved during a run to cover config-update-under-load (HLD §9).

## Sources
- [nodejs/Release schedule.json](https://github.com/nodejs/Release/blob/main/schedule.json)
- [fastify/benchmarks](https://github.com/fastify/benchmarks)
- [uNetworking/uWebSockets.js](https://github.com/uNetworking/uWebSockets.js)
- npm registry metadata (versions, peerDependencies, engines) via `npm view`, 2026-10-21
- Docker Hub `library/node` tags
