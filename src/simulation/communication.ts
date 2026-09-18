import type { BatchCost, Config } from './types';

/** Illustrative effective links, not measurements of a particular accelerator. */
export const INTERCONNECTS = {
  pcie: { bandwidthGBps: 32, latencyUs: 50 },
  nvlink: { bandwidthGBps: 300, latencyUs: 5 },
};
export function batchCost(config: Config, prefillTokens: number, decodeSequences: number, context: number, speculative: boolean, decodePositions = decodeSequences * (speculative ? 5 : 1)): BatchCost {
  const tp = config.tensorParallel;
  const link = config.interconnect === 'custom' ? config : INTERCONNECTS[config.interconnect];
  // Effective whole-model compute; the four stages aggregate 32 illustrative layers.
  const verificationWidth = decodeSequences ? Math.max(0, Math.min(1, (decodePositions / decodeSequences - 1) / 4)) : 0;
  const computeMs = (prefillTokens * 0.03 + (decodeSequences ? (36 + context / 128 + decodeSequences * 2) * (1 + 0.65 * verificationWidth) : 0)) / tp;
  const positions = prefillTokens + decodePositions;
  const activationBytes = positions * 4096 * 2 * 32; // tokens × hidden width × FP16 bytes × layers
  const bytesPerCollectivePerRank = tp > 1 ? 2 * (tp - 1) / tp * activationBytes : 0;
  const collectiveMs = tp > 1 && positions ? bytesPerCollectivePerRank / (link.bandwidthGBps * 1e6)
    + 2 * (tp - 1) * 32 * link.latencyUs / 1000 : 0;
  const communicationMs = 2 * collectiveMs;
  return {
    computeMs, communicationMs, totalMs: computeMs + communicationMs,
    collectiveBytes: bytesPerCollectivePerRank * 2 * tp, // aggregate transmitted bytes across ranks
    stages: [
      { name: 'Attention projection', kind: 'compute', ms: computeMs * 0.35 },
      { name: 'AllReduce', kind: 'communication', ms: collectiveMs },
      { name: 'MLP', kind: 'compute', ms: computeMs * 0.65 },
      { name: 'AllReduce', kind: 'communication', ms: collectiveMs },
    ],
  };
}

/** Integrate only the executed slice of each stage, without counting rank time repeatedly. */
export function stageSlice(cost: BatchCost, from: number, to: number) {
  let offset = 0, computeMs = 0, communicationMs = 0;
  for (const stage of cost.stages) {
    const overlap = Math.max(0, Math.min(to, offset + stage.ms) - Math.max(from, offset));
    if (stage.kind === 'compute') computeMs += overlap; else communicationMs += overlap;
    offset += stage.ms;
  }
  return { computeMs, communicationMs };
}
