# Interview Guide — InferenceOS Lab

Prepared for AI Infra / LLM Serving interviews. The project is a deterministic, browser-based LLM serving systems simulator; every claim below is backed by code, tests, or a reproducible experiment in the repository.

---

## Part 1 — Pitches

### 30 seconds

> I built InferenceOS Lab, a deterministic, browser-based simulator of modern LLM serving systems. It models what actually determines serving quality: continuous batching, token-budget scheduling, chunked prefill, paged KV cache with content-addressed prefix sharing, recompute preemption, speculative decoding, and prefill/decode disaggregation with simulated KV transfer. Everything runs from a seeded fixed-step engine — same seed, same result — with invariant and stress tests, plus a headless CLI for parameter sweeps. It's a teaching simulator with illustrative cost models, not a benchmark, and it lets you *show* trade-offs like throughput vs goodput instead of asserting them.

### 1 minute

> The motivation: LLM serving quality is decided by scheduler and memory policy, but you can't see those policies from outside a production cluster, and most explanations are hand-wavy. So I built a simulator where every mechanism is inspectable. The engine is fixed-step and fully deterministic — a seeded RNG, no wall-clock time — so experiments are reproducible byte-for-byte, which is asserted by replay tests. The feature set follows vLLM's execution model: per-iteration token budgets, chunked prefill, decode priority, paged KV with conservative reservations, a watermark, content-hash prefix caching, LRU eviction, recompute preemption, configurable speculative decoding, and prefill/decode disaggregation with a bandwidth-shared KV transfer model. Metrics go beyond means — p50/p95/p99 for TTFT/TPOT/E2E, SLO attainment and goodput, per-request observations. 22 scenarios each isolate one trade-off; a Compare view and a Node CLI sweep parameters. Correctness is the product: invariants like "no KV leak", "budget never exceeded", "decode never starts before transfer completes" are checked continuously in randomized stress tests. I'm explicit about scope: it's a conceptual model with illustrative numbers — not vLLM, not a hardware benchmark.

### 3 minutes (architecture)

> Three layers. **Simulation core** — pure TypeScript, zero React: a fixed-step engine (20 ms per scheduler iteration) driving admission, per-replica iterations, a paged KV cache, a KV transfer manager, and metrics. **Policies** — four scheduler policies (FCFS, SJF/shortest-remaining-work, priority, SLO-aware) that only *order* work; the engine owns feasibility. That split mirrors vLLM's policy/core separation and makes policies trivially testable. **React UI** — configuration, visualization, and experiment capture only.
>
> The iteration loop: the workload generator (constant/Poisson/burst/trace, all seeded) feeds an admission queue; the scheduler orders it; admission enforces conservative KV reservations — a request is admitted only if the pool can hold its whole declared footprint — against the usable capacity after a watermark; then each replica runs one iteration: decodes claim the global token budget first (or prefill-first when you disable decode priority — that's the interference experiment), at most one prefill advances a chunk, bounded by the leftover budget; completions publish prefix blocks into a content-addressed table keyed by chained block hashes, so sharing is always a true contiguous content prefix.
>
> For disaggregation, the same engine grows a router, prefill pools, a KV transfer manager (queue, concurrency cap, equal bandwidth sharing, fixed latency), and decode pools — with the invariant that decode never starts before the transfer finishes, and reservations held on *both* pools during flight.
>
> Observability: every terminal request produces an observation — queue/prefill/transfer/decode latencies, TTFT, TPOT, preemptions, recomputed tokens, SLO verdicts — feeding nearest-rank percentiles and goodput. Correctness: a big invariant suite (no duplicate block ownership, no mutable shared pages, budget never exceeded, exact output lengths, deterministic replay) run every N ticks in randomized stress tests across adversarial configs — high load, KV pressure, cancellations, preemption, tier thrash.

### 5–10 minutes (deep dive)

Walk one scenario end-to-end and *show numbers*. Recommended: **long-prefill-interference**. Explain the token budget semantics (decode = 1 slot/sequence/iteration; one prefill chunk per iteration capped by chunk size and leftover budget). Run it with decode priority off: TPOT p99 explodes because the 2048-token prefill eats all 32 budget slots for ~64 iterations. Toggle chunked prefill 64: prefill takes small bites, decodes keep running, TPOT p99 recovers, TTFT p95 rises slightly — the classic trade. Then Compare tab: same seed, two captures, 20 metrics. Then preempt to recompute preemption (priority + recompute): a high-priority arrival evicts a running low; walk the event trace `preempt` → `resume` → recompute bill in `recomputedTokens`. Close with the honest-scope slide: what is and isn't modeled (docs/limitations.md).

---

## Part 2 — Concepts (the 60-second versions)

- **Continuous batching vs static batching**: static batches run a fixed cohort to completion — a long sequence holds slots idle; continuous batching admits into freed slots *every iteration*. In the simulator: `continuousBatching` toggle; cohort gating via `admittedAt` equality.
- **Paged KV cache & block table**: KV memory in fixed-size blocks; a per-request logical→physical table enables incremental allocation and sharing. Fragmentation drops from O(seq) to O(block).
- **Prefix caching**: identical prompt prefixes reuse full immutable KV blocks. Identity must be **content** (chained block hashes), not names — else "same family" falsely shares. Only full blocks; mutable tails never shared; matches are contiguous prefixes.
- **Chunked prefill**: split a long prefill across iterations so decodes keep running. Cost: slightly longer TTFT for the chunked request; benefit: bounded ITL for everyone else.
- **Token budget (`max_num_batched_tokens`)**: per-iteration cap on scheduled tokens across decode + prefill. The resource that makes prefill/decode interference *quantifiable*.
- **Preemption (recompute)**: evict a running request's KV under pressure; on resume, its generated suffix is context and gets recomputed. Cost = recomputed tokens; rule must be strictly-ordered to avoid livelock.
- **KV watermark**: reserve a fraction of the pool from admission so cache survives pressure — fewer sequences, fewer evictions, often better tails.
- **Tensor parallelism (conceptual)**: ranks execute the same batch over model/KV shards; in this simulator TP affects decode duration, replica count, and per-replica KV — communication is not modeled.
- **Speculative decoding**: draft k tokens, verify in one pass, accept the matching prefix, commit a correction. Expected speedup ≈ E[accepted+1]/cost — negative when acceptance is low or verify is expensive.
- **Prefill/decode interference**: prefills and decodes share compute; long prefills stretch decode ITL — visible as TPOT p99 without chunking/decode priority.
- **Disaggregation & KV transfer**: split P and D onto separate pools; ship KV over the interconnect. Removes intra-pool interference, adds transfer queueing — the P/D ratio moves the queue, it doesn't delete it.
- **TTFT / TPOT / ITL / E2E**: arrival→first token; inter-token latency after the first; end-to-end. Report percentiles, not means.
- **p99**: the tail. Batching couples requests — one straggler or one long prefill shapes everyone's tail. SLOs are written against tails.
- **SLO / Goodput / Throughput**: goodput = throughput that meets SLOs. Under overload, throughput can rise while goodput falls.
- **Why this simulator is not a benchmark**: illustrative fixed-step cost models, synthetic tokens, no hardware. Value = *relative, reproducible* trade-off demonstrations.

---

## Part 3 — 40+ interview Q&A

Format: **Q / Short / Deep / Follow-up / Common wrong answer.**

**1. Why is this simulator not a benchmark?**
S: Its cost models are illustrative and fixed-step; it has no hardware, kernels, or model.
D: Numbers are functions of configurable parameters (20 ms steps, a decode-duration formula, shared-bandwidth transfers), designed for legibility and determinism — for *relative* trade-off demonstration under controlled inputs, not absolute prediction. The docs mark every such number illustrative, and no claim in the repo references real hardware.
F: "Then what *is* it good for?" — Reproducible counterfactuals: change one knob, hold everything else, observe.
Wrong: "It simulates an A100 cluster" — it simulates *policies*, with abstract costs.

**2. Why is a synthetic cost model still valuable?**
S: Because the mechanisms and their *ordering* effects are real even when the constants aren't.
D: Queueing effects, head-of-line blocking, reservation dynamics, and coupling through a shared budget depend on the *structure* of the system, not the exact ms values. If chunked prefill helps decodes when prefills eat a shared budget, that help exists at any plausible cost ratio; the simulator isolates it.
F: What would break the conclusions? A model where prefill and decode don't contend for a shared per-step resource.
Wrong: "Synthetic data proves performance improvements" — it demonstrates mechanisms, not performance.

**3. Why does higher throughput not mean better serving?**
S: Throughput counts completions; quality is latency vs SLOs — overload raises one and collapses the other.
D: Push arrival rate past capacity: queues absorb arrivals, completions accumulate (throughput ↑), but TTFT/TPOT tails explode so the share of completions meeting SLOs (goodput) falls. The `slo-overload` scenario shows throughput and goodput diverging on the same run.
F: How would you operate with that? — Admission control / SLO-aware scheduling; accept lower utilization for bounded tails.
Wrong: "Utilization near 100% is the goal."

**4. Why do you need p99 (and not just means)?**
S: Batching couples requests; means hide the tail that SLOs are written against.
D: One long prefill or one oversized cohort shifts *everyone's* iteration time — a small fraction of iterations dominates the tail. TPOT mean can look fine while p99 triples; SLO attainment tracks the tail. In the simulator, decode-priority-off runs show nearly equal TPOT p50 with p99 multi-fold worse.
F: When is mean the right metric? — Capacity planning; never SLOs.
Wrong: "Mean TPOT represents user experience."

**5. Why does a long prefill affect decoding?**
S: They share the per-iteration compute budget; an unchunked prefill monopolizes it.
D: In a token-budgeted iteration, decodes need one slot per sequence to advance; a prefill chunk can consume all remaining slots. With chunking off and decode priority off, a 2048-token prefill stalls the whole decode batch for its duration — ITL spikes of hundreds of ms. With chunked prefill, prefill takes bounded bites; with decode priority, decodes go first.
F: Why not always decode-priority? — Prefill starvation: TTFT of new requests degrades; chunking is the balanced fix.
Wrong: "Prefill and decode are independent phases."

**6. Why does chunked prefill help?**
S: It converts one long compute burst into budget-sized slices, decoupling prefill length from decode stall length.
D: Per iteration the prefill advances at most `chunkSize` tokens and leaves the rest of the budget to decodes; TTFT for the chunked request rises slightly (its prefill spans more iterations) while TPOT tails for the resident batch collapse. It also lets the scheduler mix prefill with decode in the same forward pass (higher utilization than prefill-only passes).
F: What limits chunk size from below? — Per-iteration fixed overhead grows relative to useful work; very small chunks waste utilization.
Wrong: "Chunked prefill reduces total prefill compute" — it re-times it; total tokens are unchanged.

**7. Why does preemption have a cost?**
S: The victim loses its KV; resuming means recomputing its context as prefill.
D: Recompute re-runs prefill over `prompt + generated` tokens (minus any prefix-cache hits). The bill lands as `recomputedTokens` — extra compute that buys admission for a higher-priority request now. Without a strict outranking rule, preemptors can thrash; the simulator enforces a total order (arrival, remaining work, class, urgency) so no cycle exists.
F: Alternative? — Swap-out preemption (vLLM's other mode): pay PCIe traffic instead of recompute; better when context is huge and recompute expensive.
Wrong: "Preemption is free — it's just a queue reorder."

**8. Why does KV cache become the capacity bottleneck?**
S: KV grows linearly with context length × batch; compute parallelism grows with GPUs, memory doesn't keep pace.
D: With GQA at 128 KiB/token, a 32k-token context is ~4 GiB — a 40 GB card holds a handful of long contexts' KV after weights. Serving is admission-limited by KV reservations, not FLOPs — hence paged allocation (eliminates fragmentation), reservations (never OOM mid-flight), watermark (protect cache), preemption (reclaim), prefix caching (share), and P/D disaggregation (right-size memory per phase).
F: How does the simulator reflect it? — Conservative reservation + watermark + rejection of oversized contexts.
Wrong: "More GPUs fix KV pressure" — more KV per *request set* matters more than more FLOPs.

**9. Why doesn't disaggregation necessarily improve throughput?**
S: It removes interference but adds a transfer cost and a new coupling: the P/D ratio.
D: A 2P+6D split starves prefill (TTFT p99 blows up while decode GPUs idle); 6P+2D backs up transfer staging (decode capacity binds, prefill KV occupation grows). Aggregate GPU count is unchanged; the *split* decides which queue grows. The simulator shows the queue moving rather than shrinking.
F: When does it clearly win? — Large prefills (long context / RAG) where interference dominates and transfer is cheap relative to prefill compute.
Wrong: "Separating P and D is always faster."

**10. How do you detect a KV-transfer bottleneck in P/D serving?**
S: Queued transfers, growing prefill-pool KV occupation, TTFT dominated by the transfer stage.
D: In the observations: `kvTransferQueueLatency` (prefill-done → transfer start) and `kvTransferLatency` (in flight) separate staging waits from wire time. The `network-bottleneck` scenario (4 GB/s) makes transfers queue while prefill/decode GPUs wait — the fix is interconnect bandwidth or a different P/D ratio, not more GPUs on either side.
F: What about cross-pool KV pressure? — Staging refuses to start when the decode pool can't reserve the full footprint; requests pile in `transfer_wait`.
Wrong: "Look at decode GPU utilization" — it's idle *because* transfers starve it; the cause is upstream.

**11. When is speculative decoding a net loss?**
S: When E[accepted+1] per step, divided by the step-cost multiplier, drops below 1.
D: With iid acceptance p and draft k, E[tokens/step] ≈ 1 + p/(1−p) capped at k+1; compare against the verify+draft cost (e.g., 1.65×). Low acceptance (0.25) yields ≈1.33 tokens/step → 0.81× — *slower*. Long contexts with weak draft models are the classic failure. The simulator's low/high acceptance scenarios quantify both sides.
F: How do real systems adapt? — Dynamic draft length, early-exit verification, draft-model selection per workload.
Wrong: "Speculative decoding always reduces latency" — it's a bet on acceptance.

**12. Why must prefix cache identity be content-based?**
S: Names aren't content: two "chat" prompts can differ from token 0.
D: Identity = chained hash over block token ids (`hash(parent_hash, block_tokens)`): block i matches only if blocks 0..i−1 match — sharing is always a true contiguous content prefix, holes can't be jumped, tails never shared. Name-based keys (family + index) falsely share unrelated content and would silently return wrong KV.
F: Why not a full radix tree? — The flat content table preserves the same guarantees; a trie adds visualization/incremental-insert benefits, not correctness.
Wrong: "Key the cache by the user's session id."

**13. Why is conservative admission (reserve whole output) sometimes better than optimistic?**
S: It converts mid-flight OOM into admission queueing.
D: If you admit on current footprint, a request whose output runs long forces *someone* to evict (preemption) or the system to deadlock on a full pool. Conservative reservation bounds the pool by declared maxima — utilization dips, but running requests never fail. The watermark then tunes how much headroom cache gets.
F: What's the real vLLM behavior? — Optimistic allocation + preemption/swap as the safety valve.
Wrong: "Reservations waste memory compared to on-demand allocation" — they trade utilization for liveness guarantees.

**14. What exactly does the token budget bound?**
S: Tokens *scheduled* per scheduler iteration per replica — decode emissions plus one prefill chunk.
D: It's the lever that turns compute contention into a measurable resource: decodes need one slot per sequence per iteration; prefill chunks take what's left (or take first). It also bounds the per-forward-pass batch size, which is what real systems cap to control step time.
F: Budget too small vs too large? — Too small: utilization and prefill speed suffer; too large: step time balloons, ITL grows.
Wrong: "It's a memory limit" — that's the KV pool; the budget is compute scheduling.

**15. How do you make a scheduler deterministic — and why bother?**
S: Seeded RNG, total orders with tie-breaks, no wall clock; determinism makes experiments replayable and tests meaningful.
D: Every sort has a strict comparator ending in `(arrivedAt, id)`; RNG draws happen in a fixed order; the engine advances in fixed steps. Same seed+config+workload ⇒ byte-identical results, asserted by replay tests. Without it, "change one knob" experiments are noise.
F: Cost of determinism? — None meaningful here; real systems have the opposite requirement (fairness under concurrency).
Wrong: "Determinism means single-threaded" — it means a defined order of decisions.

**16. FCFS vs SJF in serving — when would you pick each?**
S: FCFS for fairness/predictability; SJF to minimize mean latency under heterogeneous workloads.
D: SJF (shortest remaining work) bounds mean flow time but starves long requests under sustained short load — the simulator's ordering uses remaining prompt+output tokens including recompute debt. FCFS is the safe default (vLLM's choice) and prevents "short job keeps cutting in line".
F: How to get both? — Aging / class-based hybrid; or SLO-aware urgency.
Wrong: "SJF is always better for latency" — mean yes, tail and fairness no.

**17. Design an SLO-aware scheduler — where do you start?**
S: Define urgency per request from its deadline, remaining work, and current state; order by it; preempt by it.
D: The simulator's version: `urgency = estimated-time-to-first-token / slack`, with already-violated requests first (deepest violation). Every input is observable; no learned weights. The key design decisions: what estimate to use (work/rate), how to handle violated requests (sorted by depth), and a strict tie-break so preemption can't cycle.
F: How to validate it? — Under overload, compare attainment distributions and *who* gets saved (observations export).
Wrong: "Train a model to predict priority" — unexplainable in incident reviews.

**18. Walk through what happens when a request is preempted and resumed.**
S: Release its KV (shared prefix blocks lose one owner), park it, later re-admit; recompute context; continue decoding.
D: On preempt: non-shared blocks freed, `preemptions++`, compute progress reset. On re-admission the prefill target becomes `promptTokens + generated` — the generated suffix is now context — and `recomputedTokens` counts target minus prefix-cache hits. Invariants: the victim holds nothing while preempted; terminal requests hold nothing; no one is in two pools at once.
F: What about its reserved output budget? — Re-reserved on resume; reservations follow state.
Wrong: "Resume continues from where decode left off without recomputation."

**19. What does the KV watermark trade?**
S: Cache retention vs concurrent batch size.
D: Watermark w makes admission fit in capacity×(1−w): fewer simultaneous sequences, but LRU evictions of prefix blocks become rarer — hit rates rise, recompute/evict churn falls, tails often shorten. The `kv-thrashing` scenario at w=0 vs 0.1 shows evictions and p99 moving opposite to batch occupancy.
F: Dynamic watermark? — Possible: track hit-rate marginal value vs queue pressure.
Wrong: "Watermark prevents OOM" — reservations do; watermark protects *cache*.

**20. Why does static batching waste capacity?**
S: The cohort runs to completion; slots held by finished or straggler sequences do nothing.
D: A batch finishes when its *longest* member finishes; short sequences that completed hold slots (their KV may be freed but the schedule doesn't refill). Continuous batching refills every iteration — the simulator's cohort gate (`admittedAt` equality) makes the waste directly visible.
F: When is static better? — Deterministic latency per batch, simpler memory accounting, offline batch jobs.
Wrong: "Static batching is just older continuous batching" — it's a different scheduling contract.

**21. Explain the block table to a new engineer.**
S: Per-request array mapping logical KV block index → physical block id, like a page table.
D: Allocation is incremental (grow as context grows), physical blocks are shared via refcounts when immutable (prefix cache), and freeing decrements refcounts. This gives OS-style paging for KV: no contiguous allocation, O(small) fragmentation, cheap sharing.
F: What breaks without it? — Contiguous KV allocation → external fragmentation → admission failures despite free memory.
Wrong: "KV is one big contiguous buffer per sequence."

**22. How does prefix caching interact with preemption?**
S: The victim's shared prefix blocks survive; on resume, the prefix hit reduces the recompute bill.
D: Release only removes ownership; published immutable blocks stay cached. On re-admission, the match restores the shared prefix and only the private context is recomputed — preemption cost drops by the prefix length.
F: Does the tail also survive? — No: mutable tail blocks are private and freed.
Wrong: "Preemption wipes the whole cache."

**23. What's in a TTFT number, exactly?**
S: Queue wait + prefill (and in P/D: transfer queue + transfer + decode admission).
D: The observations decompose it: `prefillQueueLatency`, `prefillLatency`, `kvTransferQueueLatency`, `kvTransferLatency`, `decodeQueueLatency` sum to TTFT in disaggregated mode. Decomposition is how you *localize* a tail: admission policy vs compute vs interconnect.
F: Why include queue time? — Users feel it; schedulers control it.
Wrong: "TTFT is prefill compute time."

**24. TPOT vs ITL?**
S: Same concept, different averaging: TPOT averages per-request over its tokens; ITL is the per-step interval distribution.
D: A request emitting 3 tokens in one speculative burst has zero ITL between them — the simulator's token-weighted TPOT handles that; the tail (p99) is where interference shows.
F: Which matters for streaming UX? — ITL spikes (jerkiness), so p99 ITL/TPOT.
Wrong: "TPOT = time per forward pass."

**25. How does the simulator model TP, and what's deliberately simplified?**
S: Ranks share one batch over conceptual shards; TP scales decode duration and KV sharding, not communication.
D: TP efficiency = TP/(1+0.18(TP−1)) speeds decode; a TP group holds one KV pool logically sharded per rank; higher TP reduces replica count. No all-reduce modeling — the ring is a visual. Documented as conceptual.
F: What would real TP modeling add? — Communication time per step, which grows the batch-step cost and changes budget math.
Wrong: "TP=8 always beats TP=1 × 8 replicas."

**26. What breaks first under overload in your simulator?**
S: The admission queue grows; then KV pressure blocks admission; tails explode; goodput falls.
D: Order of symptoms: waiting count climbs (backoff at 128) → conservative reservations serialize admission → TTFT p99 balloons → SLO attainment collapses while completed count still rises → in P/D mode, transfer staging backs up first if decode capacity binds.
F: What's the correct operator response? — Shed load or admit less (watermark/admission control), not "add budget".
Wrong: "Increase max batch size" — often worsens TPOT tails.

**27. Why share bandwidth equally among transfers in the transfer model?**
S: It's the simplest deterministic contention model; refinements are policy, not mechanism.
D: With C concurrent transfers each gets BW/C — conservative and fair, keeps completion order deterministic. Real fabrics have QoS, congestion, and topology effects; the simulator's claim is about *queueing structure*, not fabric physics.
F: How would you model priority transfers? — Weighted shares; note determinism is preserved if weights are static.
Wrong: "Each transfer gets full bandwidth" — then nothing ever contends.

**28. Why do reservations cover the *output* length too?**
S: Output tokens allocate KV as they generate; the pool must be able to hold the worst case.
D: A request's KV grows by one token per decode step; without reserving headroom, a long output can exhaust the pool mid-decode and force preemption. Conservative reservation (prompt+output) makes running requests un-preemptable-by-OOM; the cost is idle headroom — the watermark then tunes it.
F: What if output length is unknown? — That's the real-world case: cap + preemption as backstop.
Wrong: "Only prompt KV matters for admission."

**29. How does the simulator prove "no KV leak"?**
S: A continuously-run invariant: every block's owner set must reference it and vice versa, per pool, every N ticks in stress tests.
D: Checks include: no duplicate block in a request's table; shared blocks immutable; terminal/preempted requests own nothing; workers schedule only active requests; budget usage ≤ limit; transfer pipeline contains only transfer-phase requests. Randomized stress runs tens of thousands of ticks across adversarial configs. Any failure is a bug to fix — never a relaxed assertion.
F: Why every N ticks, not every tick? — Runtime; correctness-critical paths still check per-step in the focused tests.
Wrong: "We test memory leaks at the end of runs only."

**30. What does deterministic replay buy you in practice?**
S: Experiments become counterfactuals; regressions become exact.
D: Same seed+config+workload reproduces byte-identical runs — so A/B captures differ *only* by the changed knob; a failure reproduces on demand; the CLI can re-verify a historical result. The suite enforces it at engine and scenario level.
F: What's the cost? — Discipline: no wall-clock decisions anywhere in the core.
Wrong: "Randomize tests for coverage and accept flakiness."

**31. Why cap `maxNumBatchedTokens` ≥ `maxBatchSize`?**
S: The decode batch needs one slot per sequence; the budget must cover it.
D: Below that, decodes would structurally stall even with no prefill — a config that only produces pathology. The simulator clamps it and documents why.
F: What about speculative decode's extra tokens? — Modeled as compute cost (duration multiplier), not extra budget slots — a documented simplification.
Wrong: "Budget is independent of batch size."

**32. In P/D serving, what does the router need to know?**
S: Prefill-pool load (and cache affinity); decode capacity enters indirectly via staging.
D: The simulator routes by least-loaded prefill pool with cache-affinity tie-breaks; decode placement happens at transfer staging (least-loaded decode pool with capacity). A router that ignores decode capacity just moves the wait into `transfer_wait` — visible in `kvTransferQueueLatency`.
F: What would a better router use? — Forecast decode-pool drain; global backpressure.
Wrong: "Round-robin is optimal."

**33. Why can a big batch make p99 *worse*?**
S: Step time grows with batch; everyone's ITL stretches; tails compound.
D: Decode duration in the model grows with batch length; more sequences per iteration means each token costs more for all — p50 may still improve (throughput) while p99 crosses the SLO. Bigger batch = higher utilization but tighter coupling.
F: The knob interplay? — Budget caps batch scheduling; chunked prefill and decode priority shape who waits.
Wrong: "Maximize batch size to maximize throughput."

**34. What's the difference between admission control and scheduling?**
S: Scheduling orders *who's next*; admission decides *who may enter at all* given resources.
D: The simulator separates them explicitly: policies order the queue; the admission controller enforces reservations/watermark/batch slots. Conflating them makes policies untestable and reasons unexplainable (the wait reason tells you which constraint bound).
F: Where does preemption sit? — It's the feedback edge: admission failure can trigger eviction.
Wrong: "Scheduling includes memory management."

**35. How would you add swap-based (offload) preemption to this design?**
S: Move the victim's KV to a CPU tier instead of freeing; restore on resume — pay bandwidth, not recompute.
D: The tier machinery already models GPU→CPU moves with bandwidth and latency; swap-preemption is: on preempt, demote the victim's blocks (like cache demotion), mark the request `swapped`, and on resume restore (or recompute if the tier lost it). The trade vs recompute flips with context size and restore bandwidth.
F: When is recompute better? — Short contexts, fast compute, slow/contended host memory.
Wrong: "Swap is strictly cheaper."

**36. Why does the simulator emit a `chunk` event per chunked-prefill step?**
S: Observability of scheduling decisions is the point of the tool.
D: Each event ties `requestId + time + "prefill chunk N tokens (processed/target)"` so you can correlate budget usage, prefill progress, and decode stalls on one timeline. Trace events are the "why did the system do this" surface.
F: Event log size? — Bounded (150 newest); the full per-request record lives in observations.
Wrong: "Logs are for debugging, not for the product."

**37. Your simulator reports prefix hit rate 94% but TTFT barely improved. Hypotheses?**
S: Hits on small prefixes, hits on requests that weren't prefill-bound, or hits that don't reduce the critical path (queue-bound).
D: Three mechanisms: (1) cached tokens ÷ prompt too small to matter; (2) the bottleneck is admission queueing, not prefill compute — hits don't shorten the queue; (3) replica-locality misses: the warm pool isn't the pool the request lands on. The observations' `prefillLatency` vs `queueLatency` split discriminates.
F: Fix for (3)? — Cache-aware routing (the simulator already affinity-breaks ties).
Wrong: "The cache is broken."

**38. What would you build next, and why that order?**
S: (1) Radix-tree prefix visualization, (2) swap preemption, (3) Web Worker offload, (4) router policies.
D: Each has a clear experiment: tree → teach incremental prefix sharing; swap → complete the preemption story; worker → keep UI smooth at stress sizes; router → make global scheduling policy a first-class experiment. Deliberately *not*: real tokenizers/models (breaks the "no GPU, no weights" contract), persistence/backends (no system need).
F: What would you *remove*? — Nothing without an experiment proving it redundant.
Wrong: "Add a database for run history" — files and export cover the need.

**39. How do you know your 22 scenarios cover the interesting trade-offs?**
S: Each maps to a named mechanism interaction with a documented "what to observe", and the interview-guide questions all have a scenario that demonstrates them.
D: Coverage follows the claim surface: every config knob appears in ≥1 scenario where it changes the outcome; the tests assert the *direction* of key effects (warm TTFT < cold, transfer-before-decode, spec overrun impossible, preemption frees KV, watermark reduces evictions).
F: What's NOT covered? — Multi-model routing,LoRA adapters, beam search, real tokenization.
Wrong: "More scenarios = better" — scenarios must isolate, not pile up.

**40. Defend the fixed 20 ms step.**
S: It makes one step = one scheduler iteration = one forward pass — a legible, invariant-friendly abstraction.
D: Variable step times would couple cost modeling into every scheduling decision (and break the budget story: "tokens per step" implies uniform steps). The step is the quantum; all cost models express *per-step* work. Absolute ms values are illustrative either way.
F: When would you need variable steps? — Modeling step-time vs batch-size curves; then the budget becomes a time budget instead.
Wrong: "20 ms is what vLLM uses."

**41. Why does the decode-priority-off mode exist at all?**
S: It's the control group for the interference experiment — and some real schedulers/serving modes do prefill-first.
D: With prefill-first, you can *show* TPOT p99 collapsing under a long prefill and then recovering with chunking — a causal chain, not a claim. Default is decode-priority-on (vLLM v1 behavior).
F: What does prefill-first buy in reality? — Shorter TTFT for new arrivals at the cost of resident ITL — a legitimate policy choice under TTFT-heavy SLOs.
Wrong: "It's a bug that decodes stall."

**42. How do you keep the UI honest about simulated numbers?**
S: Labels: "SIMULATED · NOT A BENCHMARK" in the chrome; tips mark synthetic estimates; docs audit every claim.
D: The README claims audit removed all performance-percentage language not derived from a reproducible in-repo experiment; GPU utilization is labeled a synthetic occupancy estimate; tier latencies are marked illustrative. The final deliverable includes an explicit claim audit.
F: Where's the line? — Ratios and mechanisms (measurable in-sim) vs absolute performance claims (forbidden).
Wrong: "It looks like a monitoring dashboard, so the numbers read as real."

## Part 3b — Interview risk audit: "isn't this fake?"

Per mechanism: what is **simulated** (mechanism with real dynamics), what is **conceptual** (structure without dynamics), what is **measured** (nothing is), and what is **not modeled**. Memorize the table — it is the honest answer to every "isn't this just made up?" question.

| Mechanism | Simulated (real dynamics) | Conceptual (structure only) | Not modeled |
| --- | --- | --- | --- |
| Token budget | budget-constrained scheduling, decode/prefill contention, deferrals | one iteration = one forward pass | kernel time, step-time vs batch curves |
| Chunked prefill | multi-iteration prefill, budget interplay | — | per-chunk kernel efficiency |
| Paged KV / block table | incremental allocation, sharing, refcounts, eviction | block = fixed token count | page-table memory cost, fragmentation bits |
| Prefix cache | content-addressed sharing, LRU, hit-rate effects | — | real tokenizer, incremental prefill kernels |
| Multi-tier KV | demote/restore pipeline, bandwidth sharing, per-block plans | tier = hash store + bytes | device buses, real PCIe/NVMe behavior |
| Preemption | recompute bill, residency, cooldown, livelock avoidance | cost = recomputed tokens | swap-to-CPU path, host memory bandwidth |
| Starvation aging | promotion, threshold events | hard priority bump | gradual weight aging, fairness proofs |
| Speculative decoding | draft/verify accounting, acceptance economics | iid acceptance per token | draft model, tree drafts, correlated acceptance |
| Tensor parallel | replica sharding, decode-duration scaling | ranks execute same batch | NCCL, all-reduce timing, memory per rank |
| P/D disaggregation | queue movement, transfer queueing, backpressure | pool topology | RDMA fabric, topology, congestion |
| KV transfer | byte payload, latency, sharing policies | equal-split / serial service | RDMA verbs, per-link contention |
| SLO / goodput | per-request verdicts, attainment, goodput accounting | SLO = two thresholds | multi-dim SLOs, admission pricing |
| GPU utilization | synthetic occupancy from phase + batch fill | — | any hardware telemetry |
| Cost models (prefill/decode timing) | queueing effects, ordering effects | fixed 20 ms step, closed-form durations | measured hardware timings |

Rule of thumb for the interview: **ratios and mechanisms** (interference, queue movement, attainment collapse) transfer to real systems; **absolute milliseconds** do not, and the docs never claim they do.

### New hardening Q&As

**43. What happens if you just "open preemption up" for everyone?**
S: Livelock: two requests can swap places every iteration, each preempting the other.
D: We hit exactly this during hardening — the admission pass admitted the just-evicted victim instead of the preemptor, producing an infinite swap. The fix is structural: retry the candidate immediately, exclude the fresh victim for that pass, then add cooldown + minimum residency so storms are rate-limited. The `priority-preemption-storm` scenario shows the guarded behavior; the regression lives in the scenario drain test.
F: Why cooldown instead of only the structural fix? — Defense in depth: the fix removes the cycle; the cooldown bounds the rate under churn.
Wrong: "Preemption is safe as long as priorities differ."

**44. How does the multi-tier cache handle a prefix that's half in GPU, half in CPU?**
S: Block-granular reuse plans: each prefix block resolves to the fastest tier holding it; the first block that exists nowhere ends the reusable run.
D: `buildReusePlan` walks the chained hashes: `B0,B1 gpu / B2,B3 cpu / B4 remote / B5+ recompute`. Each tier with missing blocks schedules its own restore (own bandwidth/latency); the request waits until all restores land, then admits with a full GPU hit. A hole cannot be jumped — the chain hash makes any non-contiguous reuse impossible.
F: Why wait for all restores instead of decoding on partial? — Partial KV isn't decodable; the prefix must be resident before prefill can resume from it.
Wrong: "The cache fetches only the blocks it needs at decode time."

**45. Why does prefill admission need backpressure in P/D serving?**
S: Without it, a fast prefill pool keeps producing KV that queues on the transfer path while decode is the real bottleneck.
D: `maxPendingDecodeRequests` caps the decode pipeline; at the cap, prefill admission pauses (backpressure events/ticks are counted). The mechanism converts wasted prefill compute + un-transferable KV occupancy into honest queueing at the front door — where admission control is supposed to happen.
F: Count-based vs byte-based limits? — Count is simpler and pedagogically clear; byte-based shaping is a plausible v2.
Wrong: "Backpressure means rejecting requests."

**46. Why both single-seed and multi-seed experiments?**
S: Single seed proves byte-identical reproducibility; multiple seeds quantify sensitivity and make A/B comparisons paired.
D: The same seed list runs for every variant, so per-seed deltas are meaningful; aggregates report mean/median/min/max/stddev (population) for the tail metrics that matter. Fingerprints (config/workload/result hashes + engine/schema version + git SHA) make every published number traceable.
F: Why population stddev? — Documented, simple, and the seed list is the whole population of interest, not a sample.
Wrong: "One deterministic run generalizes."

**47. What does the state machine buy over plain status fields?**
S: Illegal transitions throw at the transition site instead of surfacing as unreachable states later.
D: The table is the single source of truth (tests crawl the engine asserting every observed change is legal). During hardening it turned the preemption livelock from a "weird metric" into an obviously impossible-state hunt, and it documents the lifecycle for free.
F: Overhead? — One table lookup per transition; the idempotent same-state case short-circuits.
Wrong: "It's a framework" — it is a record and a function.

---

## Part 4 — Rapid-fire one-liners

- **vLLM's core ideas**: iteration-level scheduling, paged KV, prefix caching, conservative preemption, token budgets — this simulator mirrors the *shape*, not the implementation.
- **Chunked prefill**: timeshare the prefill; buy decode smoothness with slightly longer TTFT.
- **Decode priority**: resident tokens first; watch new-request TTFT if you overdo it.
- **P/D disaggregation**: move the interference, don't delete it — the P/D ratio picks which queue grows.
- **Goodput**: the only throughput that matters when someone wrote an SLO.
- **p99**: the promise you actually made.
- **Determinism**: the difference between a demo and an experiment platform.
- **Recompute preemption**: memory you didn't reserve becomes compute you didn't plan.
- **Prefix caching without content hashes**: a cache that lies.
- **Conservative admission**: fewer running requests, zero mid-flight OOMs.
