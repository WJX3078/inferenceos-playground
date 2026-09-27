# Experiments: scenarios, CLI, sweeps, replay

InferenceOS Lab is an experiment platform, not just a visualization. Three ways to run experiments, all sharing the same deterministic engine and schema.

## 1. In the browser

Pick a scenario (grouped by theme), press Run, and change one knob at a time. The **Compare** tab captures the current run (A, B, C...) and tables 20 metrics side by side — latency percentiles, throughput vs goodput, SLO attainment, KV/evictions/preemptions, budget utilization, transfers. Latency rows highlight the best (lowest) value. Capture discipline: **change exactly one setting between captures**, same seed, same scenario.

- *Export scenario* — download the current configuration as a versioned v1 JSON.
- *Import scenario* — load one back (deterministically).
- *Export run* — dump config + summary metrics + per-request observations + recent events + transfer log.

## 2. Scenario JSON (version 1)

```json
{
  "version": 1,
  "name": "token-budget sweep (illustrative)",
  "seed": 73,
  "config": { "gpuCount": 2, "numBlocks": 128, "maxBatchSize": 8, "schedulerPolicy": "fcfs" },
  "traffic": {
    "enabled": true, "arrival": "poisson", "rate": 3,
    "prompt": { "kind": "uniform", "min": 128, "max": 512 },
    "output": { "kind": "uniform", "min": 32, "max": 96 },
    "prefix": "chat", "prefixReuseProbability": 0.8,
    "priorityMix": { "low": 0, "normal": 1, "high": 0 }
  },
  "maxSimMs": 20000,
  "sweep": [{ "path": "config.maxNumBatchedTokens", "values": [32, 64, 128] }],
  "notes": "Same workload, three token budgets. All numbers are simulator outputs, not hardware benchmarks."
}
```

Field reference:

- `version` — schema version, currently `1`; the runner rejects anything else.
- `seed` — the entire run's RNG seed (default 73).
- `config` — any subset of the engine config; normalized and validated on load.
- `traffic` — the workload: `arrival` = `constant | poisson | burst | trace`; `rate` (req/s); burst `burstSize`/`burstEveryMs`; `prompt`/`output` distributions (`fixed` | `uniform` | `discrete` with weights); `prefix` family + `prefixReuseProbability`; `priorityMix` weights; optional per-request `sloTTFTms/sloTPOTms`. For **trace replay**, `requests: [{ atMs, input }]` schedules exact requests at exact times.
- `maxSimMs` — simulation cap (streaming workloads run to the cap; trace workloads end when the last arrival drains).
- `sweep` — list of `{ path, values }` (paths like `config.maxNumBatchedTokens`, `traffic.rate`, `config.prefillGpuCount`, `seed`); the runner executes the **cartesian product**.
- `notes` — free text; keep the honest-labeling habit.

## 3. Headless CLI (no browser)

```bash
node scripts/experiment.ts scenarios/example-budget-sweep.json                 # table + JSON to stdout
node scripts/experiment.ts my-scenario.json --out results.json                 # write JSON
node scripts/experiment.ts my-scenario.json --include-observations             # include per-request rows
```

The runner prints a human-readable summary per result (TTFT/TPOT/E2E percentiles, throughput/goodput/SLO, KV, budget, transfers, tiers) and writes the structured `RunResult` (config, summary metrics, counters). Requires only Node ≥ 23 (native TypeScript stripping) — no browser, no GPU.

## Reproducibility contract

Same **engine version + seed + config + workload** ⇒ identical results. The suite asserts this two ways: engine-level replay tests (identical requests, metrics, and summaries) and scenario-level replay (`replayIdentical`). If you change the engine's behavior, bump expectations in tests and note it — old exported runs are only comparable within the same engine version (`RunResult.engineVersion`).

## Built-in scenario catalog (29)

| Group | Scenario | Learn |
| --- | --- | --- |
| Batching | continuous-batching | freed slots refill every iteration |
| Batching | static-batching | cohorts drain whole; idle slots visible |
| Batching | chunked-prefill | long prompts spread across iterations; decodes keep budget |
| Batching | long-prefill-interference | unchunked prefill starves decodes; fix with chunking/decode priority |
| Load shape | decode-heavy / prefill-heavy / short-chat / long-context | workload shape moves the tail |
| Load shape | burst-overload | queue spikes vs steady-state averages |
| KV & memory | prefix-heavy | content-hash prefix reuse lowers warm TTFT |
| KV & memory | kv-pressure | reservation queueing, LRU eviction, reuse generations |
| KV & memory | kv-thrashing | watermark 0 vs 0.1: evictions/preemptions/p99 |
| Scheduling | priority-inversion | priority + recompute preemption and its bill |
| Scheduling | cost-aware-preemption | cheapest-victim selection and the recompute bill |
| Scheduling | priority-preemption-storm | cooldown + residency suppress preemption storms |
| Scheduling | decode-preemption-expensive | preempting deep decode costs a large recompute |
| Scheduling | slo-overload | throughput ↑ while goodput ↓ |
| Scheduling | starvation-aging | aging rescues an SJF-starved long request |
| Scheduling | starvation-test | low-priority starvation under priority scheduling |
| Topology | tensor-parallel | TP ranks share a batch, KV sharded per rank |
| Topology | disaggregated-balanced / disaggregated-prefill-bottleneck / disaggregated-decode-bottleneck | P/D ratio moves the queue |
| Topology | network-bottleneck | transfer bandwidth dominates TTFT |
| Topology | network-contention | concurrent transfers share the pipe |
| Topology | priority-transfer | priority-aware transfer queue jumping |
| Topology | decode-bottleneck-backpressure | prefill admission pauses under decode saturation |
| Optimization | speculative-low-acceptance / speculative-high-acceptance | spec decode can be a net loss |

Each scenario's "what to observe" text is shown in the app banner and in `src/simulation/scenarios.ts`.

## Real workload traces (JSONL/JSON)

Replay the *shape* of a real serving workload — never a calibration claim. One request per line (JSONL) or a JSON array:

```json
{"timestamp_ms": 1234, "prompt_tokens": 1024, "output_tokens": 128, "priority": 1, "prefix_group": "chat",
 "observed_ttft_ms": 92, "observed_tpot_ms": 13.7, "observed_e2e_ms": 1830}
```

- Required: `timestamp_ms` (≥ 0), `prompt_tokens`, `output_tokens` (positive integers). Optional: `priority` (`0|1|2` or `low|normal|high`), `prefix_group`.
- Optional `observed_*` fields are carried through to per-request observations and displayed **side-by-side with simulated values, reference only**. The simulator computes a *difference*, never a "prediction error", and performs no calibration.
- Validation collects every problem with line numbers: `Invalid trace: line 3: output_tokens must be a positive integer`.
- Import in the UI (Import → a `.jsonl` file) or the CLI: `npm run experiment -- --trace requests.jsonl --config base-scenario.json`.
- Source adapters live in `src/simulation/trace-adapters/`: a working OpenAI-compatible request-log adapter, and a **documented mini-vllm adapter interface** whose field map is intentionally unfilled — schemas are not invented here.

## Multi-seed experiments and paired comparison

Single-seed runs are for byte-identical reproducibility. Multi-seed runs quantify sensitivity to the stochastic workload stream:

```bash
npm run experiment -- scenarios/my.json --seeds 1,2,3,4,5
```

or `"seeds": [1,2,3,4,5]` in the scenario file. Output: per-seed results plus mean/median/min/max/stddev (population) for TTFT/TPOT p50+p99, E2E p99, throughput, goodput, SLO attainment, preemptions, recomputed tokens and evictions. Comparisons are **paired**: every variant runs the same seed list, so per-seed deltas are meaningful (`runPairedComparison`). No error bars are drawn — the aggregate table states its own statistics.

## Result fingerprints

Every `RunResult` carries a fingerprint: `engineVersion`, `scenarioSchemaVersion`, `seed`, `configHash`, `workloadHash`, `resultHash` (stable FNV-1a over key-sorted JSON), plus `gitCommit` when produced by the CLI inside a git checkout. Same inputs ⇒ same fingerprint; the CLI prints it and the replay tests assert it.

## Runtime schema validation

`runScenario` validates before running and throws `Invalid scenario:` with precise, named problems — unknown config keys, out-of-range values, bad enums (`schedulerPolicy: "random"`), negative rates, malformed sweep paths, malformed trace requests. No silent fallbacks; `npm run experiment` fails loudly instead of running the wrong experiment.
