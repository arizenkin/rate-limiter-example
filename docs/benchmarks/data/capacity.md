# Load test report: capacity

- Started: 2026-10-23T01:02:00.502Z
- Target: http://127.0.0.1:3000
- Duration: 120s (warm-up 3s), connections: 100, rate: unthrottled, clients: 1000, configure every: 2000
- Result: **PASS**

## Checks

| Check | Result | Detail |
|---|---|---|
| no errors or timeouts | pass | errors=0 timeouts=0 |
| no non-2xx responses | pass | non2xx=0 |
| throughput >= 1000 req/s | pass | 61625 req/s |

## Client-side (load generator)

| Metric | Value |
|---|---|
| Requests | 7394922 |
| Requests/s (avg / min / max) | 61625 / 50774 / 64550 |
| Latency avg | 1.16 ms |
| Latency p50 | 1.00 ms |
| Latency p97.5 | 3.00 ms |
| Latency p99 | 3.00 ms |
| Latency p99.9 | 6.00 ms |
| Latency max | 30.00 ms |
| Errors / timeouts / non-2xx | 0 / 0 / 0 |

## Server-side (from /metrics, measured run only)

| Metric | Value |
|---|---|
| Requests handled | 7395144 |
| Decisions allowed / denied | 7391398 / 0 |
| Error responses | 0 |
| /ratelimit handler latency p50 / p95 / p99 (bucket upper bounds) | 0.05 / 0.05 / 0.05 ms |
| Active keys at end | 1000 |
| Counter evictions | 0 |

## Server memory (sampled from /metrics once per second)

| Metric | Value |
|---|---|
| Samples | 121 |
| RSS start / peak / end | 104.62 / 150.55 / 150.55 MB |
| RSS growth over run | 45.94 MB |
| Heap used peak / end | 40.14 / 39.08 MB |
