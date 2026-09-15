import { SimulationEngine } from './engine';
import type { Config, RequestInput } from './types';

export interface Scenario {
  id: string; name: string; config: Partial<Config>; input: RequestInput; count: number; rate: number;
}
export const SCENARIOS: Scenario[] = [
  { id: 'continuous', name: 'Continuous batching', config: {}, input: { promptTokens: 256, outputTokens: 64, prefix: 'chat' }, count: 10, rate: 2 },
  { id: 'static', name: 'Static batching', config: { continuousBatching: false, gpuCount: 1 }, input: { promptTokens: 128, outputTokens: 48, prefix: 'none' }, count: 10, rate: 1 },
  { id: 'prefix', name: 'Prefix-heavy workload', config: { gpuCount: 1, numBlocks: 256 }, input: { promptTokens: 256, outputTokens: 24, prefix: 'chat' }, count: 8, rate: 3 },
  { id: 'pressure', name: 'KV-cache pressure', config: { gpuCount: 1, numBlocks: 32, maxBatchSize: 8 }, input: { promptTokens: 256, outputTokens: 96, prefix: 'docs' }, count: 12, rate: 1 },
  { id: 'long', name: 'Long-context requests', config: { numBlocks: 256, blockSize: 32 }, input: { promptTokens: 2048, outputTokens: 64, prefix: 'docs' }, count: 6, rate: 0.5 },
  { id: 'tensor', name: 'Tensor-parallel workload', config: { gpuCount: 4, tensorParallel: 4, numBlocks: 256 }, input: { promptTokens: 1024, outputTokens: 96, prefix: 'code' }, count: 8, rate: 1 },
  { id: 'speculative', name: 'Speculative decoding', config: { speculativeDecoding: true, gpuCount: 1 }, input: { promptTokens: 128, outputTokens: 128, prefix: 'code' }, count: 6, rate: 1 },
];
export function createScenario(id: string) {
  const scenario = SCENARIOS.find(s => s.id === id) ?? SCENARIOS[0];
  const engine = new SimulationEngine(scenario.config);
  engine.burst(scenario.count, scenario.input);
  return engine;
}
