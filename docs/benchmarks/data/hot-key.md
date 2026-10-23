# Load test report: hot

- Started: 2026-10-23T01:14:19.934Z
- Target: http://127.0.0.1:3000
- Duration: 30s (warm-up 3s), connections: 50, rate: 1500 req/s, clients: 1, configure every: 100
- Result: **PASS**

## Checks

| Check | Result | Detail |
|---|---|---|
| no errors or timeouts | pass | errors=0 timeouts=0 |
| no non-2xx responses | pass | non2xx=0 |
| client p99 latency < 10 ms | pass | 3.00 ms |
| server /ratelimit p99 latency <= 10 ms | pass | <= 0.10 ms (histogram bucket bound) |
| achieved at least 90% of the target rate | pass | 1502 of 1500 req/s |

## Client-side (load generator)

| Metric | Value |
|---|---|
| Requests | 45051 |
| Requests/s (avg / min / max) | 1502 / 1449 / 1576 |
| Latency avg | 0.41 ms |
| Latency p50 | 0.00 ms |
| Latency p97.5 | 2.00 ms |
| Latency p99 | 3.00 ms |
| Latency p99.9 | 10.00 ms |
| Latency max | 11.00 ms |
| Errors / timeouts / non-2xx | 0 / 0 / 0 |

## Server-side (from /metrics, measured run only)

| Metric | Value |
|---|---|
| Requests handled | 45133 |
| Decisions allowed / denied | 8836 / 35777 |
| Error responses | 0 |
| /ratelimit handler latency p50 / p95 / p99 (bucket upper bounds) | 0.05 / 0.05 / 0.10 ms |
| Active keys at end | 1 |
| Counter evictions | 0 |

## Server memory (sampled from /metrics once per second)

| Metric | Value |
|---|---|
| Samples | 31 |
| RSS start / peak / end | 150.68 / 150.68 / 150.68 MB |
| RSS growth over run | 0 MB |
| Heap used peak / end | 16.29 / 14.71 MB |
