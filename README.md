# InferenceOS Playground

A local, interactive LLM inference systems simulator. No API key, model download, GPU, backend, or cloud service is required.

![InferenceOS Playground runtime](docs/images/inferenceos-playground.png)

## Run

Requires Node.js 22+ and npm.

```bash
# After cloning the repository or extracting the release archive:
cd inferenceos-playground
npm ci
npm run dev -- --port 5178
```

Open http://127.0.0.1:5178. Vite selects the next available port if occupied.

## Verify

```bash
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

E2E tests launch or reuse port 5178 and exercise Chromium at widths 360 through 1920. Screenshots are generated in `artifacts/`. `npm run preview -- --port 5179` serves the production build.

GitHub Actions runs the simulation tests, production build, and Chromium suite for pushes to `main` and pull requests.

## Publish To GitHub

This directory is already initialized as a Git repository on `main`. Create an empty repository named `inferenceos-playground` at https://github.com/new, then run:

```bash
git remote add origin https://github.com/YOUR_USERNAME/inferenceos-playground.git
git push -u origin main
```

Do not initialize the remote repository with another README, `.gitignore`, or license before the first push. The source ZIP contains the same committed files without local Git history.

## Repository Layout

```text
inferenceos-playground/
├── .github/workflows/ci.yml
├── docs/images/
├── e2e/
├── src/
│   ├── components/
│   └── simulation/
├── index.html
├── package.json
├── playwright.config.ts
├── tsconfig.json
└── vite.config.ts
```

## Architecture

- `src/simulation/engine.ts`: seeded fixed-step engine, request lifecycle, per-replica admission/scheduling, chunked prefill, decode and speculative verification.
- `src/simulation/cache.ts`: incremental physical page allocation, logical block tables, immutable prefix pages, reference counting and unpinned LRU eviction.
- `src/simulation/metrics.ts`: lifetime latency/counters and rolling output/completion rates.
- `src/simulation/types.ts`: request, worker, page, configuration and snapshot contracts.
- `src/simulation/scenarios.ts`: seven predefined workloads.
- `src/App.tsx`: simulation clock, traffic generation and operator actions.
- `src/components/`: React views of live engine state. Canvas charts are generated from simulation samples, not canned data.
- `src/simulation/engine.test.ts`, `e2e/`: invariant tests and real browser workflows.

The engine is independent of React and wall-clock time. `step()` advances 20 simulated milliseconds; seed 73 and identical action ordering produce identical results. There is one sequence per request, one KV pool per replica, and `GPU count / TP degree` independent replicas. TP ranks execute the same batch over conceptual model/KV shards.

## Features And Controls

- Enter prompt/output token counts and a prefix family; add one request or a randomized burst of 1-64.
- Stream traffic at 0.5-8 requests per simulated second. Burst/stream lengths vary by 0.5-1.5 times the input, bounded by engine limits.
- Pause, resume, single-step, reset, and select 0.25x-4x playback. Speed changes wall-clock playback, not metric units.
- Toggle continuous batching, prefix caching and speculation live.
- Change GPU count, TP degree, block size, block count and maximum batch size, then **Apply & restart**. Hardware changes explicitly discard the current run. Scenario selection also resets the run.
- Inspect requests from the queue, worker chips, or timeline. Cancel live requests. Click/hover physical pages to see owners, usage and reuse generation. A selected request follows its replica's cache.
- Runtime and Trace tabs show scheduler decisions, latency, throughput, occupancy, prefix reuse and speculative acceptance. Export a JSON trace through the download icon.
- On mobile, the sliders icon switches between the runtime and control plane.

## Simulation Assumptions

This is a teaching model inspired by vLLM, **not vLLM itself or a performance predictor**.

1. **Scheduling:** FCFS scan with feasible-request bypass and least-loaded replica placement; cache affinity breaks equal-load ties. Continuous mode admits into freed slots each iteration. Static mode waits until the replica's cohort drains. Existing requests are not preempted.
2. **Memory:** admission conservatively reserves capacity for the entire declared prompt + output. Physical blocks are allocated incrementally. The invariant is pinned pages + unallocated reserved pages <= pool capacity. Oversized requests are rejected, queued requests wait, and unreferenced prefix pages are reclaimed as needed. Reservations are accounting, not allocated pages.
3. **Prefix identity:** `chat`, `code` and `docs` represent identical prefix token content per family. Prefix length is at most 128 tokens and at most half the prompt, rounded down to whole blocks. Only full immutable prefix pages are shared; mutable tails are never shared. Cache locality is replica-local; LRU eviction may leave unreachable cached suffix pages until reclaimed.
4. **Timing:** prefill processes `floor(32 * TP_efficiency / sqrt(batch_size))` tokens per sequence per tick. `TP_efficiency = TP / (1 + .18*(TP-1))`. Decode costs `(36 + prompt_tokens/128 + 2*batch_size) / sqrt(TP_efficiency)` ms per sequence, quantized to ticks. These are illustrative costs, not measured hardware timings.
5. **Speculation:** draft up to four tokens, independently accept the next token with probability .76 until the first rejection, discard the remaining suffix, then emit a correction (or a bonus if all accepted). Cost is 1.65 times ordinary decode. Output is capped exactly at the requested length. Draft-model memory and extra verification KV are not modeled.
6. **GPU utilization:** synthetic instantaneous occupancy from phase and batch fill, not CUDA telemetry. TP communication overhead affects simulated speed; ring animation indicates group activity, not individual network packets. Increasing TP reduces replica count and does not automatically increase the configured per-replica token capacity.
7. **Clock:** fixed-step playback intentionally slows when a browser tab is throttled; it does not catch up with real time.

## Metrics

| Metric | Definition |
| --- | --- |
| TTFT | Lifetime mean arrival-to-first-emitted-token time, including queue time |
| TPOT | Sum of post-first-token elapsed time divided by post-first-token count; tokens emitted in one speculative burst have zero internal spacing |
| tokens/sec | Output tokens emitted in the trailing one simulated second; startup uses elapsed time |
| requests/sec | Completions in the same rolling window |
| KV utilization | Pinned plus retained cached physical pages / all physical pages |
| Prefix hit rate | Prefix-eligible admissions reusing at least one page / eligible lookups with caching enabled |
| GPU utilization | Mean synthetic occupancy across GPU workers |
| Active / waiting | Current prefill + decode / queued requests |

Counters survive display-history pruning. TTFT includes a subsequently cancelled request if it already produced a first token. Completed, rejected and cancelled counters are separate.

## Two-Minute Demo

1. **0:00-0:20:** Start on Continuous batching. Watch arrivals turn blue during prefill, then green during decode. Select a request and inspect its non-contiguous logical-to-physical mapping.
2. **0:20-0:40:** Select Static batching. At 4x speed, observe idle slots while a long sequence holds its cohort. Toggle continuous batching on and watch queued requests fill those slots.
3. **0:40-1:00:** Select Prefix-heavy workload. After the initial cold prefill, watch shared purple pages, prefix-hit events and later requests' lower TTFT.
4. **1:00-1:20:** Select KV-cache pressure. Inspect waiting reasons, retained pages, eviction counters and page reuse generations. Add a burst.
5. **1:20-1:40:** Select Tensor-parallel workload. All four ranks show identical request IDs; inspect the all-reduce ring. Changing TP to 2 and applying produces two replicas.
6. **1:40-2:00:** Select Speculative decoding. Select a decoding request, pause, and single-step through draft acceptance/rejection. Open Trace, filter verification events, then export JSON.

## Limitations

- No neural inference, tokenizer, actual token text, CUDA kernels, model weights, real attention math, or hardware benchmarking.
- No CPU swapping, recompute preemption, distributed transport, beam search, chunk token-budget scheduling, or persistent sessions.
- One shared browser-thread engine is sufficient for the bounded MVP workload, not a production load generator.
- Queue cap 256; automatic traffic backs off at 128 waiting. Requests: 1-8192 prompt / 1-1024 output tokens; blocks: 16-512 per replica.
- Display history retains 160 terminal requests, 100 scheduler events and 180 chart samples. Export includes those recent records plus lifetime counters, not an exhaustive replay log.
- Tested in Chromium; other browser engines have not been certified.
