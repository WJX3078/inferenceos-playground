# Metrics

All metrics derive from the deterministic simulation clock. Nothing samples wall-clock time; pausing the browser tab pauses the metrics, not their meaning.

## Request-level observations

Every terminal request produces a `RequestObservation` (kept for up to 4000 requests, exported with *Export run*):

| Field | Definition |
| --- | --- |
| `queueLatency` | arrival → first admission into a pool |
| `prefillQueueLatency` | arrival → prefill admission (same as queueLatency today; kept explicit for future router delays) |
| `prefillLatency` | prefill admission → prefill/recompute complete |
| `kvTransferQueueLatency` | prefill done → transfer start (staging wait + transfer queue; disagg only) |
| `kvTransferLatency` | transfer start → transfer complete (disagg only) |
| `decodeQueueLatency` | transfer complete → decode admission (disagg only) |
| `ttft` | arrival → first emitted output token |
| `tpot` | (last token − first token) / (generated − 1); `null` for single-token outputs |
| `e2e` | arrival → finish (partial for cancelled) |
| `preemptions`, `recomputedTokens` | preemption bill for this request |
| `meetsTTFTSLO` / `meetsTPOTSLO` / `meetsSLO` | SLO verdicts; `null` unless completed |

## Aggregates

- **Means** (lifetime, unchanged semantics from v0.1): TTFT over all observed first tokens; TPOT token-weighted across post-first-token intervals (speculative tokens emitted together have zero internal spacing).
- **Percentiles** — p50/p90/p95/p99 for TTFT and TPOT (over all requests with a first token), and p50/p95/p99 for E2E (completed only). **Method: nearest-rank** — sort ascending, take the value at index `ceil(p/100 × n) − 1`. Deterministic, monotonic (p50 ≤ p90 ≤ p95 ≤ p99, tested), and stable on small samples. For n < 20 treat percentiles as indicative.
- **Throughput**: output tokens and completions per second over a trailing 1 s window (startup uses elapsed time).
- **Goodput**: completions meeting *both* SLO targets per second, same window. SLO attainment: share of completed requests meeting both targets (lifetime).
- **Utilization**: KV blocks occupied / total across pools; GPU utilization is a synthetic occupancy estimate from phase and batch fill averaged over workers (prefill/decode utilization reported separately in disaggregated mode) — **not hardware telemetry**.
- **Scheduling**: `schedulerIterations`, per-pool last-iteration budget usage and a `tokenBudgetUtilization` EMA.
- **Memory**: evictions, preemptions, recomputed tokens, prefix hit rate (eligible lookups reusing ≥ 1 block), tier hits/restores/bytes.

## Trace events

The scheduler log (and *Export run*) carries bounded recent events with `{id, at, requestId, type, message}`: `arrival, admit, wait, chunk, prefill, prefix, decode-adjacent completion, preempt, resume, evict, watermark, budget, restore-queue, restore-complete, transfer-queue, transfer-start, transfer-complete, verify, complete, cancel, reject, config`. Filterable by type in the Trace tab.

## Latency definitions matter

- TTFT **includes queue time** — a cancelled request that already emitted a token still contributes its TTFT.
- TPOT excludes the first token; a request with one output token has no TPOT and cannot violate the TPOT SLO.
- E2E percentiles count completions only; cancelled requests appear in TTFT percentiles but not E2E.
