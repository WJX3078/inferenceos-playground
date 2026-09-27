# Resume bullets (audit-ready)

Every bullet below points at implementation + test + documentation inside this repository. Percentages or speed-ups are only stated where a reproducible in-repo experiment backs them, and always labeled as simulator results. Nothing here claims real GPU benchmarks or vLLM behavior.

## A — Conservative (100% verifiable)

- Built a deterministic, fixed-step LLM serving-systems simulator in TypeScript with a seeded-RNG core, an explicit request state machine, and continuously-asserted system invariants (KV ownership, token budget, transfer-before-decode); 120+ unit/invariant/property/stress tests plus 24 Playwright E2E flows run in CI. → *implementation: `src/simulation/`; tests: `src/simulation/*.test.ts`; CI: `.github/workflows/ci.yml`*
- Implemented paged KV cache management with conservative admission reservations, content-hash prefix caching (chained block hashes; contiguous-prefix reuse with no false sharing), LRU eviction and an optional GPU/CPU/Remote tier hierarchy with block-granular restore planning. → *`src/simulation/cache.ts`; `src/simulation/kv.test.ts`; `docs/kv-cache.md`*
- Built a headless experiment runner (Node, no browser) with versioned scenario JSON, runtime schema validation, parameter sweeps, result fingerprints (config/workload/result hashes) and byte-identical replay tests. → *`scripts/experiment.ts`; `src/simulation/experiment.ts`; `src/simulation/trace.test.ts`*

## B — AI Infra recruiting

- Designed InferenceOS Lab, a deterministic browser-based simulator of modern LLM serving: pluggable schedulers (FCFS / shortest-remaining-work / priority / SLO-aware) over a vLLM-style token-budget iteration model, chunked prefill and decode-priority semantics that reproduce prefill/decode interference, and p50/p95/p99 + SLO + goodput accounting that demonstrates the throughput-vs-quality gap under overload. → *`src/simulation/scheduler/`; `docs/scheduler.md`; `docs/slo-goodput.md`*
- Modeled prefill/decode disaggregation end-to-end: least-loaded routing, conservative dual-pool reservations held across in-flight KV transfer, a bandwidth-sharing transfer pipeline with fair-share/FIFO/priority scheduling, and decode-side backpressure that pauses prefill admission — with the invariant that decode never starts before its KV arrives. → *`src/simulation/runtime/`; `src/simulation/disagg.test.ts`; `docs/disaggregated-serving.md`*
- Implemented cost-aware recompute preemption (cheapest-victim selection, cooldown, minimum residency) after a stress scenario exposed a victim/candidate livelock; the fix and its regression test are documented in the repo. → *`src/simulation/runtime/preemption.ts`; `src/simulation/hardening.test.ts`; `docs/testing-strategy.md`*
- Added real-workload trace replay (JSONL/JSON with schema validation and an OpenAI-compatible log adapter) and multi-seed paired experiment statistics — with observed latencies displayed strictly as reference, never as calibration claims. → *`src/simulation/trace.ts`; `src/simulation/trace-adapters/`; `docs/experiments.md`*

## C — Systems-design emphasis

- Separated scheduling *policy* from *feasibility*: policies only order work; an admission controller owns reservations, watermark, batch slots and backpressure, and the engine owns the clock, invariants and orchestration — the same policy/core split that keeps vLLM's scheduler explainable. → *`src/simulation/scheduler/`, `src/simulation/runtime/admission.ts`; `docs/architecture.md`*
- Treated correctness as the product: an explicit request state machine (illegal transitions throw), pure resource-accounting functions shared by runtime and invariant checker, property tests (monotonic output counters, transfer byte conservation, no queue black holes), and a documented mutation-testing spot check mapping bug classes to the tests that catch them. → *`src/simulation/runtime/lifecycle.ts`, `src/simulation/runtime/accounting.ts`, `src/simulation/property.test.ts`; `docs/testing-strategy.md`*
- Kept claims defensible: every cost-model parameter is labeled illustrative, the README and docs pass an automated claim-drift check, and the interview guide includes a per-mechanism audit of what is simulated, conceptual, measured, and not modeled. → *`scripts/docs-check.ts`; `docs/interview-guide.md`; `docs/limitations.md`*

## Wording rules applied

- "In simulated workloads" / "in the simulator" is stated wherever an effect size could be inferred.
- No "improved XX%" without a reproducible experiment in-repo (and even then, simulator-labeled).
- No mention of A100/H100/H200/B200 results, real CUDA/NCCL, or production-prediction claims — anywhere.
