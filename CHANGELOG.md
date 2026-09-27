# Changelog

## 1.0.0 — InferenceOS Lab Final Hardening (2026-09)

- Architecture: engine split into runtime/ modules (admission, executor,
  preemption, lifecycle state machine, pure resource accounting) with an
  explicit request transition table (illegal transitions throw).
- Correctness: fixed a preemption livelock (victim/candidate swap per tick);
  preemption now retries the candidate and excludes the fresh victim.
- New mechanisms: block-granular multi-tier KV restores (mixed GPU/CPU/Remote
  reuse plans), cost-aware preemption (cheapest victim, cooldown, minimum
  residency, prefill-only mode), starvation aging with
  starvationThresholdMs, KV transfer scheduling policies
  (fair-share/fifo/priority), P/D backpressure (maxPendingDecodeRequests).
- Real workload traces: JSONL/JSON import with validation and error
  reporting, OpenAI-compatible adapter, documented mini-vllm adapter
  interface (no invented schema), Observed-vs-Simulated side-by-side
  (reference only, never a calibration claim).
- Experiments: runtime schema validation with precise errors, result
  fingerprints (config/workload/result hashes, engine + schema version),
  multi-seed runs with paired-comparison statistics.
- Testing: property-based tests, engine microbenchmark (JS simulator speed
  only), preemption livelock regression, 29 scenarios.
- Docs: design-decisions.md, testing-strategy.md, demo.md,
  resume-bullets.md, interview risk audit, refreshed screenshots.

## 0.2.0 — InferenceOS Lab (2026-09)

- Deterministic serving-simulation platform upgrade of the MVP: pluggable
  schedulers (FCFS/SJF/priority/SLO-aware), token budget, chunked prefill,
  decode priority, KV watermark, recompute preemption, content-addressed
  prefix caching, multi-tier KV, configurable speculative decoding,
  prefill/decode disaggregation with a KV transfer manager, percentiles +
  SLO + goodput, workload generator, 22 scenarios, headless experiment CLI
  with sweeps and byte-identical replay, Compare view, docs suite.

## 0.1.0 — InferenceOS Playground MVP (2026-09)

- Interactive browser simulation: continuous/static batching, paged KV with
  immutable shared prefix pages, conceptual tensor parallelism, speculative
  decoding, seeded fixed-step engine, invariant tests and Playwright E2E.
