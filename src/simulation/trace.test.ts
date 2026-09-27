import { describe, expect, it } from 'vitest';
import { parseTrace, traceToScenario, TraceParseError } from './trace';
import { fromOpenAICompatible, convertMiniVllmLogs, MINI_VLLM_FIELD_MAP } from './trace-adapters';
import { runScenario, runMultiSeed, type ScenarioFile } from './experiment';

const goodJsonl = `{"timestamp_ms": 0, "prompt_tokens": 256, "output_tokens": 64, "priority": 1, "prefix_group": "chat", "observed_ttft_ms": 210, "observed_tpot_ms": 18.5}
{"timestamp_ms": 500, "prompt_tokens": 512, "output_tokens": 32, "priority": 2}
{"timestamp_ms": 1500, "prompt_tokens": 128, "output_tokens": 8}`;

describe('Trace import (JSONL/JSON)', () => {
  it('parses JSONL with priorities, prefix groups and observed metrics', () => {
    const r = parseTrace(goodJsonl);
    expect(r.format).toBe('jsonl');
    expect(r.requests).toHaveLength(3);
    expect(r.requests[0].atMs).toBe(0);
    expect(r.requests[0].input.priority).toBe('normal');
    expect(r.requests[0].input.prefix).toBe('chat');
    expect(r.requests[0].observed?.ttftMs).toBe(210);
    expect(r.requests[2].observed).toBeUndefined();
  });

  it('sorts out-of-order timestamps deterministically', () => {
    const r = parseTrace([
      '{"timestamp_ms": 900, "prompt_tokens": 10, "output_tokens": 5}',
      '{"timestamp_ms": 100, "prompt_tokens": 10, "output_tokens": 5}',
    ].join('\n'));
    expect(r.requests.map(q => q.atMs)).toEqual([100, 900]);
  });

  it('parses JSON arrays and reports every problem with line numbers', () => {
    const r = parseTrace(JSON.stringify([
      { timestamp_ms: 0, prompt_tokens: 64, output_tokens: 8 },
      { timestamp_ms: 10, prompt_tokens: 64, output_tokens: 8 },
    ]));
    expect(r.format).toBe('json');
    expect(r.requests).toHaveLength(2);
  });

  it('collects all validation problems instead of failing on the first', () => {
    const bad = [
      '{"timestamp_ms": -5, "prompt_tokens": 0, "output_tokens": 8}',
      'not json at all',
      '{"prompt_tokens": 64}',
    ].join('\n');
    try {
      parseTrace(bad);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TraceParseError);
      const problems = (e as TraceParseError).problems;
      expect(problems.some(p => p.includes('line 1') && p.includes('timestamp_ms'))).toBe(true);
      expect(problems.some(p => p.includes('line 2') && p.includes('invalid JSON'))).toBe(true);
      expect(problems.some(p => p.includes('line 3') && p.includes('output_tokens'))).toBe(true);
    }
  });

  it('replays a trace deterministically and preserves observed fields', () => {
    const scenario = traceToScenario(parseTrace(goodJsonl), { name: 'trace-unit', maxSimMs: 40000 });
    expect(scenario.traffic?.arrival).toBe('trace');
    const a = runScenario(scenario, { includeObservations: true });
    const b = runScenario(scenario, { includeObservations: true });
    expect(a.summary.completed).toBe(3);
    expect(a.fingerprint.resultHash).toBe(b.fingerprint.resultHash);
    const withObserved = (a.observations as Array<{ observed: { ttftMs?: number } | null }>)
      .filter(o => o.observed?.ttftMs !== undefined);
    expect(withObserved).toHaveLength(1);
  });
});

describe('Trace adapters', () => {
  it('maps OpenAI-compatible request logs onto the generic format', () => {
    const result = fromOpenAICompatible([
      { created: 10, usage: { prompt_tokens: 128, completion_tokens: 32 }, observed_ttft_ms: 95 },
      { created_ms: 10500, prompt_tokens: 64, completion_tokens: 16, prefix_group: 'sys-a' },
      { created_ms: 11000 }, // missing token counts -> problem, not a silent drop
    ]);
    expect(result.records).toHaveLength(2);
    expect(result.records[0].timestamp_ms).toBe(10000); // seconds -> ms
    expect(result.records[0].observed_ttft_ms).toBe(95);
    expect(result.records[1].prefix_group).toBe('sys-a');
    expect(result.problems.some(p => p.includes('record 3'))).toBe(true);
  });

  it('refuses to invent a mini-vllm schema', () => {
    expect(MINI_VLLM_FIELD_MAP.timestamp_ms).toBeNull();
    expect(() => convertMiniVllmLogs([{}])).toThrow(/not configured/);
  });
});

describe('Scenario schema validation', () => {
  it('reports precise problems instead of silent fallback', () => {
    const file = {
      version: 1,
      config: { gpuCount: 99, schedulerPolicy: 'random', bogusSetting: 1, kvWatermark: 3 },
      traffic: { arrival: 'sometimes', rate: -2 },
      sweep: [{ path: 'nope', values: [1] }],
    } as unknown as ScenarioFile;
    const problems = (() => {
      try {
        runScenario(file);
        return [];
      } catch (e) {
        return String((e as Error).message).split('\n');
      }
    })();
    expect(problems.join('\n')).toMatch(/gpuCount must be within/);
    expect(problems.join('\n')).toMatch(/schedulerPolicy must be/);
    expect(problems.join('\n')).toMatch(/bogusSetting is not a known engine setting/);
    expect(problems.join('\n')).toMatch(/kvWatermark must be within/);
    expect(problems.join('\n')).toMatch(/traffic\.arrival must be/);
    expect(problems.join('\n')).toMatch(/traffic\.rate must be a positive number/);
    expect(problems.join('\n')).toMatch(/sweep\[0\]\.path/);
  });
});

describe('Multi-seed experiments', () => {
  const base: ScenarioFile = {
    version: 1,
    name: 'multi-seed-unit',
    config: { gpuCount: 2, numBlocks: 128 },
    traffic: {
      enabled: true, arrival: 'poisson', rate: 3,
      prompt: { kind: 'uniform', min: 128, max: 512 },
      output: { kind: 'uniform', min: 32, max: 96 },
      prefix: 'chat', prefixReuseProbability: 0.8,
    },
    maxSimMs: 12000,
  };

  it('aggregates key metrics with mean/median/min/max/stddev over paired seeds', () => {
    const ms = runMultiSeed(base, [1, 2, 3]);
    expect(ms.paired).toBe(true);
    expect(ms.perSeed.map(r => r.seed)).toEqual([1, 2, 3]);
    const ttft = ms.aggregate.find(a => a.key === 'ttftP99')!;
    expect(ttft.min).toBeLessThanOrEqual(ttft.median);
    expect(ttft.median).toBeLessThanOrEqual(ttft.max);
    expect(ttft.stddev).toBeGreaterThanOrEqual(0);
  });
});
