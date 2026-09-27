# Demo scripts

Both demos are deterministic: same scenario, same seed, same result — every number you will see can be reproduced by anyone afterwards.

## 90-second demo (the interview opener)

Open the app (`npm run dev -- --port 5178`). Keep the Runtime tab visible and the Compare tab one click away.

**0:00–0:25 — The interference problem.**
Select the **Long-prefill interference** scenario. Narrate: "Decode priority is off and chunking is off, so one 2048-token prefill monopolizes the per-iteration token budget. Watch the decode sequences' TPOT p99 in the metrics strip." The yellow decode stalls while the blue prefill walks through the budget — point at the budget bar (decode slots go to zero while a prefill chunk is scheduled).

**0:25–0:50 — The fix, measured.**
Pause. Enable **Prefill chunk 64**. Resume. "Same workload, same seed: the prefill now takes budget-sized bites, and the decode batch keeps emitting every iteration — TPOT p99 recovers; the prefill's own TTFT pays a little." Then click **Compare**, **Capture current run**, toggle **Decode priority** on, run again, capture B — the table shows the two runs side by side across 20 metrics.

**0:50–1:15 — Scale it up: disaggregation.**
Switch to **Disaggregated 4P+4D**. Narrate: "Prefill and decode now run on separate pools; KV crosses the interconnect." Point at the transfer events in the trace and the P/D utilization split. Then select **Network bottleneck (P/D)**: "Cut the transfer bandwidth and the pipe becomes the scheduler — transfers queue, TTFT p99 is transfer-dominated. The P/D ratio doesn't remove the queue; it moves it."

**1:15–1:30 — Close.**
"Everything you just saw is deterministic — same seed, byte-identical replay — backed by invariant and stress tests. It's a teaching simulator with illustrative cost models, not a benchmark; the docs include an audit of exactly what is and isn't modeled."

## 5-minute demo (deep dive)

1. **0:00–1:00 — Schedulers.** Run **SLO overload** (3 req/s vs a 400 ms TTFT target): throughput climbs while goodput and SLO attainment collapse. Switch the policy to **SLO-aware** live: same throughput, different *who gets saved*. Open the inspector on a completed request to show its SLO verdicts.
2. **1:00–2:00 — Memory.** Run **Prefix-heavy**: purple shared blocks appear after the cold prefill; warm requests show `cachedTokens` and lower TTFT. Then **KV-cache pressure**: conservative reservations queue requests, LRU evicts, page reuse generations climb. Toggle the **KV watermark** to 0.1 and capture in Compare: fewer evictions, shorter tail.
3. **2:00–3:00 — Preemption economics.** Run **Priority + preemption**: a high-priority arrival evicts a running low; walk the `preempt` → `resume` → recompute-bill events. Then **Cost-aware preemption**: the cheapest victim is chosen and the recompute bill is smaller. Mention the cooldown/residency guards and the livelock they exist to prevent.
4. **3:00–4:00 — Topology.** **Disaggregated 2P+6D** vs **6P+2D** in Compare: the queue visibly moves from prefill admission to transfer staging. **Decode backpressure (P/D)**: prefill admission pauses when the decode pipeline fills.
5. **4:00–4:40 — Experiments.** Export a scenario JSON, open a terminal, `node scripts/experiment.ts scenarios/example-budget-sweep.json` — show the three-budget sweep table and the fingerprint line (config/workload/result hashes). Mention `--seeds 1,2,3,4,5` for paired statistics and JSONL trace import for real workload shapes.
6. **4:40–5:00 — Boundaries.** "Everything is illustrative cost models — no CUDA, no NCCL, no model weights, and trace observations are reference-only. What it teaches is the *mechanism*: budgets, interference, memory pressure, and where the queue goes."

## Demo hygiene

- Never pick scenarios by luck: every step above has a stable scenario id and a fixed seed (73 default).
- If asked for a number you don't see, run it: the CLI gives reproducible answers in seconds.
- If asked "is this real performance?": answer with docs/limitations.md — it is a mechanism simulator, and that is the point.
