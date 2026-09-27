import { describe, expect, it } from 'vitest';
import { replayIdentical, runScenario, runSweep, type ScenarioFile } from './experiment';

const baseFile: ScenarioFile = {
  version: 1,
  name: 'unit-base',
  seed: 73,
  config: { gpuCount: 2, maxBatchSize: 4, numBlocks: 128 },
  traffic: {
    enabled: true,
    arrival: 'constant',
    rate: 2,
    prompt: { kind: 'fixed', value: 256 },
    output: { kind: 'fixed', value: 64 },
    prefix: 'chat',
  },
  maxSimMs: 20000,
};

describe('Experiment runner', () => {
  it('runs a scenario headlessly and reports the full metric set', () => {
    const r = runScenario(baseFile);
    expect(r.engineVersion).toBe(2);
    expect(r.drained).toBe(false); // constant traffic never drains
    expect(r.summary.completed).toBeGreaterThan(0);
    expect(r.summary.ttftP99).not.toBeNull();
    expect(r.summary.sloAttainment).toBeGreaterThanOrEqual(0);
    expect(r.counters.outputTokens).toBeGreaterThan(0);
  });

  it('replays a scenario byte-identically for the same seed', () => {
    const a = runScenario(baseFile);
    const b = runScenario(baseFile);
    expect(replayIdentical(a, b)).toBe(true);
    expect(JSON.stringify(a.summary)).toBe(JSON.stringify(b.summary));
  });

  it('a different seed produces a different stream', () => {
    const varied: ScenarioFile = {
      ...baseFile,
      traffic: {
        ...baseFile.traffic,
        prompt: { kind: 'uniform', min: 128, max: 512 },
        output: { kind: 'uniform', min: 16, max: 64 },
        priorityMix: { low: 1, normal: 1, high: 1 },
      } as typeof baseFile.traffic,
    };
    const a = runScenario(varied);
    const b = runScenario({ ...varied, seed: 74 });
    expect(replayIdentical(a, b)).toBe(false);
  });

  it('sweeps a scheduler parameter and yields one result per value', () => {
    const file: ScenarioFile = {
      ...baseFile,
      name: 'sweep-budget',
      sweep: [{ path: 'config.maxNumBatchedTokens', values: [32, 64, 128] }],
    };
    const results = runSweep(file);
    expect(results).toHaveLength(3);
    expect(results.map(r => r.config.maxNumBatchedTokens as number)).toEqual([32, 64, 128]);
    // Determinism per combination.
    expect(replayIdentical(results[0], runScenario({ ...baseFile, name: 'sweep-budget', sweep: [{ path: 'config.maxNumBatchedTokens', values: [32] }] }))).toBe(true);
  });

  it('sweeps the P/D ratio across disaggregated topologies', () => {
    const file: ScenarioFile = {
      version: 1,
      name: 'pd-sweep',
      seed: 5,
      config: { servingMode: 'disaggregated', gpuCount: 8, numBlocks: 128, prefillGpuCount: 4, decodeGpuCount: 4 },
      traffic: { enabled: false, requests: [] },
      maxSimMs: 60000,
      sweep: [{ path: 'config.prefillGpuCount', values: [2, 4, 6] }],
    };
    // Seed burst: enqueue directly by treating the traffic as a trace at t=0.
    file.traffic = {
      enabled: true,
      arrival: 'trace',
      requests: Array.from({ length: 10 }, (_, i) => ({
        atMs: i * 50,
        input: { promptTokens: 512, outputTokens: 64, prefix: 'chat' },
      })),
    };
    const results = runSweep(file);
    expect(results).toHaveLength(3);
    for (const r of results) {
      expect((r.config.prefillGpuCount as number) + (r.config.decodeGpuCount as number)).toBe(8);
      expect(r.summary.completed).toBeGreaterThan(0);
    }
  });

  it('replays a trace workload deterministically', () => {
    const file: ScenarioFile = {
      version: 1,
      name: 'trace-replay',
      seed: 9,
      config: { gpuCount: 1 },
      traffic: {
        enabled: true,
        arrival: 'trace',
        requests: [
          { atMs: 0, input: { promptTokens: 256, outputTokens: 32, prefix: 'chat' } },
          { atMs: 500, input: { promptTokens: 512, outputTokens: 16, prefix: 'chat', priority: 'high' } },
          { atMs: 1200, input: { promptTokens: 128, outputTokens: 8, prefix: 'none' } },
        ],
      },
      maxSimMs: 30000,
    };
    const a = runScenario(file, { includeObservations: true });
    const b = runScenario(file, { includeObservations: true });
    expect(a.drained).toBe(true);
    expect(a.summary.completed).toBe(3);
    expect(a.observations).toEqual(b.observations);
    expect(replayIdentical(a, b)).toBe(true);
  });

  it('rejects unsupported scenario versions', () => {
    expect(() => runScenario({ version: 99 as never })).toThrow(/version/i);
  });
});
