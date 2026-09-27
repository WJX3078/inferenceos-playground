# Design Decisions

The choices that shape InferenceOS Lab, each with its reason, trade-off, and the alternative we rejected. This is the "why is it built this way" document — and the first line of defense in an interview.

## 1. Deterministic fixed-step simulation (20 ms = one scheduler iteration)

- **Decision:** time advances in fixed 20 ms ticks; one tick = one scheduler iteration = one batched forward pass. A seeded 32-bit LCG is the only randomness source.
- **Reason:** determinism turns demos into experiments — same seed + config + workload reproduces byte-identical results, so "change one knob" comparisons are causal, failures reproduce on demand, and replay tests can assert equality.
- **Trade-off:** step time cannot vary with batch composition, so absolute milliseconds are illustrative, not predictive.
- **Alternative rejected:** variable step durations driven by cost curves — more "realistic", but it smuggles hardware claims into the model and breaks the clean "tokens scheduled per iteration" budget semantics.

## 2. Browser-only, no backend

- **Reason:** zero setup (clone → `npm run dev`), inspectable state, screenshot-friendly for interviews and teaching; the workload sizes fit comfortably in a main-thread loop.
- **Trade-off:** bounded scale (queue caps, observation retention) and no persistence beyond exported JSON files.
- **Alternative rejected:** a server/DB backend — no system need; files and the headless CLI cover experiments.

## 3. Policies order; the engine owns feasibility

- **Decision:** scheduler policies (FCFS/SJF/priority/SLO-aware) only produce a total order; admission checks reservations, watermark, batch slots and budget.
- **Reason:** mirrors the vLLM policy/core split, keeps each policy unit-testable against the same harness, and makes every wait *explainable* (the wait reason names the binding constraint).
- **Trade-off:** a policy cannot express "bypass the reservation check" — none should.
- **Alternative rejected:** monolithic schedulers that mix policy with resource checks (untestable, unexplainable).

## 4. Nearest-rank percentiles

- **Decision:** p = value at index `ceil(p/100 × n) − 1` over sorted observations.
- **Reason:** simple, deterministic, monotone (p50 ≤ p90 ≤ p95 ≤ p99), never interpolates a value that no request experienced.
- **Trade-off:** slightly conservative versus interpolation; with n < 20 percentiles are indicative only (documented).
- **Alternative rejected:** linear interpolation — prettier numbers, but they describe requests that never ran.

## 5. Conservative KV reservation (reserve prompt + output at admission)

- **Reason:** a running request can never OOM the pool mid-decode; admission queueing absorbs the uncertainty instead of preemption.
- **Trade-off:** idle headroom lowers peak utilization — exactly the knob the watermark tunes.
- **Alternative rejected:** optimistic allocation + eviction as the primary mechanism (that is vLLM's choice with different failure modes; we model preemption as an explicit, costly event instead).

## 6. Content-hash prefix identity (chained block hashes)

- **Reason:** prefix sharing must be a *contiguous content prefix* — name-based keys (family + index) falsely share unrelated prompts. The chain `hash(parent, blockTokens)` makes holes impossible to jump and mutable tails unshareable by construction.
- **Trade-off:** hashing work per lookup; a radix/trie would add incremental insert visuals but no correctness difference.
- **Alternative rejected:** family-name identity (the v0.1 approach) — a cache that can lie.

## 7. Conceptual tensor parallelism

- **Decision:** TP scales decode duration and shards the pool across ranks; there is no communication model.
- **Reason:** the teaching goal is replica/sharding semantics (ranks share a batch, pool per replica), not NCCL behavior.
- **Trade-off:** TP's effect on prefill is absent; step-time-vs-TP curves are out of scope.
- **Alternative rejected:** ring all-reduce timing models — numbers would look authoritative and be wrong.

## 8. Disaggregation as pipeline + explicit transfer cost

- **Decision:** P and D pools with a queue/concurrency/bandwidth-sharing transfer manager; decode never starts before its KV lands; backpressure pauses prefill admission when the decode pipeline is full.
- **Reason:** the pedagogical point is *where the queue moves* when the P/D ratio is wrong, and that the network itself becomes a scheduler.
- **Trade-off:** the interconnect is an abstract pipe (equal sharing or serial FIFO), not a fabric with topology/QoS.
- **Alternative rejected:** "disaggregation is faster" — the simulator explicitly refuses to promise that.

## 9. Cost-aware preemption (cheapest victim + cooldown + residency)

- **Decision:** preemption is optional and priced: `cost = contextTarget − cachedTokens`; victims are chosen by cost among strictly-outranked requests, gated by a cooldown and minimum residency; disaggregated decode-pool KV is never preempted.
- **Reason:** unguarded preemption livelocks (we found a real victim/candidate swap during hardening); pricing makes the fairness/progress trade-off visible instead of emergent.
- **Trade-off:** the cost function is a heuristic — it ignores prefix-cache re-hits beyond the victim's own cached prefix and tier-restorable blocks.
- **Alternative rejected:** free-for-all preemption of any lower-priority request (storms), or never preempting decode-phase requests (fairness holes).

## 10. Trace import ≠ calibration

- **Decision:** real traces replay workload *shape* (arrival, lengths, classes). Optional `observed_*` fields are displayed side-by-side as reference only; the word "accuracy" appears nowhere.
- **Reason:** the simulator has illustrative cost models; comparing absolute milliseconds to hardware would manufacture a claim we cannot defend.
- **Trade-off:** users cannot "fit" the model to their cluster in v1 (a calibration layer was considered and deliberately deferred).
- **Alternative rejected:** auto-fitting cost parameters to observed latencies — that would claim predictive power the fixed-step model does not have.

## 11. Multi-seed for sensitivity, single seed for reproducibility

- **Decision:** one seed → byte-identical replay; `seeds: [..]` → paired aggregate statistics (mean/median/min/max/stddev over the same seed list).
- **Reason:** reproducibility and stochastic sensitivity answer different questions; pairing seeds makes A/B deltas meaningful.
- **Trade-off:** aggregate numbers are no longer byte-reproducible across seed-list changes (documented per result via fingerprints).

## 12. Scenario JSON validation errors loudly

- **Decision:** unknown config keys, out-of-range values, bad enums and malformed traces fail with named, line-numbered errors.
- **Reason:** silent normalization hides typos (`maxNumBatchedToken`) and produces experiments that never ran what the author intended.
- **Trade-off:** some structural normalization (e.g. deriving decode GPUs) remains in `normalizeConfig` for interactive use, where immediacy matters and the UI shows the result.
