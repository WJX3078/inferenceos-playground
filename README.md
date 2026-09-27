# InferenceOS Lab

**A deterministic, interactive, reproducible simulator for modern LLM serving systems — running entirely in your browser.**

No API key, no model download, no GPU, no backend, no cloud service. Clone it, run it, experiment with it.

## What is InferenceOS Lab?

InferenceOS Lab is an **educational systems simulator**: it models the scheduling and memory behavior of a modern LLM serving stack — continuous batching, token-budget scheduling, chunked prefill, paged KV cache, prefix caching, preemption, speculative decoding, conceptual tensor parallelism, prefill/decode disaggregation, KV transfer, and SLO/goodput accounting — as a fixed-step deterministic simulation you can pause, single-step, inspect, and re-run.

## Why does it exist?

Reading about vLLM-style schedulers teaches you the vocabulary; running experiments teaches you the trade-offs. This project lets you *feel* why:

- higher throughput does not mean better serving (throughput vs goodput),
- one long prefill can wreck everyone's TPOT (prefill/decode interference),
- a bigger batch can make p99 latency worse,
- preemption trades KV memory for fairness — at a recompute cost,
- the wrong P/D ratio just moves the queue somewhere else,
- speculative decoding can be a net *loss* under low acceptance.

## What can I learn from it?

Every mechanism a modern serving scheduler has: admission control, token budgets (`max_num_batched_tokens`), chunked prefill, decode priority, paged KV blocks and block tables, content-addressed prefix caching, LRU eviction, KV watermarking, recompute preemption, speculative drafting/verification, tensor parallelism (conceptual), prefill/decode disaggregation with KV transfer, and tail-latency (p50/p95/p99), SLO and goodput accounting. 29 built-in scenarios each isolate one trade-off; see the scenario banner in the app and [docs/experiments.md](docs/experiments.md).

## How do I run it?

Requires Node.js 22+ and npm.

```bash
npm ci
npm run dev -- --port 5178
```

Open http://127.0.0.1:5178. Pick a scenario, press Run, single-step, change one knob, and use **Compare** to capture runs side by side.

Headless experiments (no browser):

```bash
node scripts/experiment.ts scenarios/example-budget-sweep.json
```

## How do I reproduce an experiment?

Every run is fully deterministic: **same engine version + same seed + same config + same workload ⇒ identical results** (asserted by tests). Use *Export scenario* to save a versioned JSON (v1 schema, see [docs/experiments.md](docs/experiments.md)), *Export run* to dump config + metrics + per-request observations + events, or the CLI runner to sweep parameters headlessly.

## What systems concepts are simulated?

| Area | Simulated |
| --- | --- |
| Batching | continuous & static batching, per-iteration token budget, chunked prefill, decode priority |
| Memory | paged KV blocks, block tables, conservative admission reservations, KV watermark |
| Caching | content-hash prefix identity, immutable shared blocks, LRU eviction, GPU/CPU/remote tiers with block-granular restore plans |
| Robustness | cost-aware recompute preemption (cheapest victim, cooldown, minimum residency, prefill-only mode), starvation aging |
| Scheduling | FCFS, SJF/shortest-remaining-work, Priority, SLO-aware (explainable urgency) |
| Topology | replicas, conceptual TP, prefill/decode disaggregation, simulated KV transfer (fair-share/FIFO/priority), P/D backpressure |
| Real workloads | JSONL/JSON trace replay with validation and adapters; Observed-vs-Simulated reference display |
| Optimization | configurable speculative decoding (draft length, acceptance profile, step cost) |
| Experiments | scenario JSON v1 with schema validation, result fingerprints, multi-seed paired statistics, headless CLI, real-trace replay |
| Metrics | TTFT/TPOT/E2E means **and p50/p90/p95/p99**, SLO attainment, goodput, utilization, event trace |

## What is NOT simulated?

No neural inference, no tokenizer, no real attention math, no CUDA kernels, no NCCL/RDMA, no model weights, no hardware benchmarking, no network stack. All latency/bandwidth/acceptance numbers are **illustrative model parameters**, not measurements. This project is *inspired by* vLLM's execution model; it is not vLLM, cannot predict production performance, and no number it produces should be read as a hardware benchmark. Details: [docs/limitations.md](docs/limitations.md).

## Verify

```bash
npm test              # deterministic unit / invariant / stress / replay tests
npm run build         # type check + production bundle
npx playwright install chromium
npm run test:e2e      # real-browser workflows at 360-1920 px
npm run check         # all of the above
npm run docs:check    # README/docs consistency (links, scenario counts, claims)
node scripts/bench.ts # engine microbenchmark (JS simulator speed only)
```

GitHub Actions splits `unit-build` and `e2e` jobs, cancels superseded runs, and uploads the Playwright report on failure.

## Repository Layout

```text
inferenceos-playground/
├── .github/workflows/ci.yml # unit+build and e2e jobs, concurrency, timeouts
├── docs/                    # architecture, per-mechanism docs, design decisions,
│                            #   testing strategy, demo script, interview guide
├── e2e/                     # Playwright browser tests
├── scenarios/               # versioned experiment JSON (v1 schema)
├── scripts/                 # experiment CLI, bench, docs-check, screenshot capture
├── src/components/          # React views (configuration & display only)
├── src/simulation/          # deterministic simulation core (React-free)
│   ├── engine.ts            #   orchestrator: clock, step loop, intake, invariants
│   ├── runtime/             #   admission, executor, preemption, lifecycle, accounting
│   ├── scheduler/           #   FCFS / SJF / Priority / SLO policies
│   ├── cache.ts             #   paged KV cache, content-hash prefix identity, tiers
│   ├── transfer.ts          #   simulated KV transfer manager (scheduling policies)
│   ├── workload.ts          #   seeded workload generator (constant/poisson/burst/trace)
│   ├── trace.ts             #   JSONL/JSON trace import + validation
│   ├── trace-adapters/      #   OpenAI-compatible adapter, documented mini-vllm interface
│   ├── metrics.ts           #   observations, percentiles, SLO, goodput
│   ├── experiment.ts        #   scenario files, validation, sweeps, multi-seed, fingerprints
│   ├── version.ts           #   engine version (replay comparability)
│   └── *.test.ts            #   invariant, regression, property, randomized stress tests
└── src/App.tsx              # simulation clock & workspace shell
```

The engine never touches wall-clock time; one `step()` advances 20 simulated milliseconds (one scheduler iteration). React only configures and displays.

## Two-Minute Demo

1. **0:00-0:20 — Continuous batching.** Watch arrivals turn blue (prefill) then green (decode); freed slots refill every iteration.
2. **0:20-0:40 — Static batching.** Switch scenario; slots sit idle while a cohort drains. Toggle continuous batching to fill them.
3. **0:40-1:00 — Interference.** Run *Long-prefill interference* (decode priority off, no chunking): TPOT p99 explodes while a 2048-token prefill eats the token budget. Enable chunked prefill or decode priority and watch the tail recover — use Compare to pin the numbers.
4. **1:00-1:20 — Prefix caching.** In *Prefix-heavy*, shared purple blocks appear after the cold prefill; warm requests skip most prefill work.
5. **1:20-1:40 — KV pressure & preemption.** Run *Priority + preemption*: a high-priority arrival evicts a running low-priority request; watch `preempt`/`resume` events and the recompute bill.
6. **1:40-2:00 — Disaggregation.** Run *Disaggregated 4P+4D*: prefill and decode pools, KV transfer events, and the transfer queue under the *Network bottleneck* scenario.

## Documentation

- [docs/architecture.md](docs/architecture.md) — engine architecture and data flow
- [docs/scheduler.md](docs/scheduler.md) — policies, token budget, chunked prefill, preemption
- [docs/kv-cache.md](docs/kv-cache.md) — paged blocks, watermark, multi-tier memory
- [docs/prefix-cache.md](docs/prefix-cache.md) — content-addressed prefix identity
- [docs/disaggregated-serving.md](docs/disaggregated-serving.md) — P/D pools and KV transfer
- [docs/speculative-decoding.md](docs/speculative-decoding.md) — draft/verify economics
- [docs/metrics.md](docs/metrics.md) — definitions, percentile method, trace format
- [docs/slo-goodput.md](docs/slo-goodput.md) — SLO, goodput, throughput vs quality
- [docs/experiments.md](docs/experiments.md) — scenario JSON schema, CLI, sweeps, replay
- [docs/limitations.md](docs/limitations.md) — what this simulator is not
- [docs/interview-guide.md](docs/interview-guide.md) — 30s/1min/3min pitches + 40 Q&A for AI Infra interviews

## Testing

The suite treats correctness as the product: invariant tests (no KV leaks, no duplicate page ownership, no mutable shared pages, budget never exceeded, transfer-before-decode, exact output lengths, deterministic replay), deterministic regression tests per serving behavior, property-based tests (monotonic counters, transfer conservation, no queue black holes), and randomized stress tests across adversarial configurations with invariants checked throughout. An explicit request state machine makes illegal transitions throw; a mutation-style bug-class map lives in [docs/testing-strategy.md](docs/testing-strategy.md). No test is skipped to make the suite green.

## License

[MIT](LICENSE)
