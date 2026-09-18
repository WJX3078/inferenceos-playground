import { SimulationEngine } from './engine';
import type { Config, RequestInput } from './types';

export interface Scenario {
  id: string; name: string; config: Partial<Config>; input: RequestInput; count: number; rate: number;
  lesson?: string;
}
export const SCENARIOS: Scenario[] = [
  { id: 'continuous', name: 'Continuous batching', config: {}, input: { promptTokens: 256, outputTokens: 64, prefix: 'chat' }, count: 10, rate: 2 },
  { id: 'static', name: 'Static batching', config: { continuousBatching: false, gpuCount: 1 }, input: { promptTokens: 128, outputTokens: 48, prefix: 'none' }, count: 10, rate: 1 },
  { id: 'prefix', name: 'Prefix-heavy workload', config: { gpuCount: 1, numBlocks: 256 }, input: { promptTokens: 256, outputTokens: 24, prefix: 'chat' }, count: 8, rate: 3 },
  { id: 'pressure', name: 'KV-cache pressure', config: { gpuCount: 1, numBlocks: 32, maxBatchSize: 8 }, input: { promptTokens: 256, outputTokens: 96, prefix: 'docs' }, count: 12, rate: 1 },
  { id: 'long', name: 'Long-context requests', config: { numBlocks: 256, blockSize: 32 }, input: { promptTokens: 2048, outputTokens: 64, prefix: 'docs' }, count: 6, rate: 0.5 },
  { id: 'tensor', name: 'Tensor-parallel workload', config: { gpuCount: 4, tensorParallel: 4, numBlocks: 256 }, input: { promptTokens: 1024, outputTokens: 96, prefix: 'code' }, count: 8, rate: 1 },
  { id: 'speculative', name: 'Speculative decoding', config: { speculativeDecoding: true, gpuCount: 1 }, input: { promptTokens: 128, outputTokens: 128, prefix: 'code' }, count: 6, rate: 1 },
  { id: 'chunked', name: 'Chunked Prefill', config: { gpuCount: 1, numBlocks: 512, maxPrefillTokensPerStep: 512 }, input: { promptTokens: 4096, outputTokens: 32, prefix: 'none' }, count: 3, rate: 0.5, lesson: 'A short sequence decodes while the long prompt consumes successive 512-token chunks. Inspect the mixed iteration budget.' },
  { id: 'decode-heavy', name: 'Decode-heavy workload', config: { gpuCount: 1, numBlocks: 256 }, input: { promptTokens: 32, outputTokens: 256, prefix: 'none' }, count: 8, rate: 1, lesson: 'Short prefills leave a long decoding tail. Compare speculative verification cost against accepted output.' },
  { id: 'priority', name: 'Priority workload', config: { gpuCount: 1, schedulerPolicy: 'priority', maxNumSeqs: 2 }, input: { promptTokens: 64, outputTokens: 40, prefix: 'none' }, count: 8, rate: 1, lesson: 'HIGH requests enter first. Queued requests gain one effective priority level every two seconds.' },
  { id: 'preemption', name: 'Preemption pressure', config: { gpuCount: 1, maxNumSeqs: 1, numBlocks: 32, schedulerPolicy: 'priority', preemption: true, prefixCaching: false }, input: { promptTokens: 128, outputTokens: 96, prefix: 'none', priority: 'LOW' }, count: 3, rate: 0.5, lesson: 'A HIGH request arrives at 400 ms, preempts the LOW sequence, then lets it rebuild prompt plus generated context.' },
  { id: 'shared-system', name: 'Shared system prompt', config: { gpuCount: 1, numBlocks: 256, maxNumSeqs: 2 }, input: { promptTokens: 512, outputTokens: 32, prefix: 'chat' }, count: 8, rate: 1, lesson: 'Later requests reuse identical token blocks from the system prompt; a changed user suffix breaks the chain.' },
  { id: 'mixed-context', name: 'Mixed context workload', config: { numBlocks: 512, maxPrefillTokensPerStep: 256 }, input: { promptTokens: 512, outputTokens: 48, prefix: 'docs' }, count: 8, rate: 1, lesson: 'Long and short contexts compete for reserved KV. Observe admission delay separately from prefill service.' },
  { id: 'tp-bottleneck', name: 'TP communication bottleneck', config: { gpuCount: 8, tensorParallel: 8, numBlocks: 256, interconnect: 'custom', bandwidthGBps: 16, latencyUs: 100 }, input: { promptTokens: 64, outputTokens: 48, prefix: 'none' }, count: 8, rate: 1, lesson: 'Small compute batches expose collective latency. Use TP scaling to find where additional ranks stop helping.' },
  { id: 'compare', name: 'Compare strategies', config: {}, input: { promptTokens: 256, outputTokens: 64, prefix: 'chat' }, count: 10, rate: 1, lesson: 'Freeze a trace once, then compare static, continuous, cached and speculative execution.' },
];
export function createScenario(id: string, config?: Partial<Config>, input?: RequestInput) {
  const preset = SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
  const scenario = { ...preset, input: input ?? preset.input };
  const engine = new SimulationEngine({ ...scenario.config, ...config });
  if (id === 'chunked') {
    engine.enqueue({ promptTokens: 16, outputTokens: 32, prefix: 'none' });
    engine.enqueue(scenario.input);
    engine.schedule({ ...scenario.input, promptTokens: 2048 }, 60);
  } else if (id === 'preemption') {
    engine.enqueue(scenario.input);
    engine.schedule({ ...scenario.input, priority: 'HIGH', outputTokens: 2 }, 400);
    engine.schedule({ ...scenario.input, priority: 'NORMAL', outputTokens: 3 }, 800);
  } else if (id === 'priority') {
    for (let i = 0; i < scenario.count; i++) engine.enqueue({ ...scenario.input, priority: i % 3 === 0 ? 'HIGH' : i % 2 ? 'LOW' : 'NORMAL' });
  } else if (id === 'mixed-context') {
    for (let i = 0; i < scenario.count; i++) engine.enqueue({ ...scenario.input, promptTokens: i % 3 ? 128 : 3072 });
  } else if (id === 'shared-system') {
    for (let i = 0; i < scenario.count; i++) engine.enqueue(scenario.input);
  } else
  engine.burst(scenario.count, scenario.input);
  return engine;
}
