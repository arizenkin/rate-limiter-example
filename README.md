# Rate Limiter

An in-memory HTTP rate limiter. Callers ask whether one request for a `client_id` may proceed and get an allow or deny decision. Operators set each client's limit as N requests per W seconds.

The service implements the [coding exercise](./docs/requirements/Rate-Limiter-Coding-Exercise.md). Where it differs from that document, the [functional specification](./docs/functional-spec.md) lists the changes.

- Sliding window counter. All state is in memory, in a single Node.js process.
- No external services. Limits and counters are lost on restart.
- Fail-closed: an internal failure returns `503`. Callers must treat any non-`200` response as a denial.
- Admin API key: `POST /api/v1/configure` and `GET /metrics` require the `X-API-Key` header. `POST /api/v1/ratelimit` is open. There is no TLS, so run the service on a trusted network or behind a TLS-terminating proxy.

## Prerequisites

- Node.js 24.22 or later (below 25). Check with `node --version`.
- Corepack, which ships with Node. Run `corepack enable` once. It uses the pnpm version pinned in `package.json` (`pnpm@12.14.0`).
- Docker, optional, for the container workflow.

## Install and build

```bash
corepack enable
pnpm install
pnpm build
```

`pnpm build` compiles the TypeScript sources into `dist/`.

## Scripts

- `pnpm dev`: run from source with `tsx watch`, restarting on change. Needs `ADMIN_API_KEYS` (see [Run](#run)).
- `pnpm build`: clean `dist/` and compile with `tsc`.
- `pnpm start`: run the compiled service. Needs `pnpm build` first and `ADMIN_API_KEYS`.
- `pnpm typecheck`: type-check with `tsconfig.json`, without emitting files.
- `pnpm lint`: ESLint, then `prettier --check`.
- `pnpm format`: rewrite files with Prettier.
- `pnpm test`: Jest with coverage. Fails below 100% for lines, branches, functions or statements.
- `pnpm gen-key`: generate an admin API key and the `ADMIN_API_KEYS` value for it. See [Authentication](#authentication).
- `pnpm bench`, `pnpm bench:capacity`, `pnpm bench:hot`: load tests. See [docs/load-testing.md](./docs/load-testing.md).

`pnpm lint`, `pnpm test` and `pnpm build` must pass before a change is reviewed.

## Run

The service refuses to start without `ADMIN_API_KEYS`, the SHA-256 digest of an admin key. Generate one first (see [Authentication](#authentication)) and replace `<digest>` in the commands below with the `ADMIN_API_KEYS` value that `pnpm gen-key` prints:

```bash
pnpm build
ADMIN_API_KEYS=<digest> pnpm start
```

For development with reload on change:

```bash
ADMIN_API_KEYS=<digest> pnpm dev
```

The service listens on `http://0.0.0.0:3000` by default. At startup it reads the seed file `config/clients.json`. If the environment or the seed file is invalid, the process prints `Startup failed: ...` to stderr, exits with code 1 and does not open the port. A missing or malformed `ADMIN_API_KEYS` is one such failure. See the [functional specification](./docs/functional-spec.md#3-seed-file).

Environment variables (only `ADMIN_API_KEYS` is required; values are plain digits where a number is expected):

- `ADMIN_API_KEYS`: **required**. One to ten comma-separated SHA-256 hex digests (64 hex characters each) of admin API keys. Duplicates are refused, and so is the digest of the empty string. Error messages name the entry position and never echo a value. See [Authentication](#authentication).
- `PORT`: default `3000`. Integer from 0 to 65535. `0` picks a free port.
- `HOST`: default `0.0.0.0`. Non-empty host name or IP address.
- `SEED_FILE`: default `config/clients.json`. Path, relative to the working directory.
- `LOG_LEVEL`: default `info`. One of `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`.
- `SWEEP_INTERVAL_MS`: default `30000`. Integer from 10 to 3600000. How often the idle counter sweep runs. See [section 5.2](./docs/functional-spec.md#52-idle-counter-sweep).
- `MAX_CLIENTS`: default `100000`. Integer from 1 to 10000000. Maximum number of configured clients, seed file included. A new client beyond it gets `409` from `/configure`.
- `SHUTDOWN_GRACE_MS`: default `5000`. Integer from 0 to 60000. On `SIGINT` or `SIGTERM` the service stops accepting connections and lets in-flight requests finish for up to this many milliseconds, then closes the rest. Keep it below the stop timeout of the process manager (Docker's default is 10 s). See [section 7.1](./docs/functional-spec.md#71-shutdown).

Example:

```bash
PORT=8080 ADMIN_API_KEYS=<digest> pnpm start
```

### Example calls

The seed file defines `example-client-a` (100 requests per 60 seconds). The examples assume the default port.

Check a request. This endpoint needs no key. If the request is allowed, one unit of quota is consumed:

```bash
curl -s -X POST http://localhost:3000/api/v1/ratelimit \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"example-client-a","resource":"/orders"}'
```

On a fresh start the response is `{"allowed":true,"remaining":99}`. A denial looks like `{"allowed":false,"remaining":0,"retry_after":4}`, where `retry_after` is in whole seconds.

Create or update a client's limit (an unknown `client_id` is created). This endpoint needs the admin key in `X-API-Key`. The examples use `$ADMIN_API_KEY`, the plaintext key from `pnpm gen-key` set in your shell. It is not the service's `ADMIN_API_KEYS` value:

```bash
curl -s -X POST http://localhost:3000/api/v1/configure \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $ADMIN_API_KEY" \
  -d '{"client_id":"example-client-a","window_seconds":60,"request_per_window":100}'
```

The response is `{"client_id":"example-client-a","window_seconds":60,"request_per_window":100}`.

Without a valid key, the response is HTTP 401 with `{"error":"missing or invalid API key"}`:

```bash
curl -si -X POST http://localhost:3000/api/v1/configure
```

Unknown client. The response is HTTP 404 with `{"error":"client_id 'ghost' is not configured"}`:

```bash
curl -s -X POST http://localhost:3000/api/v1/ratelimit \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"ghost","resource":"/orders"}'
```

Operational metrics (see the [functional specification](./docs/functional-spec.md#9-metrics)). This endpoint needs the admin key:

```bash
curl -s -H "X-API-Key: $ADMIN_API_KEY" http://localhost:3000/metrics
```

The full request and response schemas are in the [OpenAPI document](./docs/api/openapi.yaml).

## Authentication

`POST /api/v1/configure` and `GET /metrics` require an admin API key in the `X-API-Key` header. `POST /api/v1/ratelimit` does not need a key.

### Generate a key

```bash
pnpm gen-key
```

The output has two parts:

```text
API key (give to the caller, shown only once):
  <key>

Service configuration (store the hash, not the key):
  ADMIN_API_KEYS=<digest>
```

- Give `<key>` to the caller. It is shown once. The service never stores it.
- Set `ADMIN_API_KEYS=<digest>` in the service's environment. The service stores only the digest.
- Use keys from `pnpm gen-key` only. It makes 32 random bytes, encoded as 43 base64url characters.

### Callers

Keep the key in your shell, and send it in the `X-API-Key` header:

```bash
export ADMIN_API_KEY='<key>'
```

A missing, empty, repeated or wrong key gets the same response every time. `Content-Type` and `Content-Length` are omitted here:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: ApiKey
Connection: close

{"error":"missing or invalid API key"}
```

The check runs before the request body is read, so an unauthenticated caller cannot make the service buffer or parse a body. Failed attempts are counted in `errors.unauthorized` on `/metrics`, and in `requests` as `POST /api/v1/configure 401`. They are not logged one by one and are not throttled.

### Audit log

Each successful `/configure` call is logged as `client configuration changed`, with an `actor` field. `actor` is the first 8 hex characters of the digest of the key that made the change. It identifies the key but is not the key. To find the `actor` for a key you hold:

```bash
printf '%s' "$ADMIN_API_KEY" | sha256sum | cut -c1-8
```

All keys have the same permissions. Any key can change any client and read metrics. Use the `actor` field to tell keys apart in the logs. The log events need `LOG_LEVEL=info` or lower.

### Rotation and revocation

The service reads `ADMIN_API_KEYS` at startup only. Every change to it needs a restart. A restart also returns every client to its seed-file limit and clears all counters, so plan rotations accordingly (see the [functional specification](./docs/functional-spec.md#4-configuration-behaviour)).

To rotate a key without downtime for callers:

1. Run `pnpm gen-key` and keep the new `<key>` and `<new-digest>`.
2. Set `ADMIN_API_KEYS` to both digests, comma-separated, and restart: `ADMIN_API_KEYS=<old-digest>,<new-digest> pnpm start`.
3. Move the callers to the new key.
4. Set `ADMIN_API_KEYS=<new-digest>` and restart.

To revoke a key, remove its digest from `ADMIN_API_KEYS` and restart. The key keeps working until that restart.

### Limits of this design

- A leaked key stays valid until its digest is removed and the service restarts.
- Failed attempts and `/configure` calls are not throttled.
- Requests reach the service over plain HTTP. Use a trusted network or a TLS-terminating proxy.
- `/ratelimit` is open. Anyone who knows a `client_id` can use that client's quota.

## Docker

Build the image:

```bash
docker build -t rate-limiter .
```

Run it with the admin key digest in the environment:

```bash
docker run --rm -p 127.0.0.1:3000:3000 -e ADMIN_API_KEYS=<digest> rate-limiter
```

To use your own seed file instead of the one in the image, mount it read-only:

```bash
docker run --rm -p 127.0.0.1:3000:3000 \
  -e ADMIN_API_KEYS=<digest> \
  -v "$PWD/config:/app/config:ro" rate-limiter
```

With Compose:

```bash
ADMIN_API_KEYS=<digest> docker compose up --build
docker compose --profile test run --rm test
```

- `compose.yaml` reads `ADMIN_API_KEYS` from your shell, or from a `.env` file next to it. `.env` is gitignored.
- Without `ADMIN_API_KEYS`, the `app` service exits at startup with `Startup failed: ...`. Its restart policy (`unless-stopped`) restarts it, so it keeps exiting and restarting until the variable is set. Run `docker compose logs app` to read the message. To stop the restart loop, run `docker compose stop app`. Then set the variable and run `docker compose up --build` again.
- `docker stop` and `docker compose stop` send `SIGTERM`. `compose.yaml` sets `SHUTDOWN_GRACE_MS` to 5000, so the service drains and exits before Docker's default 10-second stop timeout sends `SIGKILL`. `docker run` uses the same default of 5000 ms unless you pass `-e SHUTDOWN_GRACE_MS=<ms>`.
- The `test` profile does not need the key. It runs `pnpm lint && pnpm test` in the build stage and does not start the `app` service. It does not run `pnpm bench`.
- `compose.yaml` publishes the API on `127.0.0.1:3000` only. There is no TLS, so do not publish it on a public interface.
- The app container runs as the non-root `node` user, with a read-only root filesystem, all capabilities dropped and `no-new-privileges` set.
- The image's health check opens a TCP connection to `127.0.0.1` on `PORT`. It sends no HTTP request, so it never reaches the admin endpoints. It works when `HOST` is `0.0.0.0` or `127.0.0.1`.

## Quality checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

- Tests are under `test/`. Time is injected through the `Clock` port with a fake clock. Jest fake timers are not used.
- The coverage gate is 100% for `src/**` (except `src/main.ts`) and `bench/lib/**`.

## Load testing

```bash
pnpm build
pnpm bench
pnpm bench:capacity
pnpm bench:hot
```

Unless `--url` is given, the harness starts `dist/main.js` itself with its own admin key, so no key setup is needed. Run `pnpm build` first and run from the repository root. Each run prints a Markdown summary and exits with 0 when every check passes, 1 when a check fails, and 2 for invalid flags. Reports are written to `bench/reports/`, which is gitignored.

To run against a server you started, pass `--url` and give the admin key in `BENCH_API_KEY`. The target's `ADMIN_API_KEYS` must contain that key's digest:

```bash
BENCH_API_KEY=<admin key> pnpm bench --url http://127.0.0.1:3000
```

Flags go after the script name, for example `pnpm bench --duration 3`. To pick the mode yourself, call the CLI directly, for example:

```bash
pnpm exec tsx bench/run.ts --mode capacity --duration 20
```

The modes, flags, pass/fail checks and how to read reports are in [docs/load-testing.md](./docs/load-testing.md).

## Documentation

- [API reference (OpenAPI 3.1)](./docs/api/openapi.yaml): request and response schemas, status codes and the `X-API-Key` security scheme.
- [Functional specification](./docs/functional-spec.md): behaviour, authentication, seed file, algorithm, errors, deviations from the exercise and accepted risks.
- [Load testing](./docs/load-testing.md): harness modes, flags, checks and reports.
- [High-level design](./docs/architecture/high-level-design.md) and [tech stack](./docs/architecture/tech-stack-plan.md).
- [Coding exercise](./docs/requirements/Rate-Limiter-Coding-Exercise.md).
