# Rate Limiter Service — High-Level Architecture & Design

Status: **Draft v5**. v4 (architect review answers, §10) plus decisions taken during implementation: admin API-key authentication for `/configure` and `/metrics`, a client cap, a protected `/metrics` endpoint and no-refund reconfiguration (§10.1 #5, #11, #14, #17, #18). The implementation follows this document; the stack is in [tech-stack-plan](./tech-stack-plan.md).
Source requirements: [Rate-Limiter-Coding-Exercise](../requirements/Rate-Limiter-Coding-Exercise.md).

Conventions used in this doc:
- **[Req]** = stated in the requirements. **[Decision]** = confirmed by the architect. **[Assumption]** = my proposal, not yet confirmed. **[Open]** = needs an answer (see §10).
- No performance numbers are claimed. Memory/latency statements are about *growth characteristics*, to be validated by measurement later.

---

## 1. Problem Understanding

### 1.1 What the service does
Callers ask "may this client make this request now?" (`POST /api/v1/ratelimit`) and get an allow/deny decision with `remaining` and, on deny, `retry_after` seconds. Operators set limits (`POST /api/v1/configure`): a window length and a max request count per window. **[Req]**

### 1.2 Requirements we must satisfy
| Area | Requirement | Source |
|---|---|---|
| Throughput | 1000+ requests/sec | Req |
| Latency | < 10 ms per decision | Req |
| Correctness | Thread-safe; correct under concurrent requests | Req |
| Per-client limits | Different limits per `client_id` | Req |
| Deployment | Works correctly on a single machine, no external services required; may be *designed to be extensible* to them | Req |
| State | In-memory only; reset on restart. Known default clients are seeded at startup with a default window/limit | Decision |
| Unknown clients | Rejected | Decision |
| Bounds | `window_seconds` 1–300; `request_per_window` 1–500; `client_id`/`resource` ≤ 36 chars | Decision |
| Auth | `POST /configure` and `GET /metrics` require an admin API key (`X-API-Key`, §6.2); `/ratelimit` stays open | Decision |
| Client cap | At most `MAX_CLIENTS` configured clients (default 100000); `/configure` beyond it → 409 (§5.3) | Decision |
| Observability | `GET /metrics` JSON (protected): request/decision/error counts, latency histogram, active keys, evictions, process memory (§9) | Decision |
| Failure policy | Fail-closed (§7) | Decision |
| Extensibility | Hexagonal (ports & adapters); a shared-store (e.g. Redis) backend is a supported future evolution but will not be built now | Decision |

### 1.3 Spec change needed
The given `/configure` body has only `window_seconds` and `request_per_window`, which cannot express per-client limits. **[Decision]** extend it with `client_id`:

```json
{ "client_id": "string",
  "window_seconds": integer, "request_per_window": integer }
```
`resource` is not included because limits are per client and `resource` has no effect on decisions **[Decision]**. `/configure` creates the client if `client_id` is not yet known, otherwise updates it (upsert). The response echoes the stored configuration (including `client_id`). This is a deliberate, additive deviation from the provided spec and should be called out in the write-up.

### 1.4 Problem beyond the stated requirements
The functional surface is tiny; the difficulty is in the following (each is addressed below):

1. **Atomic check-and-consume on a hot key.** Decision + counter update must be one indivisible step, or concurrent requests over-admit.
2. **Algorithm accuracy vs. memory vs. latency** (§3).
3. **Key cardinality.** `/ratelimit` rejects unknown clients, but `/configure` can add them. `/configure` now requires an admin API key and the number of configured clients is capped (`MAX_CLIENTS`, default 100000), so memory is bounded and only key holders can grow it (§5.3).
4. **Safe live reconfiguration** while decisions are in flight (§6).
5. **Time handling.** Window math depends on a clock; wall-clock jumps must not grant or deny incorrectly.
6. **Failure policy** — what a caller gets when the limiter itself is unhealthy (§7).
7. **Evolvability to a shared store** without redesign (§8).
8. **Ambiguity in the spec** (config resolution, behavior for unconfigured clients, persistence) (§10).

---

## 2. Scope & Semantics

- **Limit key**: `client_id` only **[Decision]**. `resource` is accepted and validated (≤ 36 chars) but has no effect on decisions. It is kept in the inbound port so per-resource limits can be added later without an API break.
- **Known clients**: at startup the known clients are seeded from a **static configuration file** that lists each `client_id` with its own window and limit **[Decision]**. Limits are adjusted per client via `/configure`, which may also add new clients. A `client_id` with no configuration is **rejected** by `/ratelimit`, not defaulted **[Decision]**.
- **Bounds [Decision]**: `window_seconds` 1–300, `request_per_window` 1–500, `client_id`/`resource` ≤ 36 chars.
- **`remaining`**: requests still permitted in the current window after this decision (integer, ≥ 0).
- **Protected routes**: `POST /configure` and `GET /metrics` require a valid admin API key; `POST /ratelimit` is deliberately open because it is the high-volume path used by the protected system's callers. Unknown paths and wrong methods (404/405) are answered before authentication.
- **`retry_after`**: whole seconds until a retry could succeed; present only when `allowed=false`. Rounded **up** so a client that waits exactly this long is not rejected again for rounding reasons.
- Denied requests **do not consume** quota (otherwise a client hammering while blocked extends its own lockout). **[Assumption]**

---

## 3. Algorithm Analysis

All four candidates evaluated against our requirements (limit = `N` requests per `W` seconds, per key; O(1) decisions are needed for the 10 ms budget at 1000+ RPS).

| Algorithm | Per-key state | Time per decision | Accuracy vs. "N per W" | Notes |
|---|---|---|---|---|
| **Fixed window counter** | 1 counter + window id → O(1) | O(1) | Poor at boundaries: up to **2N** requests can pass in a span of W straddling two windows | Simplest, cheapest |
| **Sliding window log** | Timestamp per accepted request → **O(N)** | O(1) amortized insert, plus pruning of expired entries (O(k) for k expired) | Exact | Memory scales with the *limit*, not just key count: large `N` × many keys is the worst case; denied/blocked traffic still forces pruning work |
| **Sliding window counter** | 2 counters (current + previous window) + window id → O(1) | O(1) | Approximate: assumes the previous window's requests were evenly spread. Bounded error, no 2N boundary burst | Good accuracy/cost compromise |
| **Token bucket** | Token count + last-refill time → O(1) | O(1) | Models "average rate N/W with burst capacity N", which differs from a strict window: can admit up to N immediately then N/W per second sustained | Natural, exact `retry_after`; semantics differ from "N per window" |

### 3.1 Recommendation: **Sliding window counter**
Rationale against *our* requirements:
- The API is expressed as "N requests per W-second window", so a window-based model matches the contract literally; token bucket would need an interpretation (burst vs. rate).
- O(1) memory per key and O(1) time per decision, independent of `N`. Sliding log's per-key memory grows with `N`, which is operator-controlled and not bounded by the requirements.
- Removes fixed-window's 2N boundary burst, which would make the limit unreliable as a protective control.
- Cost: approximate counts. **[Decision]** The architect accepts this approximation; exact enforcement (sliding log) is not worth its memory cost.

**Decision formula (conceptual)**, with `elapsed` = time into the current window:
`estimated = prev_count × (1 − elapsed/W) + curr_count`. Allow if `estimated + 1 ≤ N`.

**`retry_after`** is the earliest time at which that inequality would hold given no further traffic. It has a closed form (solve for `elapsed`) that must be verified with tests for edge cases (e.g. `prev_count` = 0, N = 1) before we rely on it. Runner-up if `retry_after` precision proves troublesome: token bucket.

### 3.2 Memory/latency growth summary
- State: **O(number of active keys)**, constant per key (key string + two counters + window id + config version).
- Decision time: O(1), dominated by key lookup and contention on the per-key critical section, not by arithmetic.
- Eviction (see §5.3) keeps active keys bounded to keys seen within a recent horizon.

---

## 4. Architecture (Hexagonal)

```
        Driving (inbound) adapters                Driven (outbound) adapters
   ┌───────────────────────────────┐        ┌────────────────────────────────┐
   │ HTTP adapter                  │        │ CounterStore adapter           │
   │  POST /ratelimit              │        │   - in-memory (now)            │
   │  POST /configure              │        │   - shared store (future)      │
   └──────────────┬────────────────┘        │ ConfigRepository adapter       │
                  │ calls                   │   - in-memory (now)            │
        ┌─────────▼──────────┐              │   - durable/shared (future)    │
        │  Application core  │──────────────▶ Clock adapter                  │
        │  CheckRateLimit    │  ports       │ Metrics/Logging adapter        │
        │  ConfigureLimit    │              └────────────────────────────────┘
        │  Algorithm (domain)│
        └────────────────────┘
```

### Ports
- **Inbound**: `CheckRateLimit(client_id, resource) → Decision`; `ConfigureLimit(client_id, window, limit, actor) → Config`.
- **Authentication** (driven port `ApiKeyVerifier`): `verify(presented key) → { keyId } | none`. The HTTP adapter calls it for protected routes **before any body is read**; the SHA-256/`timingSafeEqual` implementation is an adapter, so the credential store can later move to an identity provider without touching the core. `keyId` (first 8 hex characters of the key's digest) is non-secret and identifies who made a change in the audit log.
- **Outbound**
  - `ConfigRepository`: resolve effective config for a key; atomically store a new config version.
  - `CounterStore`: a single **atomic `consume(key, config) → Decision`** operation. This must be one operation, **not** separate get/set, so that (a) the in-memory adapter can guard it with a per-key critical section and (b) a shared-store adapter can implement it as one server-side atomic script/transaction. This is the most important evolvability constraint in the design.
  - `Clock`: monotonic time source (injectable for deterministic tests).
  - `Metrics/Logging`.
- **Domain**: the sliding-window-counter math lives in pure domain code with no I/O, so it is reused unchanged by any store adapter. **[Assumption]** For a shared store, the algorithm may need to be expressed inside the store's atomic operation; the contract is on `consume`, not on where the math runs.

### Why the boundary sits at `consume`
Anything coarser (e.g. `get state` / `put state`) forces optimistic retries or locks across a network in the multi-node future, and would not preserve correctness.

---

## 5. Data Flow: Rate-Limit Request

Abstract, implementation-free:

1. **Receive & validate** `client_id`, `resource`. Reject missing or over-length (> 36 chars) input with a client error (not a rate-limit decision).
2. **Resolve config** for `client_id`. Read a single immutable config snapshot (with its version); use that same snapshot for the whole decision.
3. **Unknown `client_id`** (no config) → reject with an error response (**404**, JSON error body); no state is created.
4. **Atomic consume** on `CounterStore` for the key:
   1. Read the key's state; if absent, or its stored config version/window is stale (see §6), initialise fresh state.
   2. Advance the window if the current window has elapsed (rolling current → previous; if ≥ 2 windows elapsed, previous becomes 0).
   3. Compute the estimate (§3.1). If `estimate + 1 ≤ N`: increment current, `allowed=true`, `remaining = N − ceil(estimate + 1)` floored at 0. Otherwise `allowed=false`, compute `retry_after`; state unchanged.
5. **Respond** 200 with `allowed`, `remaining`, and `retry_after` when denied. Emit metrics.

Timing source: a monotonic clock for elapsed-time math, so wall-clock adjustments cannot grant or revoke quota. **[Assumption]** (in a multi-node future, nodes need a consistent time reference, or time must come from the shared store).

### 5.1 Concurrency model
- Requests on **different keys** must not serialise against each other.
- Requests on the **same key** serialise on a short per-key critical section covering step 4 only. Critical section is constant-time arithmetic, so contention is bounded by the hot key's request rate.
- Key map access must be safe for concurrent insert/lookup/evict.
- Hot key risk: one very busy key serialises its own traffic; acceptable because the work is O(1) and tiny. Needs measurement against the 10 ms budget.

### 5.2 Correctness invariant
For any key and any real-time window `W`, admitted requests never exceed `N` by more than the algorithm's documented approximation error, regardless of concurrency. Tests must assert this under parallel load (and the approximation bound explicitly).

### 5.3 Memory bound and eviction
- `/ratelimit` for an unknown client creates no state. `/configure` can add clients, but only with an admin API key and only up to `MAX_CLIENTS`. Memory is therefore O(known clients) ≤ the cap, with constant state per client (measured at roughly 400 bytes of heap per client in isolation, about 39 MB at 100000; a measurement of the real config repository and counter store, not a claim about process RSS).
- Two kinds of per-client data differ in what may be evicted:
  - **Counter state** (usage): safe to evict once idle > `2 × W`, since both counters would be zero on next use. Eviction is lossless.
  - **Configuration** (the client's window/limit): *not* safe to evict, because it is the only copy (in-memory only, **[Decision]**); dropping it would turn a known client into an unknown one.
- **[Decision]** The number of configured clients is capped at `MAX_CLIENTS` (default 100000; the seed file counts toward it and a larger seed file refuses to start). A `/configure` call that would create a client beyond the cap returns **409** with a JSON error and stores nothing; updating an existing client always works. Configs are never evicted, so the cap is the only bound on their number. **Residual risk:** a holder of an admin key can fill the cap, which blocks creation of new legitimate clients until restart; each update also writes one audit log line, so log volume is bounded only by the key holders' behaviour. Both are acceptable for an admin-only endpoint.
- Eviction of counter state must not race an in-flight consume (remove under the per-key guard, or re-check after acquiring it).

---

## 6. Data Flow: Configuration Update

### 6.1 Safety requirements
- A concurrent decision sees either the *entire old* or *entire new* config, never a mix (e.g. new `window` with old `limit`).
- Concurrent `configure` calls for the same scope resolve deterministically (last-writer-wins by an atomic version increment), and the response reflects what was actually stored.
- `configure` must not block or noticeably delay decisions.

### 6.2 Mechanism
1. **Authenticate** **[Decision]**: the request must carry a valid admin API key in `X-API-Key` (§6.5). Missing or wrong → **401**, identical body in both cases, before the body is read; nothing stored.
2. **Validate** **[Decision]**: `window_seconds` integer in 1–300; `request_per_window` integer in 1–500; `client_id` non-empty, ≤ 36 chars. Invalid → **400** with a JSON error body whose message states the field and its min/max (e.g. "window_seconds must be between 1 and 300"); nothing stored. An unknown `client_id` is **created** (upsert) unless that would exceed the client cap (409, §5.3).
3. **Build an immutable config value** and atomically publish it to `ConfigRepository` with a monotonically increasing **version** per client; the audit log records the caller's `keyId` (§6.4).
3. Respond 200 with the stored config.
4. **No synchronous sweep** of counter state. Counters are reconciled lazily on next access (§6.3). Cost of `configure` is therefore O(1), independent of number of active keys.

### 6.3 What happens to existing usage (decision analysis)
| Option | Behavior | Pros | Cons |
|---|---|---|---|
| A. Always reset state | New config starts a fresh window | Simplest, always consistent | A client can be handed a free burst by any config touch; a reconfig-spam path (if config API is reachable by clients) defeats limiting |
| B. Always preserve state | Reuse counters under the new config | No free burst | Counters from a different `W` are not meaningful (window boundaries/weights differ), so it cannot be applied when `W` changes |
| **C′. Hybrid, no refund (chosen)** | **Limit-only change** (`N` changes, `W` same): keep counters, apply new `N` immediately. **Window change** (`W` changes): the usage already counted moves into a carried-over ("legacy") amount that keeps its old decay schedule while a fresh window of the new length starts | Preserves continuity whenever mathematically valid; a configuration change, or any sequence of them, never returns quota sooner than the old schedule would have | More state per client (three numbers) and a bisection for `retry_after` while carried usage is active |

**[Decision]** Option C′ (v4 chose option C, which reset counters on a window change; that let any configuration touch hand a client a free burst, so it was replaced). Mechanically: each state record stores the `W` it was built under; on consume, if `W` differs, the store takes the usage under the old `W` (the sliding-window estimate plus any usage still carried from earlier changes) and records it as a carried amount that counts in full until the old window would have rolled and then decays linearly over the following old window (usage that comes only from the previous window decays straight away over the rest of the current one, exactly as it would have); merged changes keep the later of each deadline. The new window starts empty, and a decision counts new usage plus the carried amount. Repeatedly toggling `window_seconds`, including long → short → wait → long, therefore never forgives usage sooner than the schedule it was earned under (a shortened window cannot be used to launder usage). Carried state keeps a client's counters from idle eviction until it has expired. **Deliberate conservatism:** carried usage is a single amount with the latest hold and expiry of its parts, so usage admitted under a short window after a change to a longer one is held as long as the older part (at most about 2× the longest window involved). That can deny a client for longer than any one original schedule would, only for operators who flap window lengths; it is never looser, and a test pins it. Lowering `N` below current usage simply yields denies until usage decays. An authorised caller can still *raise* limits; that is what the admin endpoint is for.
### 6.4 Side effects summary
- Takes effect for *new* decisions after publish; in-flight decisions complete under the snapshot they already read (at most one decision-length of staleness).
- No counter sweep; keys affected are reconciled on next request.
- Config is in-memory only **[Decision]**: after a restart, all clients return to the seeded default policy and usage counters are empty.
- Metrics/log entry on every config change (what/old→new) for audit, including the caller's `keyId` (first 8 hex characters of the key's SHA-256 digest; never the key) **[Decision]**.

---

### 6.5 Admin API key authentication

- **Credential**: a random key (32 bytes, base64url) sent in the `X-API-Key` header. The service never holds plaintext keys: `ADMIN_API_KEYS` contains one to ten comma-separated SHA-256 hex digests. Malformed, duplicate or missing values refuse startup (§11).
- **Check**: the presented value is hashed and compared with every configured digest using a constant-time comparison (no early exit). Missing, empty, repeated or wrong headers all produce the same **401** body, so a caller learns nothing about which part was wrong.
- **Order**: route match (404/405) → authentication (401) → `Content-Type` (415) → bounded body (413) → JSON (400) → validation (400) → use case. Unauthenticated callers therefore cannot make the service buffer or parse a body.
- **Rotation**: add the new digest next to the old one, restart, move callers to the new key, then remove the old digest and restart. Revocation requires a restart in this design (keys are not reloaded at runtime).
- **Audit**: every configuration change logs the matching key's `keyId`; failed attempts are counted in the `unauthorized` error metric but not logged individually, to avoid unauthenticated log flooding.
- **Out of scope / known limits**: no throttling of failed attempts (a 256-bit random key cannot be guessed, but floods are cheap to send; the connection cap and timeouts in §7 still apply), no per-key permissions (every key may change every client), no TLS termination (run behind a trusted network boundary or proxy).

## 7. Failure Policy: Fail-Closed

**[Decision]** The service **fails closed**: when the limiter cannot reach a trustworthy decision, the request is **not allowed**.

**Why this is the right default right now.** Fail-open vs. fail-closed is hard to settle without knowing what the limiter protects. Absent that knowledge we take the cautious side: an unnecessary deny is recoverable (the caller retries), while an unlimited allow during a fault may coincide with exactly the abuse the limiter exists to stop, and cannot be undone. **This decision is explicitly revisitable** once a concrete protected system exists; the policy is isolated behind a single seam (below) so changing it is a localized change.

**What can fail?** On a single node with in-memory state the catchable failures are narrow: an internal fault in the decision path, an unresolvable/corrupt config or state record, or resource exhaustion. With a future shared store, store timeouts/outages become the dominant class.

| Class | Behavior | Notes |
|---|---|---|
| Malformed request (bad/missing/over-length `client_id`/`resource`) | Client error (4xx) with a descriptive message | Caller bug, not a limiter fault |
| Missing or invalid admin API key on `/configure` or `/metrics` | **401**, uniform JSON body, `WWW-Authenticate: ApiKey` | Not a fault; checked before the body is read |
| Unknown `client_id` on `/ratelimit` | **Rejected**: 404 with JSON error body | Policy per **[Decision]**, not a fault |
| `/configure` would exceed the client cap | **409** with JSON error body | Policy per **[Decision]**, not a fault (§5.3) |
| Internal error in decision path | **Fail-closed**: **503** with JSON error body; never a 200 | Callers must treat non-200 as deny **[Decision]** |
| Config/state record cannot be resolved or fails validation | **Fail-closed**; never fall back to "unlimited" | |
| Resource exhaustion | **Fail-closed** (503) | Client cap (§5.3) is the main guard |
| Future shared-store outage | Fail-closed by default; any degraded local mode is a separate, explicit decision | Decide when that adapter is built |

**Constraints on the response.** The success body must match the spec exactly (**[Decision]**: no extra marker fields). Therefore fail-closed outcomes are signalled out-of-band from the 200 body (status code and/or error body), and are made observable through metrics and logs.

**Observability.** Error counter by class with an alert threshold; fail-closed events logged with enough context to diagnose. A sustained fail-closed rate means the protected system is being denied service, so it must page, not just log.

**The seam.** The application core wraps the decision path in one place that maps "unexpected error" to the failure policy; adapters never decide policy themselves.

---

## 8. Evolution to a Shared Store (Not Built Now)

What changes: new `CounterStore` and `ConfigRepository` adapters; what must not: domain algorithm contract, inbound ports, HTTP adapter.

Design-time obligations to keep that path open:
- `consume` is atomic and single-call (§4).
- Config versions are comparable across nodes.
- Time source is abstracted (§4); multi-node needs agreed time.
- Key-state schema is compact, serialisable and versioned.
- Eviction expressed as TTL (idle `2×W`), which maps to typical store expiry.
- Failure policy per class (§7) already separated from the algorithm.

Known costs of that future (not designed here): a network hop inside the 10 ms budget, hot-key concentration on one shard, and cross-node config propagation delay.

---

## 9. Non-Functional Design Notes
- **Throughput 1000+ RPS**: O(1) work per request and no global lock on the hot path. To be proven by load tests; no claim made here.
- **Latency <10 ms**: the budget covers server-side decision; critical sections must stay trivial, with no I/O inside them in the in-memory adapter.
- **Observability**: decision counts (allowed/denied), latency histogram, active-key count, evictions, config updates, fail-closed events, unauthorized attempts. Exposed by `GET /metrics` (JSON, protected by the admin API key). Latency is measured from the point the handler starts until the response is handed to the socket, so it excludes network and queueing time.
- **Testability**: injectable clock; deterministic algorithm tests; concurrency tests asserting the §5.2 invariant; config-update-during-load tests.

---

## 10. Decisions Taken and Remaining Questions

### 10.1 Resolved (from architect review)
| # | Topic | Decision |
|---|---|---|
| 1 | Persistence | In-memory only; reset on restart. |
| 2 | Seeding | A **static config file** lists each default `client_id` with its own window/limit; loaded at startup. |
| 3 | Unknown clients | `/ratelimit` rejects them (404, JSON error body). `/configure` **can add** new clients (upsert). |
| 4 | Scope | Limit is **per client**. `resource` is accepted and validated but has **no effect**. `/configure` body is `client_id`, `window_seconds`, `request_per_window` (no `resource`). |
| 5 | Reconfiguration | Hybrid with no refund (§6.3, option C′): limit-only change keeps counters; window change carries the current usage into a fresh window |
| 6 | Accuracy | Sliding window counter's approximation is acceptable |
| 7 | Bounds | `window_seconds` 1–300, `request_per_window` 1–500; validation errors state field and min/max |
| 8 | Key length | `client_id` and `resource`: max 36 characters |
| 9 | Response body | 200 bodies match the spec exactly; no extra fields |
| 10 | Errors | JSON error bodies; 400 validation, 404 unknown client, **503** for internal service errors (never 200 on a real error) |
| 11 | Auth | Admin API key (`X-API-Key`) for `/configure` and `/metrics`; keys supplied to the service only as SHA-256 digests in `ADMIN_API_KEYS` (§6.5); `/ratelimit` open |
| 12 | `retry_after` | Round up to whole seconds |
| 13 | Failure policy | **Fail-closed**, revisitable once a protected system exists (§7) |
| 14 | Client cap | `MAX_CLIENTS`, default 100000; beyond it `/configure` returns 409 (§5.3) |
| 15 | Startup config file | Static file seeds state at startup only. Missing, unparsable or out-of-bounds content → the service **refuses to start** and prints a clear error message (§11). Runtime `/configure` changes are never written back and are lost on restart. |
| 16 | Error body | `{"error": "<message>"}`; validation errors add the offending field and its min/max. |
| 17 | Metrics endpoint | `GET /metrics` (JSON) is part of the service and is protected by the admin API key (§9). Supersedes the v4/tech-stack "no endpoint" note |
| 18 | Key provisioning | Digests in the `ADMIN_API_KEYS` environment variable (several allowed for rotation); keys are generated with `pnpm gen-key`; revocation = remove the digest and restart (§6.5) |

### 10.2 Remaining open questions
None blocking. Items to revisit later: failure policy once a protected system exists (§7), the sliding-window `retry_after` derivation, which is verified by tests (§3.1), and the following known limits of the auth design (§6.5): revoking a key requires a restart, failed authentication attempts are counted but not throttled, and every admin key can change every client.

---

## 11. Startup Flow

1. Load the environment: `ADMIN_API_KEYS` (required: 1–10 distinct SHA-256 hex digests) and the other settings. A missing or malformed value refuses to start.
2. Load the static config file. Validate every entry against the same bounds as `/configure` (window 1–300, limit 1–500, `client_id` ≤ 36 chars, no duplicate `client_id`) and check the entry count against `MAX_CLIENTS`.
3. On any failure: print a clear error naming the variable or file, the offending entry/field and the violated bound (never a key or digest), then exit non-zero. No partial start and no skipping of bad entries (consistent with fail-closed, §7).
4. On success: publish each entry as version 1 of that client's config, then begin accepting requests.
