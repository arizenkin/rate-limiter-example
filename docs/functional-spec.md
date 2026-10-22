# Functional specification

This document describes what the service does today: endpoints, inputs and limits, the seed file, configuration behaviour, the decision algorithm, errors, logging and metrics. The machine-readable API is in the [OpenAPI document](./api/openapi.yaml). Architecture decisions are in the [high-level design](./architecture/high-level-design.md) (HLD).

## 1. Endpoints

- `POST /api/v1/ratelimit`: decide one request for a client. Body: `client_id`, `resource`. Returns `200` with `allowed`, `remaining` and, when denied, `retry_after`. Open: no API key.
- `POST /api/v1/configure`: create or update a client's limit. Body: `client_id`, `window_seconds`, `request_per_window`. Returns `200` with the stored configuration. Requires the admin API key.
- `GET /metrics`: operational metrics (see section 9). Requires the admin API key.

Paths are matched exactly. The query string is ignored. A trailing slash names a different path, which returns `404`. A known path with the wrong method returns `405`. Both are answered before authentication.

### 1.1 Authentication

`POST /api/v1/configure` and `GET /metrics` require the admin API key in the `X-API-Key` header. `POST /api/v1/ratelimit` is deliberately open: it is the high-volume path, so anyone who knows a `client_id` can use that client's quota.

- The service never holds plaintext keys. `ADMIN_API_KEYS` contains one to ten comma-separated SHA-256 hex digests (64 hex characters each, no duplicates). Keys are generated with `pnpm gen-key`, which prints the key (shown once) and the matching `ADMIN_API_KEYS` value.
- The service refuses to start without `ADMIN_API_KEYS` (section 3.1).
- The key is checked before the request body is read. A missing, empty, repeated or wrong `X-API-Key` gets `401` with the same body in every case (section 6).
- All configured keys have the same permissions. Any key can change any client and read metrics.
- Keys are read at startup only. Adding or removing a digest takes effect after a restart.
- Each successful `/configure` call logs `actor`, the first 8 hex characters of the matching digest (section 8). The key itself is never logged.

## 2. Inputs and limits

| Input                | Rule                  | Notes                                                          |
| -------------------- | --------------------- | -------------------------------------------------------------- |
| `client_id`          | 1 to 36 characters    | Case-sensitive, not trimmed; length in UTF-16 units            |
| `resource`           | 1 to 36 characters    | Validated only; no effect on decisions                         |
| `window_seconds`     | Integer, 1 to 300     | Length of the window (W), seconds                              |
| `request_per_window` | Integer, 1 to 500     | Requests allowed per window (N)                                |
| Body size            | At most 1024 bytes    | Over the limit returns 413                                     |
| `Content-Type`       | `application/json`    | Parameters allowed; missing or other returns 415               |
| Body content         | JSON object           | Arrays, scalars or invalid JSON return 400                     |
| Other keys           | Ignored               | Not an error                                                   |
| Number of clients    | At most `MAX_CLIENTS` | Default 100000; a new client beyond it returns 409 (section 4) |

Only the first failing field is reported. Fields are checked in schema order: `client_id`, then `resource` on `/ratelimit`, or `client_id`, `window_seconds`, `request_per_window` on `/configure`.

The `Content-Type` check is case-insensitive and applies only to `POST`. The body size is checked against `Content-Length` before the body is read. A body without that header is counted while it is read.

## 3. Seed file

At startup the service loads the seed file named by `SEED_FILE` (default `config/clients.json`, relative to the working directory):

```json
{
  "clients": [
    { "client_id": "example-client-a", "window_seconds": 60, "request_per_window": 100 },
    { "client_id": "example-client-b", "window_seconds": 10, "request_per_window": 20 }
  ]
}
```

Rules:

- The top-level value must be a JSON object with a `clients` array. An empty array is valid. The service then starts with no clients, and `/ratelimit` returns `404` for every client until one is configured.
- Each entry follows the same rules as `/configure` (section 2): `client_id`, `window_seconds` and `request_per_window`. Other keys are ignored.
- `client_id` must be unique within the file.
- The file is read once, at startup. Changes made through `/configure` are never written back.

### 3.1 Startup validation

The environment and the seed file are validated before the port opens. Any problem stops startup. No entry is skipped. The process prints one message to stderr with the prefix `Startup failed:` and exits with code 1.

Checks run in this order: environment variables (including `ADMIN_API_KEYS`), then the file can be read, then it is valid JSON, then `clients` is an array, then the entry count is within `MAX_CLIENTS`, then each entry against the bounds, then no duplicate `client_id`. A port that cannot be bound is also a startup failure.

Example, with `window_seconds` out of range:

```text
Startup failed: Seed file 'config/clients.json' is invalid: clients[0]: window_seconds must be between 1 and 300 (min 1, max 300)
```

Other messages:

```text
Startup failed: Invalid environment: ADMIN_API_KEYS is required: comma-separated SHA-256 hex digests of the admin API keys (generate one with `pnpm gen-key`)
Startup failed: Invalid environment: ADMIN_API_KEYS must contain at least one SHA-256 hex digest
Startup failed: Invalid environment: ADMIN_API_KEYS entry 2 duplicates entry 1
Startup failed: Seed file 'config/clients.json' could not be read: ENOENT: no such file or directory, open 'config/clients.json'
Startup failed: Seed file 'config/clients.json' is not valid JSON: <parser message>
Startup failed: Seed file 'config/clients.json' is invalid: clients[1]: duplicate client_id 'example-client-a' (first defined at clients[0])
Startup failed: Seed file 'config/clients.json' is invalid: 3 clients exceed the limit of 2 (MAX_CLIENTS)
Startup failed: Invalid environment: PORT must be between 0 and 65535
Startup failed: Could not listen on 0.0.0.0:3000: listen EADDRINUSE: address already in use 0.0.0.0:3000
```

Environment messages name the variable and the entry position. They never echo a key or digest.

## 4. Configuration behaviour

- `/configure` is an upsert. An unknown `client_id` is created, and a known one is replaced. The response echoes the stored configuration.
- The number of clients is capped by `MAX_CLIENTS` (default `100000`, seed-file clients included). A `/configure` call that would create a client beyond the cap returns `409` with `client limit of <n> reached; existing clients can still be updated`, stores nothing, writes a `warn` log and is counted under `client_limit_reached` in the `errors` metrics. Updating an existing client always works at the cap. Configurations are never evicted, so the cap is the only bound on their number. At about 400 bytes of heap per client (measured in isolation on the config repository and counter store with 36-character IDs: about 39 MB at 100000 clients), the default costs little memory.
- A change applies to the next decision. A decision already in progress finishes with the configuration it read when it started.
- **Limit-only change** (same window): counters are kept and the new limit applies at once. Lowering the limit below current usage gives denials until usage decays.
- **Window change** (`window_seconds` differs): usage is carried over, not reset, so a window change never refunds quota. `/configure` only stores the new configuration. The carry is applied on the client's next `/ratelimit` call, and other clients are not affected.
  Merging is deliberately conservative: carried usage is one amount that takes the latest hold and expiry of its parts. If an operator changes window lengths repeatedly, usage admitted under a short window after a long one is held as long as the older part (at most about twice the longest window involved). A client can therefore be denied longer than any single original schedule would require, but never less long (HLD section 6.3).
  - The usage counted so far (the sliding-window estimate, plus any usage carried over from earlier changes) becomes a carried-over amount. It counts in full until the old window would have rolled, then decays linearly to zero over the following old window. If the old window had no requests yet, it decays straight from the change to the roll.
  - The new window starts empty. New requests count against the new limit together with the carried-over amount.
  - Repeated changes merge into one carried-over amount and keep the later deadline of each part. A short window, a wait and a long window again therefore cannot refund quota.
  - A client with carried-over usage is not idle-evicted until that usage has expired. `retry_after` accounts for it.
  - Carried-over usage can keep a client denied longer than the new window alone would. To give more quota immediately, raise the limit (a limit-only change).
- Every successful `/configure` call is logged with the old and new values and the `actor` (section 8). This includes identical re-submissions. Each successful call is counted in `configUpdates`.
- Changes are held in memory. After a restart each client returns to its seed-file value, with empty counters.

## 5. Decision algorithm

The service uses a sliding window counter (HLD section 3.1). Each client has three values: the start of the current window, the number of requests admitted in the previous window (`prev`), and the number admitted in the current window (`curr`). Time comes from a monotonic clock (`performance.now()`), so wall-clock changes do not affect decisions.

For a `/ratelimit` call on a client with window W seconds and limit N:

1. Roll the window. If one window has passed, `curr` becomes `prev`. If two or more have passed, `prev` becomes 0. In both cases `curr` is reset to 0.
2. Let `elapsed` be the time since the start of the current window. Compute `estimate = prev * (1 - elapsed / W) + curr`.
3. If `estimate + 1 <= N`, the request is allowed. `curr` increases by 1, and `remaining = N - ceil(estimate + 1)`.
4. Otherwise the request is denied. `remaining` is 0, the state does not change, and `retry_after` is the number of seconds until step 3 would succeed if no other traffic arrived. It is rounded up, with a minimum of 1.

Denied requests do not consume quota. They do update the client's last-seen time, which keeps active counter state from being swept.

`remaining` is an estimate of the requests still permitted in the current window. It is never negative.

Carried-over usage from a window change (section 4) is added to the estimate in step 2 and in the `retry_after` search in step 4.

### 5.1 Consequences that surprise people

The algorithm is an approximation. At small limits it is stricter than "N requests per W seconds". A fixed window can admit up to 2N requests across a window boundary, and this algorithm avoids that. The cost is that a client which used its full N in one window does not get N fresh slots at the next roll, because the previous window still counts, with decreasing weight, against the new one.

Example with N = 1 and W = 5 s:

- t = 0 s: allowed.
- t = 1 s: denied with `retry_after` 9. The next request is allowed at t = 10 s.

At t = 5 s the one admitted request becomes `prev` with full weight. It then decays linearly to zero over the next window, so the slot opens only at t = 10 s. These values match `test/domain/sliding-window.test.ts`. Under continuous traffic, a client with N = 1 gets roughly one allowed request every two windows. That figure follows from the formula and is not tested separately.

Example with N = 2 and W = 5 s:

- t = 0 s: two requests, both allowed.
- t = 0 s: a third request is denied with `retry_after` 8. The formula allows the next request at 1.5 W = 7.5 s, and `retry_after` rounds that up.

After a full burst a client waits about 1.5 W. Under sustained overload the service admits roughly N - 1 requests per window. For N = 1 that is about one request every two windows, as described above.

## 6. Errors and fail-closed

| Status | When                                                 | Body                                                 |
| ------ | ---------------------------------------------------- | ---------------------------------------------------- |
| `200`  | Decision made, or configuration stored               | Decision or configuration                            |
| `400`  | Validation failed, invalid JSON, body not an object  | `error`, plus `field`, `min`, `max` for range errors |
| `401`  | Missing or wrong `X-API-Key` (protected routes)      | `error`, `WWW-Authenticate`, `Connection: close`     |
| `404`  | Unknown `client_id` on `/ratelimit`, or unknown path | `error`                                              |
| `409`  | `/configure` would exceed `MAX_CLIENTS`              | `error`                                              |
| `405`  | Known path, wrong method                             | `error`, with `Allow` header                         |
| `413`  | Body over 1024 bytes                                 | `error`, `Connection: close`                         |
| `415`  | Missing or non-JSON `Content-Type` on POST           | `error`                                              |
| `503`  | Fail-closed (section 6.1)                            | `error`, with `Retry-After: 1`                       |

Callers should treat `409` as "not stored". Denied decisions are `200` with `"allowed": false`, as the exercise specifies. The service never returns `429`.

Error bodies are JSON objects with an `error` field. A range error also includes `field`, `min` and `max`:

```json
{
  "error": "window_seconds must be between 1 and 300",
  "field": "window_seconds",
  "min": 1,
  "max": 300
}
```

Messages the service can return:

- `missing or invalid API key`: the `401` body. It is the same for a missing, empty, repeated or wrong key. The response carries `WWW-Authenticate: ApiKey` and `Connection: close`, and the request body is not read.
- `client_id is required`, `client_id must be a string`, `client_id must be between 1 and 36 characters` (`resource` uses the same wording)
- `window_seconds must be an integer`, `window_seconds must be between 1 and 300` (`request_per_window` uses 1 to 500)
- `request body must be a JSON object`, `request body must be valid JSON`
- `request body must not exceed 1024 bytes`
- `Content-Type must be application/json`
- `method not allowed; use POST` (or the method the route accepts)
- `route not found`
- `client_id 'ghost' is not configured`

Checks run in this order: route, then method, then authentication (`/configure` and `/metrics`), then `Content-Type` (POST), then body size, then JSON parsing, then field validation, then client lookup.

### 6.1 Fail-closed

If the decision or the configuration update fails for an unexpected reason, the service returns `503` with `Retry-After: 1` and a JSON body, and logs the error. A failure never allows a request.

- Decision path failure: `{"error":"rate limiter is unable to make a decision; treat the request as denied"}`.
- Any other unexpected error: `{"error":"internal error; treat the request as denied"}`.

Callers must treat any non-`200` response as a denial. That includes `400`, `401`, `404` and `503`. In the `errors` metrics (section 9), the first case counts as `fail_closed` and the second as `internal`.

## 7. HTTP server limits

These values are fixed in the code and cannot be changed with environment variables.

- Request body: at most 1024 bytes.
- Keep-alive timeout: 5 s. Idle keep-alive connections are closed after this.
- Headers timeout: 10 s. The request headers must arrive within this time.
- Request timeout: 15 s. The whole request must arrive within this time.
- Timeout check interval: 1 s. Node's default is 30 s, which would stretch the two timeouts.
- Maximum connections: 10,000. Connections beyond this are closed by Node.

## 8. Logging

Logs are JSON lines written by pino to stdout. The level comes from `LOG_LEVEL` (default `info`).

The service does not log individual decisions. An allowed or denied request writes nothing to the log. Failed authentication attempts are not logged either. They are counted in the `unauthorized` error metric (section 9).

Events:

- `client configuration changed` (info): `clientId`, `actor`, `old` and `new`. `actor` is the first 8 hex characters of the SHA-256 digest of the key that made the change. It identifies the key and is never the key itself. `old` and `new` are objects with `windowSeconds`, `requestPerWindow` and `version`, or `null` for a new client.
- `rate limiter listening` (info): `port`, `host`, `seededClients`.
- `fail-closed: rate limit decision failed` (error): `clientId`, `err`.
- `fail-closed: configuration update failed` (error): `clientId`, `err`.
- `fail-closed: unexpected error while handling request` (error): `err`.
- `failed to write response` (error): `err`.
- `client limit reached; configuration rejected` (warn): `clientId`.
- `http server error` (error): `err`, for listener errors after startup.

Startup failures are not logged through pino. They are printed to stderr as `Startup failed: ...` (section 3.1).

At `LOG_LEVEL=warn` or higher, the info events are not written. That includes configuration changes, so the audit trail needs `info` or lower.

## 9. Metrics

`GET /metrics` returns a snapshot of in-memory counters. The counters reset on restart. The endpoint requires the admin API key (section 1.1). It does not include client IDs.

- `requests`: counts keyed by `"<route> <status>"`, for example `POST /api/v1/ratelimit 200`. Unmatched paths are counted under `UNMATCHED`. Wrong methods are counted under `METHOD_NOT_ALLOWED`. Every handled request is counted, including requests to `/metrics` and rejected admin calls, for example `POST /api/v1/configure 401`.
- `decisions`: `allowed` and `denied` totals from `/ratelimit`.
- `errors`: error responses by class: `validation`, `not_found`, `method_not_allowed`, `payload_too_large`, `unsupported_media_type`, `unauthorized`, `client_limit_reached`, `fail_closed` and `internal`. `unauthorized` counts requests to `/configure` or `/metrics` without a valid `X-API-Key`.
- `configUpdates`: successful `/configure` calls.
- `evictions`: counter states removed by the idle sweep (idle for more than 2×W, with no carried-over usage left).
- `latency`: `count`, `p50Ms`, `p95Ms`, `p99Ms` and `maxMs` for handler time (from request receipt to the response being handed to the socket). Percentiles are histogram bucket upper bounds, capped at the largest value seen.
- `latencyBuckets`: a list of `{leMs, count}` from 0.05 ms to 1000 ms. `leMs` is `null` for the overflow bucket.
- `activeKeys`: clients that currently hold counter state.
- `process`: `uptimeSeconds`, `rssBytes` and `heapUsedBytes`.

## 10. Deviations from the exercise

1. `/configure` takes a `client_id`. The exercise body has no client ID. The response includes it too (HLD section 1.3).
2. `/configure` creates unknown clients (upsert). `/ratelimit` returns `404` for an unknown client instead of applying a default limit.
3. Error responses are JSON objects with an `error` field. Validation errors add `field`, and range errors add `min` and `max`.
4. Input bounds (section 2) and the seed file (section 3) are additions.
5. `/metrics` is an extra endpoint that the exercise does not define.
6. Counting is approximate (section 5).
7. Internal failures return `503`. The exercise does not define failure responses.
8. The number of clients is capped (`MAX_CLIENTS`, default 100000), which the HLD left uncapped as an accepted risk (HLD section 5.3 names the cap as the mitigation).
9. `/configure` and `/metrics` require an admin API key (`X-API-Key`, section 1.1). The exercise defines no authentication (HLD section 6.5).

## 11. Known limitations and accepted risks

- **Admin key compromise.** Anyone holding an admin key can change any client's limits, create clients and read metrics. All keys have the same permissions. The service stores only digests, so it cannot reveal a key. A leaked key stays valid until its digest is removed and the service restarts.
- **Revocation needs a restart.** `ADMIN_API_KEYS` is read at startup only. Rotation and revocation are described in the [README](../README.md#authentication).
- **No throttling of failed attempts or of `/configure`.** Floods of wrong keys are cheap to send. They are counted under `errors.unauthorized` but not logged one by one. The connection cap and timeouts (section 7) still apply.
- **`/ratelimit` is open.** Anyone who knows a `client_id` can use that client's quota. Keep the service on a trusted network or behind a proxy.
- **No TLS.** Keys are sent in plain HTTP. Run the service on a trusted network or behind a TLS-terminating proxy (HLD section 6.5).
- **Client cap.** `MAX_CLIENTS` (default 100000) bounds configured clients and so memory (section 4). Admin key holders can fill the cap. That blocks creation of new clients until restart, but still allows updates to existing ones. Each successful update writes one log line, so log volume depends on how often admin keys are used.
- **Single process.** State is not shared. Several replicas behind a load balancer would each keep separate limits and counters.
- **In memory only.** A restart resets every client to its seed-file limit and clears all counters.
- **Approximate counting** (section 5).
- **Fail-closed by design.** While the limiter cannot decide, every request is denied.
