// Predefined teaching scenarios. Every scenario exists to make one specific
// LLM-serving trade-off observable; `learn` states what to look at.

import { SimulationEngine } from './engine.ts';
import type { ArrivalMode, Config, Priority, RequestInput } from './types.ts';
import type { TrafficSpec, TraceRequest } from './workload.ts';

export interface Scenario {
  id: string;
  name: string;
  group: string;
  learn: string;
  config: Partial<Config>;
  input: RequestInput;
  count: number;                       // seed burst size (0 = scripted only)
  rate: number;                        // streaming arrival rate (req/s)
  arrival?: ArrivalMode;
  priorityMix?: { low: number; normal: number; high: number };
  traffic?: Partial<TrafficSpec>;
  requests?: TraceRequest[];           // scripted trace (replaces streaming)
}

const mixAll = (low: number, normal: number, high: number) => ({ low, normal, high });

export const SCENARIOS: Scenario[] = [
  {
    id: 'continuous-batching', name: 'Continuous batching', group: 'Batching',
    learn: 'Watch arrivals turn blue during prefill and green during decode; new requests fill freed batch slots every iteration instead of waiting for a whole cohort to drain.',
    config: {}, input: { promptTokens: 256, outputTokens: 64, prefix: 'chat' }, count: 10, rate: 2,
  },
  {
    id: 'static-batching', name: 'Static batching', group: 'Batching',
    learn: 'With continuous batching off, a replica runs one fixed cohort to completion. Watch idle slots while a long sequence holds the cohort, then compare with the continuous scenario.',
    config: { continuousBatching: false, gpuCount: 1 }, input: { promptTokens: 128, outputTokens: 48, prefix: 'none' }, count: 10, rate: 1,
  },
  {
    id: 'chunked-prefill', name: 'Chunked prefill', group: 'Batching',
    learn: 'Long prompts are split into 64-token chunks across iterations. Watch chunk events in the trace, prefill spanning many iterations, and decodes staying smooth because each chunk leaves token budget for them.',
    config: { prefillChunkSize: 64, gpuCount: 1, numBlocks: 256, maxBatchSize: 8 },
    input: { promptTokens: 1024, outputTokens: 32, prefix: 'docs' }, count: 6, rate: 1,
  },
  {
    id: 'long-prefill-interference', name: 'Long-prefill interference', group: 'Batching',
    learn: 'Decode priority is OFF and chunking is OFF: a 2048-token prefill monopolizes the 32-token budget each iteration and decoding sequences stall (TPOT spikes). Now compare: enable chunked prefill or decode priority and watch TPOT p99 recover.',
    config: { gpuCount: 1, numBlocks: 256, maxBatchSize: 8, maxNumBatchedTokens: 32, prefillChunkSize: 0, decodePriority: false },
    input: { promptTokens: 2048, outputTokens: 48, prefix: 'none' }, count: 8, rate: 1,
  },
  {
    id: 'decode-heavy', name: 'Decode-heavy workload', group: 'Load shape',
    learn: 'Short prompts, long outputs: the batch fills with decoding sequences. Watch TPOT degrade as the batch grows and throughput become decode-bound.',
    config: { gpuCount: 2, maxBatchSize: 8, numBlocks: 256 }, input: { promptTokens: 128, outputTokens: 256, prefix: 'none' }, count: 8, rate: 2,
  },
  {
    id: 'prefill-heavy', name: 'Prefill-heavy workload', group: 'Load shape',
    learn: 'Long prompts, short outputs: prefill dominates. Watch TTFT p99 grow under queueing and the token budget be consumed by prefill chunks.',
    config: { gpuCount: 2, maxBatchSize: 8, numBlocks: 256 }, input: { promptTokens: 2048, outputTokens: 16, prefix: 'none' }, count: 8, rate: 2,
  },
  {
    id: 'short-chat', name: 'Short-chat workload', group: 'Load shape',
    learn: 'Small requests at a high rate: the healthy baseline. Compare its TTFT/TPOT percentiles against prefill-heavy and decode-heavy to see how workload shape moves the tail.',
    config: { gpuCount: 1 }, input: { promptTokens: 64, outputTokens: 16, prefix: 'chat' }, count: 12, rate: 4,
  },
  {
    id: 'long-context', name: 'Long-context requests', group: 'Load shape',
    learn: '2048-token prompts: prefill takes dozens of iterations and KV reservation dominates. Watch how few requests fit concurrently and how TTFT scales with prompt length.',
    config: { numBlocks: 256, blockSize: 32 }, input: { promptTokens: 2048, outputTokens: 64, prefix: 'docs' }, count: 6, rate: 0.5,
  },
  {
    id: 'prefix-heavy', name: 'Prefix-heavy workload', group: 'KV & memory',
    learn: 'All requests share one system prompt. After the cold prefill, purple shared blocks appear, prefix-hit events fire, and warm requests skip most prefill work (lower TTFT).',
    config: { gpuCount: 1, numBlocks: 256 }, input: { promptTokens: 256, outputTokens: 24, prefix: 'chat' }, count: 8, rate: 3,
  },
  {
    id: 'kv-pressure', name: 'KV-cache pressure', group: 'KV & memory',
    learn: 'A 32-block pool with conservative reservations: requests queue on KV pressure, retained prefix pages get evicted LRU, and page reuse generations climb. Inspect waiting reasons.',
    config: { gpuCount: 1, numBlocks: 32, maxBatchSize: 8 }, input: { promptTokens: 256, outputTokens: 96, prefix: 'docs' }, count: 12, rate: 1,
  },
  {
    id: 'kv-thrashing', name: 'KV thrashing vs watermark', group: 'KV & memory',
    learn: 'Zero watermark lets admissions fill the pool until cached prefix pages thrash through LRU. Capture a run, raise KV watermark to 0.1 and compare evictions, preemptions and tail latency.',
    config: { gpuCount: 1, numBlocks: 48, maxBatchSize: 4, kvWatermark: 0 },
    input: { promptTokens: 384, outputTokens: 128, prefix: 'docs' }, count: 10, rate: 2,
  },
  {
    id: 'priority-inversion', name: 'Priority + preemption', group: 'Scheduling',
    learn: 'Six long low-priority requests occupy the replica; a high-priority request arrives and preempts (recompute mode): watch the preempt/resume events, freed KV, and the recomputation cost paid on resume.',
    config: {
      gpuCount: 1, maxBatchSize: 2, numBlocks: 96, schedulerPolicy: 'priority', preemptionMode: 'cost-aware',
    },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'none' }, count: 0, rate: 0,
    requests: [
      { atMs: 0, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 40, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 80, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 120, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 160, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 200, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 3000, input: { promptTokens: 256, outputTokens: 32, prefix: 'none', priority: 'high' } },
    ],
  },
  {
    id: 'slo-overload', name: 'SLO overload', group: 'Scheduling',
    learn: 'Arrival rate exceeds capacity with a 400ms TTFT / 50ms TPOT SLO. Throughput keeps rising while goodput and SLO attainment collapse — higher throughput is not better serving.',
    config: { schedulerPolicy: 'slo', sloTTFTms: 400, sloTPOTms: 50, maxBatchSize: 8 },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'chat' }, count: 12, rate: 3,
  },
  {
    id: 'starvation-test', name: 'Starvation test', group: 'Scheduling',
    learn: 'Priority scheduler under mixed traffic: low-priority requests wait while normal/high keep cutting in line. Watch per-request queue latency in the inspector and observations export.',
    config: { gpuCount: 1, schedulerPolicy: 'priority', maxBatchSize: 2, numBlocks: 128 },
    input: { promptTokens: 256, outputTokens: 32, prefix: 'none' }, count: 4, rate: 3,
    priorityMix: mixAll(3, 1, 1),
  },
  {
    id: 'tensor-parallel', name: 'Tensor-parallel workload', group: 'Topology',
    learn: 'TP=4: every rank shows the same request IDs (one logical replica over model/KV shards), the all-reduce ring animates, and the pool is sharded four ways.',
    config: { gpuCount: 4, tensorParallel: 4, numBlocks: 256 }, input: { promptTokens: 1024, outputTokens: 96, prefix: 'code' }, count: 8, rate: 1,
  },
  {
    id: 'speculative-low-acceptance', name: 'Speculative: low acceptance', group: 'Optimization',
    learn: 'Draft 8 tokens at 25% acceptance with a 2.0x step cost: drafted tokens mostly get discarded and decode gets SLOWER than plain decoding. Speculation is not free throughput.',
    config: { gpuCount: 1, speculativeDecoding: true, specAcceptance: 'low', specDraftLength: 8, specCost: 2 },
    input: { promptTokens: 128, outputTokens: 128, prefix: 'code' }, count: 6, rate: 1,
  },
  {
    id: 'speculative-high-acceptance', name: 'Speculative: high acceptance', group: 'Optimization',
    learn: 'Same draft length at 92% acceptance and 1.65x cost: most drafts commit and effective tokens/sec rises. Compare with the low-acceptance scenario and with speculation off.',
    config: { gpuCount: 1, speculativeDecoding: true, specAcceptance: 'high', specDraftLength: 8, specCost: 1.65 },
    input: { promptTokens: 128, outputTokens: 128, prefix: 'code' }, count: 6, rate: 1,
  },
  {
    id: 'disaggregated-balanced', name: 'Disaggregated 4P+4D', group: 'Topology',
    learn: 'Prefill and decode run on separate pools; watch KV transfer events between them, TTFT now including transfer latency, and both pool utilizations side by side.',
    config: { servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 4, decodeGpuCount: 4, numBlocks: 128, maxBatchSize: 8 },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'chat' }, count: 8, rate: 2,
  },
  {
    id: 'disaggregated-prefill-bottleneck', name: 'Disaggregated 2P+6D', group: 'Topology',
    learn: 'Only 2 prefill GPUs but 6 decode GPUs: the prefill pool queues and TTFT p99 blows up while decode GPUs idle. P/D ratio mismatch creates a bottleneck the aggregate GPU count hides.',
    config: { servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 2, decodeGpuCount: 6, numBlocks: 128, maxBatchSize: 8 },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'chat' }, count: 8, rate: 3,
  },
  {
    id: 'disaggregated-decode-bottleneck', name: 'Disaggregated 6P+2D', group: 'Topology',
    learn: 'The mirror image: 6 prefill GPUs feed only 2 decode GPUs. Prefill finishes fast but decode admission queues; TPOT and E2E p99 degrade while prefill utilization is low.',
    config: { servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 6, decodeGpuCount: 2, numBlocks: 128, maxBatchSize: 8 },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'chat' }, count: 8, rate: 3,
  },
  {
    id: 'network-bottleneck', name: 'Network bottleneck (P/D)', group: 'Topology',
    learn: 'KV transfer bandwidth cut to 4 GB/s with 0.5ms latency: transfers queue (watch active/queued transfers), TTFT p99 is dominated by transfer time, and prefill KV occupation backs up.',
    config: {
      servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 4, decodeGpuCount: 4,
      kvTransferBandwidthGBps: 4, kvTransferLatencyUs: 500, maxConcurrentTransfers: 2, numBlocks: 128, maxBatchSize: 8,
    },
    input: { promptTokens: 1024, outputTokens: 64, prefix: 'chat' }, count: 8, rate: 3,
  },
  {
    id: 'burst-overload', name: 'Burst overload', group: 'Load shape',
    learn: 'Eight requests arrive every 3 seconds: queues spike, KV and batch capacity saturate, and tail latencies (p99) explode much faster than means. Steady-state averages hide bursts.',
    config: { gpuCount: 2, maxBatchSize: 8 },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'none' }, count: 4, rate: 2,
    arrival: 'burst', traffic: { burstSize: 8, burstEveryMs: 3000 },
  },
  {
    id: 'cost-aware-preemption', name: 'Cost-aware preemption', group: 'Scheduling',
    learn: 'A high-priority arrival evicts the CHEAPEST victim: watch the preempt events pick young/small requests over heavily-decoded ones, and compare the recomputed-token bill with the priority-inversion scenario.',
    config: {
      gpuCount: 1, maxBatchSize: 1, numBlocks: 256, schedulerPolicy: 'priority', preemptionMode: 'cost-aware',
      preemptionCooldownMs: 0,
    },
    input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' }, count: 0, rate: 0,
    requests: [
      { atMs: 0, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 40, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 80, input: { promptTokens: 512, outputTokens: 64, prefix: 'none', priority: 'low' } },
      { atMs: 2500, input: { promptTokens: 128, outputTokens: 16, prefix: 'none', priority: 'high' } },
    ],
  },
  {
    id: 'priority-preemption-storm', name: 'Preemption storm guard', group: 'Scheduling',
    learn: 'A stream of high-priority arrivals would evict a running request every iteration without guards. Watch the cooldown + minimum residency suppress the storm (few preemptions) while keeping highs served.',
    config: {
      gpuCount: 1, maxBatchSize: 1, numBlocks: 512, schedulerPolicy: 'priority', preemptionMode: 'cost-aware',
      preemptionCooldownMs: 1000,
    },
    input: { promptTokens: 256, outputTokens: 128, prefix: 'none', priority: 'normal' }, count: 0, rate: 0,
    requests: [
      { atMs: 0, input: { promptTokens: 256, outputTokens: 256, prefix: 'none', priority: 'low' } },
      { atMs: 500, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
      { atMs: 1000, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
      { atMs: 1500, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
      { atMs: 2000, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
      { atMs: 2500, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
    ],
  },
  {
    id: 'decode-preemption-expensive', name: 'Decode preemption is expensive', group: 'Scheduling',
    learn: 'With cost-aware preemption, preempting a request that has decoded hundreds of tokens costs a huge recompute bill. Watch recomputedTokens and compare with preempting a fresh prefill.',
    config: {
      gpuCount: 1, maxBatchSize: 1, numBlocks: 256, schedulerPolicy: 'priority', preemptionMode: 'cost-aware',
      preemptionCooldownMs: 0,
    },
    input: { promptTokens: 128, outputTokens: 320, prefix: 'none', priority: 'low' }, count: 0, rate: 0,
    requests: [
      { atMs: 0, input: { promptTokens: 128, outputTokens: 320, prefix: 'none', priority: 'low' } },
      { atMs: 6000, input: { promptTokens: 64, outputTokens: 8, prefix: 'none', priority: 'high' } },
    ],
  },
  {
    id: 'network-contention', name: 'Network contention (P/D)', group: 'Topology',
    learn: 'Several KV transfers share one pipe. Compare transferSchedulingPolicy: fair-share splits bandwidth, fifo serves strictly in queue order. Watch transfer wait p99 and how the prefill pool backs up.',
    config: {
      servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 4, decodeGpuCount: 4,
      numBlocks: 256, kvTransferBandwidthGBps: 8, maxConcurrentTransfers: 4,
      transferSchedulingPolicy: 'fair-share',
    },
    input: { promptTokens: 2048, outputTokens: 32, prefix: 'chat' }, count: 8, rate: 2,
  },
  {
    id: 'priority-transfer', name: 'Priority-aware KV transfer', group: 'Topology',
    learn: 'Same contention, priority-aware scheduling: high-priority KV transfers jump the transfer queue. Capture both this and network-contention in Compare and watch TTFT p99 move.',
    config: {
      servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 4, decodeGpuCount: 4,
      numBlocks: 256, kvTransferBandwidthGBps: 8, maxConcurrentTransfers: 4,
      transferSchedulingPolicy: 'priority',
    },
    input: { promptTokens: 2048, outputTokens: 32, prefix: 'chat' }, count: 8, rate: 2,
    priorityMix: mixAll(1, 1, 1),
  },
  {
    id: 'decode-bottleneck-backpressure', name: 'Decode backpressure (P/D)', group: 'Topology',
    learn: 'With backpressure on (maxPendingDecodeRequests), prefill admission PAUSES when the decode pipeline is full instead of piling un-transferable KV. Set the limit to 0 in the controls and compare queue growth.',
    config: {
      servingMode: 'disaggregated', gpuCount: 8, prefillGpuCount: 6, decodeGpuCount: 2,
      numBlocks: 256, maxBatchSize: 8, maxPendingDecodeRequests: 6, kvTransferBandwidthGBps: 16,
    },
    input: { promptTokens: 256, outputTokens: 128, prefix: 'chat' }, count: 10, rate: 3,
  },
  {
    id: 'starvation-aging', name: 'Starvation aging', group: 'Scheduling',
    learn: 'SJF under a flood of short requests: a long request waits until the starvation threshold (2s here) promotes it. Watch the starvation event in the trace and its eventual admission.',
    config: {
      gpuCount: 1, maxBatchSize: 2, schedulerPolicy: 'sjf', numBlocks: 256, starvationThresholdMs: 2000,
    },
    input: { promptTokens: 64, outputTokens: 8, prefix: 'none' }, count: 2, rate: 4,
    requests: [
      { atMs: 0, input: { promptTokens: 2048, outputTokens: 128, prefix: 'none' } },
    ],
  },
];

/** Legacy scenario ids from the playground MVP, mapped onto the new catalog. */
export const SCENARIO_ALIASES: Record<string, string> = {
  continuous: 'continuous-batching',
  static: 'static-batching',
  prefix: 'prefix-heavy',
  pressure: 'kv-pressure',
  long: 'long-context',
  tensor: 'tensor-parallel',
  speculative: 'speculative-high-acceptance',
};

export function resolveScenarioId(id: string): string {
  return SCENARIO_ALIASES[id] ?? id;
}

export function createScenario(id: string): SimulationEngine {
  const s = SCENARIOS.find(x => x.id === resolveScenarioId(id)) ?? SCENARIOS[0];
  const engine = new SimulationEngine(s.config);
  if (s.requests?.length) {
    engine.setTraffic({
      enabled: true,
      arrival: 'trace',
      requests: s.requests,
      prompt: { kind: 'fixed', value: s.input.promptTokens },
      output: { kind: 'fixed', value: s.input.outputTokens },
      prefix: s.input.prefix,
    });
  } else {
    if (s.count) engine.burst(s.count, s.input);
    engine.setTraffic({
      enabled: true,
      arrival: s.arrival ?? 'constant',
      rate: s.rate,
      prompt: { kind: 'fixed', value: s.input.promptTokens },
      output: { kind: 'fixed', value: s.input.outputTokens },
      prefix: s.input.prefix,
      prefixReuseProbability: 1,
      priorityMix: s.priorityMix ?? mixAll(0, 1, 0),
      ...(s.traffic ?? {}),
    });
  }
  return engine;
}

/** The priority class of a scripted request, for tests. */
export const scenarioPriorities = (s: Scenario): Priority[] =>
  (s.requests ?? []).map(r => r.input.priority ?? 'normal');
