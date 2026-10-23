# Load test report: latency

- Started: 2026-10-23T00:52:51.771Z
- Target: http://127.0.0.1:3000
- Duration: 300s (warm-up 3s), connections: 50, rate: 1500 req/s, clients: 100, configure every: 2000
- Result: **PASS**

## Checks

| Check | Result | Detail |
|---|---|---|
| no errors or timeouts | pass | errors=0 timeouts=0 |
| no non-2xx responses | pass | non2xx=0 |
| client p99 latency < 10 ms | pass | 2.00 ms |
| server /ratelimit p99 latency <= 10 ms | pass | <= 0.10 ms (histogram bucket bound) |
| achieved at least 90% of the target rate | pass | 1500 of 1500 req/s |

## Client-side (load generator)

| Metric | Value |
|---|---|
| Requests | 450005 |
| Requests/s (avg / min / max) | 1500 / 1427 / 1585 |
| Latency avg | 0.29 ms |
| Latency p50 | 0.00 ms |
| Latency p97.5 | 1.00 ms |
| Latency p99 | 2.00 ms |
| Latency p99.9 | 3.00 ms |
| Latency max | 8.00 ms |
| Errors / timeouts / non-2xx | 0 / 0 / 0 |

## Server-side (from /metrics, measured run only)

| Metric | Value |
|---|---|
| Requests handled | 450357 |
| Decisions allowed / denied | 155440 / 294378 |
| Error responses | 0 |
| /ratelimit handler latency p50 / p95 / p99 (bucket upper bounds) | 0.05 / 0.05 / 0.10 ms |
| Active keys at end | 100 |
| Counter evictions | 0 |

## Server memory (sampled from /metrics once per second)

| Metric | Value |
|---|---|
| Samples | 301 |
| RSS start / peak / end | 87.51 / 105.01 / 105.01 MB |
| RSS growth over run | 17.5 MB |
| Heap used peak / end | 20.14 / 16.36 MB |
