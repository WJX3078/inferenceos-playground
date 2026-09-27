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

## Preemption (recompute mode)

With `preemptionMode: 'recompute'`, when a waiting/preempted candidate cannot be admitted (KV pressure, watermark, or batch slots) and its policy says it strictly outranks a running request, the engine evicts the *least deserving* victim (the last one in the scheduler's order among eligible victims):

1. The victim's non-shared KV ownership is released (shared immutable prefix blocks simply lose one owner).
2. Status → `preempted`; `preemptions++`; compute progress reset; the request leaves the pool.
3. On re-admission the request becomes a **recompute**: its prefill target is `promptTokens + generated` (the generated suffix is now context). `recomputedTokens` counts the tokens actually recomputed (target minus any prefix-cache hit).
4. Events: `preempt` (with the winner), `resume` (with the recompute size), and a `prefill` completion event carrying the recompute bill.

Termination and no-livelock: preemption requires a *strict* outranking in a total order (arrival, remaining work, class, or urgency — all with `(arrivedAt, id)` tie-breaks), so two requests can never preempt each other in a cycle. Disaggregated mode never preempts requests that already finished prefill (their KV is committed to the decode pool); prefill-phase preemption works normally.

Counters: global `preemptions` and `recomputedTokens` in the metrics strip, per-request `preemptions` / `recomputedTokens` in the inspector and the observations export.

## KV watermark (`kvWatermark`)

`kvWatermark ∈ [0, 0.5]` reserves a fraction of each pool away from admission: usable capacity = `capacity × (1 - watermark)`. Admission (and transfer staging) must fit inside the usable capacity; retained cache blocks are not reserved but may be evicted. A watermark admission denial emits a `watermark` wait event. See [kv-cache.md](kv-cache.md) for the memory model and the `kv-thrashing` scenario for the experiment.
