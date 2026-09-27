# Scheduler design

The scheduler is a set of swappable **policies** (`src/simulation/scheduler/`). A policy only *orders* work; the engine owns all feasibility checks (KV reservation, watermark, batch slots, token budget). This mirrors the vLLM split between scheduling policy and core loop, and keeps every policy deterministic and testable.

## Policies

All policies sort the admission queue (waiting + preempted requests) and pick which prefilling sequence advances its chunk each iteration. Ties break by `(arrivedAt, id)` — a strict total order with no pathologies.

### 1. FCFS

Strict arrival order. The default policy and the closest match to classic vLLM. Preemption rule: a candidate may evict a victim that arrived *strictly later*.

### 2. SJF / Shortest Remaining Work

```
remaining(r) = (promptTokens + generated - processed) + (outputTokens - generated)
```

For a running request this is its remaining prompt work plus remaining output tokens. A preempted request must recompute the tokens it already generated (they became context), so `contextTarget` counts them — the estimate stays honest across preemptions. Ties by arrival. Preemption rule: strictly less remaining work.

*Why document the formula?* SJF is optimal for mean flow time on a single machine but starves long requests under sustained short load — the estimate's exact definition determines who starves.

### 3. Priority

Requests carry a class (`low < normal < high`, set per request or by the workload's priority mix). Higher classes are always admitted first; equal classes fall back to arrival order. Preemption rule: **strictly higher class** may evict a running lower-class request — same-class requests never preempt each other, which bounds thrashing. Without preemption this policy happily starves `low` (see the `starvation-test` scenario — that is the lesson, not a bug).

### 4. SLO-aware

Each request carries (or inherits) a TTFT SLO in milliseconds. The scheduler computes an explainable urgency score:

```
deadline = arrivedAt + sloTTFT
slack    = deadline - now                          (ms left before violation)
workLeft = contextTarget - processed               (prompt tokens still to prefill)
estMs    = ceil(workLeft / perIterationPrefill) * 20ms
urgency  = slack <= 0 ? ALREADY_VIOLATED(deeper first) : estMs / slack
```

`perIterationPrefill` is the effective per-iteration prefill capacity (`min(chunkSize, budget)`). Urgency > 1 predicts a TTFT miss. Requests predicted to violate run first; already-violated requests run before everything (deepest violation first), then descending urgency, then arrival. There are no magic weights — every input is a number the simulator already knows. Preemption rule: strictly higher urgency.

## Token budget (`maxNumBatchedTokens`)

Each replica runs one scheduler iteration per 20 ms tick with a global budget of scheduled tokens (the vLLM v1 `max_num_batched_tokens` idea):

- Each **decoding sequence scheduled this iteration consumes 1 budget slot** (one token of a batched forward pass). If the budget is exhausted by prefill, the remaining decode sequences simply do not run this iteration — their next token slips a full iteration, which is exactly the ITL/TPOT spike you can observe.
- **At most one prefill sequence advances per iteration** (vLLM v1 schedules one partial prefill per step), consuming `min(remaining, prefillChunkSize, budgetLeft)` tokens.
- `prefillChunkSize = 0` means chunking is off: the prefill takes `min(remaining, budgetLeft)` — large bites that can starve decodes on a small budget.
- `decodePriority = true` (default): decodes claim budget first, prefill gets the leftover. `false`: prefill claims first — long prefills stall the decode batch.

The engine records per-iteration usage (`decode / prefill / unused`) per pool, renders it in the Token Budget panel, and exposes a utilization EMA as `tokenBudgetUtilization`. The budget is never exceeded (invariant-tested).

Worked example — `long-prefill-interference` scenario: budget 32, batch of 8 decoders (needs ≤ 8 slots), 2048-token prefill. Decode priority off: prefill consumes all 32 slots every iteration; decodes stall for the ~64 iterations of the prefill. Chunked prefill 16: prefill takes ≤ 16, decodes get the rest. Decode priority on: decodes take their ≤ 8, prefill gets ≥ 24.

## Chunked prefill

A long prompt does not have to be prefilled in one iteration. With `prefillChunkSize = 512`, a 4096-token prompt is processed 512 tokens per iteration across 8 iterations (budget permitting), emitting a `chunk` event each time. Guarantees:

- `processed ≤ promptTokens` at all times (invariant-tested) — no overflow,
- KV blocks are allocated incrementally for exactly the processed tokens,
- the chunk competes for the same token budget as decodes (the trade-off chunking exists to manage).

## Preemption

Preemption is a policy decision with a price. `preemptionMode` selects the behavior (legacy `'recompute'` normalizes to `'cost-aware'`):

| Mode | Who may be evicted | Victim choice |
| --- | --- | --- |
| `none` | nobody | — |
| `prefill-only` | requests still in prefill | least-deserving by policy order |
| `cost-aware` | any running request on an eligible pool | **cheapest victim** |

**Victim cost (documented heuristic — an illustrative policy, not vLLM behavior):**

```
recomputeCost(v) = contextTarget(v) - v.cachedTokens
```

the tokens a resume would recompute (prompt + generated suffix minus the prefix hit the victim enjoyed). Preempting a request that just started prefill is cheap; preempting one that decoded for seconds is expensive — the scheduler prefers young, small victims.

**Anti-storm guarantees (deterministic, no wall clock):**

- *Minimum residency*: `MIN_RESIDENCY_MS = 200` — a victim must have run at least 200 simulated ms before eviction.
- *Cooldown*: `preemptionCooldownMs` (default 500) — at most one preemption per cooldown window engine-wide.
- *Strict ordering*: the candidate must strictly outrank the victim in the scheduler's total order, so cycles are impossible.
- *Victim exclusion*: after a preemption the candidate is retried immediately and the fresh victim is excluded from the rest of that admission pass (the structural fix for a victim/candidate swap livelock found during v1.0 hardening).

**Mechanics:** the victim's non-shared KV ownership is released (shared immutable prefix blocks lose one owner), status → `preempted` via the state machine, compute progress reset. On re-admission the request recomputes: its prefill target is `promptTokens + generated`, and `recomputedTokens` counts target minus the new prefix-cache hit. Events: `preempt` (with winner and estimated cost), `resume`, and a `prefill` completion carrying the recompute bill.

Disaggregated mode never preempts requests past prefill (their KV is committed to the decode pool).

Counters: global `preemptions` / `recomputedTokens`; per-request in the inspector and observations export.

## Starvation protection (aging)

Without protection, SJF/priority/SLO ordering can starve requests under sustained adverse load. With `starvationThresholdMs > 0` (default 10000), any request waiting at least that long is promoted to the FRONT of the admission order (arrival-ordered) regardless of policy, until it is admitted. First promotion emits a `starvation` event and increments `starvationEvents`; `maxQueueWait` reports the largest observed queue latency. FCFS is unaffected (arrival order is already aging-complete). The `starvation-aging` scenario shows a long SJF victim finally running under a flood of short requests.

## P/D backpressure

In disaggregated mode, `maxPendingDecodeRequests` (0 = off) caps the decode-side pipeline (`transfer_wait + transferring + decode_wait`). When the cap is reached, prefill admission PAUSES (requests keep their `waiting` status with reason "Backpressure: decode pipeline full") instead of producing un-transferable KV. Rising edges count `backpressureEvents`; saturated ticks count `backpressureTicks`. See docs/disaggregated-serving.md.

## KV watermark (`kvWatermark`)

`kvWatermark ∈ [0, 0.5]` reserves a fraction of each pool away from admission: usable capacity = `capacity × (1 - watermark)`. Admission (and transfer staging) must fit inside the usable capacity; retained cache blocks are not reserved but may be evicted. A watermark admission denial emits a `watermark` wait event. See [kv-cache.md](kv-cache.md) for the memory model and the `kv-thrashing` scenario for the experiment.
