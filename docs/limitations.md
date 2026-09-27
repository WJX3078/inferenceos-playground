# Limitations

What this simulator is, stated plainly: **a deterministic teaching model of scheduling and memory behavior in LLM serving.** Everything below is a deliberate boundary, not an oversight.

## Not simulated (at all)

- Neural inference: no model, no weights, no tokenizer, no real attention math, no actual token text. "Tokens" are synthetic integers used for identity and accounting.
- CUDA kernels, GPU hardware, hardware telemetry, or any performance prediction. GPU "utilization" is a synthetic occupancy estimate from phase and batch fill.
- NCCL / RDMA / any real network. The KV interconnect is a shared-bandwidth pipe with fixed per-transfer latency; tier restores use illustrative latency/bandwidth numbers.
- Real vLLM. This project is *inspired by* vLLM's execution model (iteration-level scheduling, paged KV, conservative admission, token budgets); it is not vLLM, contains none of its code, and cannot reproduce its exact behavior.

## Timing model caveats

- One scheduler iteration = 20 ms, fixed. Real step time varies with batch composition, model size, and hardware; the fixed step makes the model legible, not accurate.
- Decode step duration `(36 + context/128 + 2 × batch) / sqrt(TP efficiency)` ms is an **illustrative cost model**, not a measurement. Prefill progress is budget-driven (tokens scheduled per iteration), not FLOP-modeled.
- Conceptual tensor parallelism: ranks execute the same batch over conceptual shards; TP affects decode duration, replica count, and per-replica KV capacity — not communication modeling. Higher TP reduces replica count and does not automatically increase aggregate capacity.
- Speculative decoding's step cost is a multiplier (draft-model passes aggregated), not a second model. Acceptance is an iid per-token probability — real acceptance is correlated across a draft chain.
- KV payload bytes (2 × layers × KV heads × head dim × bytes) exclude weights, activations, allocator overhead, workspace, fragmentation, and communication buffers.

## Engineering bounds

- Main-thread engine sized for teaching workloads (bounded bursts, ≤ 256 queued, ≤ 8192-token prompts). It is not a load generator.
- Display history prunes to the newest 160 terminal requests / 150 events / 180 samples; observations keep the newest 4000 requests. Exports include those records plus lifetime counters — not an exhaustive log.
- Multi-tier restore prices are per-tier flat bandwidth/latency with no device-level contention modeling beyond the shared pipe.
- Cost-aware preemption prices a victim as `contextTarget − cachedTokens`; it does not model tier-restorable blocks or cross-prefix sharing in the recompute estimate.
- The aging (starvation protection) promotion is a hard priority bump, not a gradual weight; threshold defaults are teaching values.
- Backpressure gates prefill admission by a pending-request count only; no byte-level admission shaping.
- The preemption cost heuristic, cooldown (default 500 ms) and residency (200 ms) are illustrative teaching constants, not tuned values.
- Percentiles use nearest-rank over retained observations; with < 20 samples treat them as indicative.
- Tested in Chromium (Playwright); other engines are not certified.
- Trace `observed_*` fields are display-only references; the simulator performs no calibration and computes no accuracy metric.

## Claims discipline

Every number this project produces is a **simulator output under illustrative cost models**. Nothing in the README, docs, or UI should be (or is, to the best of our audit) worded as a hardware benchmark, a vLLM reproduction, or a production performance prediction. If you find a sentence that reads otherwise, it is a bug — file it.
