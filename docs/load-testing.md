# Load testing

The harness in `bench/` drives the service with autocannon and reports client-side and server-side numbers. It sends `POST /api/v1/ratelimit` requests, plus `POST /api/v1/configure` calls at a fixed interval. Each connection has one request in flight; pipelining is off.

## Quick start

```bash
pnpm build
pnpm bench
pnpm bench:capacity
pnpm bench:hot
```

- Run `pnpm build` first. Unless `--url` is given, the harness starts `dist/main.js` itself.
- Run from the repository root. The spawned server reads `config/clients.json` relative to the working directory.
- Each command prints a Markdown summary and exits with 0 when every check passes, 1 when a check fails or the run errors, and 2 for invalid flags.

Flags go after the script name, for example `pnpm bench:capacity --duration 20`. To choose the mode yourself, call the CLI directly:

```bash
pnpm exec tsx bench/run.ts --mode capacity --duration 20
BENCH_API_KEY=<admin key> pnpm exec tsx bench/run.ts --url http://127.0.0.1:3000 --mode latency
```

## Modes

- **latency** (`pnpm bench`): fixed overall rate of 1500 requests per second, 50 connections, 100 clients, 30 s measured. Each client has a limit of 10 requests per 1 s window, so part of the traffic is denied. Pass/fail on latency and rate.
- **capacity** (`pnpm bench:capacity`): unthrottled, 100 connections, 1000 clients, 15 s measured. Each client has a limit of 500 requests per 1 s window. Reports requests per second and passes when the average is at least 1000.
- **hot** (`pnpm bench:hot`): fixed rate of 1500 requests per second over 50 connections, all against one client (`bench-hot`, limit 500 per 1 s window), 30 s measured. Same checks as latency. Exercises contention on a single counter.

In every mode each request picks a random client and endpoint. About one request in 100 (`--configure-every`) is `POST /api/v1/configure`. It alternates the client's limit between N - 1 and N and keeps the window at 1 s, so the counters are kept. The other requests are `POST /api/v1/ratelimit` with `resource` set to `bench`.

## Flags

- `--mode <mode>`: `latency` (default), `capacity` or `hot`.
- `--url <url>`: target a running server, for example `http://127.0.0.1:3000`. Without it the harness spawns `dist/main.js`.
- `--duration <sec>`: measured run length. Default 30 for latency and hot, 15 for capacity.
- `--warmup <sec>`: unmeasured warm-up. Default 3. `0` disables it.
- `--connections <n>`: concurrent connections. Default 50, or 100 for capacity.
- `--rate <req/s>`: overall request rate. Default 1500 for latency and hot. Capacity is unthrottled unless this flag is given, in which case it applies there too.
- `--clients <n>`: number of distinct client IDs. Default 100 for latency and 1000 for capacity. Ignored in hot mode, which always uses `bench-hot`.
- `--configure-every <n>`: every nth request is a configure call. Default 100. `0` disables it.
- `--out <dir>`: report directory. Default `bench/reports`.
- `--help`: print the usage and exit.
- `BENCH_API_KEY` (environment variable, not a flag): the admin API key for `/configure` and `/metrics`. Required with `--url`. It is not a flag, so it does not appear in `ps` output, and it is never written to reports.

Values must be integers within range (`--duration` and `--connections` at least 1, `--warmup` and `--configure-every` at least 0). Unknown flags, bad values and unknown modes print the usage and exit with code 2.

## Target: spawned or `--url`

Without `--url` the harness starts `node dist/main.js` on a free port on `127.0.0.1`, with `HOST=127.0.0.1` and `LOG_LEVEL=warn`. It mints a new admin key for the run and gives the server only that key's SHA-256 digest in `ADMIN_API_KEYS`. So you do not need to set `ADMIN_API_KEYS` for the harness, and the value in your shell is replaced for the spawned server. Other environment variables, such as `SEED_FILE` and `SWEEP_INTERVAL_MS`, are inherited from your shell, except `BENCH_API_KEY`, which is removed from the server's environment. The server is stopped when the run ends. The load generator and the server share the machine.

`BENCH_API_KEY` is ignored when the harness spawns the server: the minted key is always used.

With `--url` the harness uses a server you started yourself. The target's `ADMIN_API_KEYS` must contain the digest of the key given in `BENCH_API_KEY`:

```bash
ADMIN_API_KEYS=<digest> pnpm start                                  # terminal 1
BENCH_API_KEY=<admin key> pnpm exec tsx bench/run.ts --url http://127.0.0.1:3000 --mode latency   # terminal 2
```

The target must expose `GET /metrics` and accept the key. Otherwise the latency and hot checks fail with "server metrics unavailable", and the memory section of the report is empty. A key the target does not accept fails earlier: seeding returns HTTP 401 and the run stops with exit code 1.

## Seeding and warm-up

Before each run the harness creates its clients on the target with `POST /api/v1/configure`. In latency and capacity mode these are `bench-0000` upwards, 100 or 1000 clients. In hot mode it creates only `bench-hot`. Each client has a window of 1 s and the mode's limit.

The admin key is sent on the `/configure` calls (seeding and the interleaved calls during the run) and on the `/metrics` reads. `/ratelimit` requests carry no key.

Configurations are never evicted, so these clients stay in memory on a long-lived target until it restarts. Restart the server to clear them.

The harness then runs the same request mix for `--warmup` seconds (default 3) without measuring. Server metrics are read immediately before and after the measured run, so warm-up traffic is excluded from the server numbers. Memory sampling starts after the warm-up.

## What is measured

- **Client (autocannon):** requests per second (average, minimum, maximum), latency average, p50, p97.5, p99, p99.9 and maximum, errors, timeouts and non-2xx responses.
- **Server (`GET /metrics`, delta over the measured run):** requests handled, allowed and denied decisions, error responses, active keys at the end, and evictions. These cover the whole server. The latency row is different: handler latency p50, p95 and p99 as histogram bounds for `POST /api/v1/ratelimit` only, taken from `latencyByRoute`. Admin and other routes are not included.
- **Memory:** RSS and heap used of the server process, read from `/metrics` once per second during the measured run.

## Pass/fail checks

Latency and hot modes:

- No errors and no timeouts (`errors` and `timeouts` are 0).
- No non-2xx responses. Denials are HTTP 200, so any non-2xx response is a fault.
- Client p99 latency is below 10 ms.
- Server `/ratelimit` p99 handler latency is at most 10 ms, using the histogram bucket bound (check name `server /ratelimit p99 latency`). The check fails with "no /ratelimit requests were recorded by the server" if the server saw no `/ratelimit` requests during the measured run.
- Achieved requests per second is at least 90% of `--rate`.

Capacity mode:

- No errors, timeouts or non-2xx responses.
- Average requests per second is at least 1000.

Memory is reported but not checked. Any failed check makes the run exit with 1.

## Reports

Each run writes two gitignored files to `bench/reports/` (or `--out`):

- `<start>-<mode>.md`: the summary printed to the console. It has the result, a checks table, client-side and server-side tables, and a memory table.
- `<start>-<mode>.json`: the full data, including the options, every memory sample and the check details. The recorded options never include the admin key.

`<start>` is the run's start time in ISO 8601 format, with `:` and `.` replaced by `-`. For example: `2026-01-31T12-00-00-000Z-latency.md`.

## Memory

- The server's RSS and heap used are read from `/metrics` once per second during the measured run.
- The report shows start, peak and end RSS, growth (end minus start), and peak and end heap used.
- Growth is reported but not gated. A passing run can still show growth. Check growth over a longer run (for example `--duration 120`), and watch `activeKeys` and `evictions` alongside it.
- The sampler's requests are real requests and appear in the server request count (see the caveats).

## Caveats

- **Server latency is handler time.** It runs from the request reaching the handler to the response being handed to the socket. It excludes network transfer, kernel buffering and any queueing before the handler. The client-side p99 is the authoritative figure for the 10 ms budget. The server figure covers `/ratelimit` only, so admin calls and the `/metrics` sampler do not affect it.
- autocannon measures latency with 1 ms resolution.
- Server percentiles are histogram bucket upper bounds, capped at the largest value observed. A reported p99 of 2 ms means the 99th percentile fell in the bucket that ends at 2 ms.
- Server request totals include the `/metrics` requests made by the sampler (about one per second of the measured run) and the snapshot read just before the run. They are therefore higher than the autocannon total.
- Requests per second depend on the mix of allowed and denied decisions. That mix depends on the rate, the limits and the client count of each mode. Compare only runs made with the same flags.
- Run on an otherwise idle machine. When the server is spawned, the load generator and the server share CPU and memory. Starting the server separately with `--url` makes the setup explicit, but both still run on the same host unless you use separate machines.

## Results

This document does not record measured results. Record your own runs in the table below, with the machine, Node version and flags used (or `defaults`). The "Server p99" column is the `/ratelimit` handler p99 from the server (histogram bound), not the whole server.

| Date | Mode     | Machine | Flags | Req/s avg | Client p99 (ms) | Server p99 (ms) | RSS growth (MB) | Result |
| ---- | -------- | ------- | ----- | --------- | --------------- | --------------- | --------------- | ------ |
|      | latency  |         |       |           |                 |                 |                 |        |
|      | capacity |         |       |           |                 |                 |                 |        |
|      | hot      |         |       |           |                 |                 |                 |        |
